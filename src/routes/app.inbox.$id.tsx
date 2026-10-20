import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ImagePlus,
  MessageSquareQuote,
  Plus,
  Send,
  ShoppingBag,
  Truck,
  UserRound,
  Wallet,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ActionRow,
  BottomSheet,
  ChannelBadge,
  EmptyState,
  ErrorState,
  ListSkeleton,
  MessageBubble,
  StatusChip,
} from "@/design-system";
import { CreateOrderSheet } from "@/components/inbox/CreateOrderSheet";
import { CustomerDetailSheet } from "@/components/inbox/CustomerDetailSheet";
import { PrepareOrderSheet } from "@/components/inbox/PrepareOrderSheet";
import { SmartActionStrip } from "@/components/inbox/SmartActionStrip";
import {
  getConversation,
  getOlderConversationMessages,
  markRealConversationRead,
  updateRealConversationStatus,
  getCustomer,
  getMostRecentRealOrderForCustomer,
  getProducts,
  isProductionId,
  REPLYABLE_CHANNELS,
  sendRealConversationReply,
} from "@/api/inbox";
import {
  buildSmartActionSuggestion,
  filterSmartActionSuggestion,
  filterUnsendableSmartActions,
  toPrepareOrderItems,
  toRepeatOrderItems,
  type PrepareOrderItemInput,
  type SmartActionId,
} from "@/lib/conversation/smart-actions";
import { classifyReplyError, type ReplyErrorKind } from "@/lib/conversation/reply-errors";
import {
  hasUnresolvedOutbound,
  reconcileThreadMessages,
  replyCompletion,
  sameScope,
  type AppendedMessage,
  type OperationScope,
} from "@/lib/conversation/reply-session";
import { useCapabilities } from "@/hooks/use-capabilities";
import { customerKeys } from "@/lib/customers-query";
import { conversationKeys } from "@/lib/inbox-query";
import { catalogKeys } from "@/lib/catalog";
import { HOME_QUERY_PREFIX } from "@/lib/home-query";
import { ordersKeys } from "@/lib/orders-query";
import { inventoryKeys } from "@/lib/inventory";
import { initials, localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { CompanionColor, ConversationStatus, Message, Order } from "@/types";

export const Route = createFileRoute("/app/inbox/$id")({
  head: () => ({
    meta: [
      { title: "Conversation — APSA" },
      {
        name: "description",
        content:
          "Read the thread, reply, and turn a message into an order without leaving the conversation.",
      },
      { property: "og:title", content: "Conversation — APSA" },
      {
        property: "og:description",
        content: "One thread, one customer, one tap to create the order.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ConversationScreen,
});

const COMPANION_VAR: Record<CompanionColor, string> = {
  nilo: "var(--companion-nilo)",
  minto: "var(--companion-minto)",
  vela: "var(--companion-vela)",
  suri: "var(--companion-suri)",
  luma: "var(--companion-luma)",
};

const STATUSES: ConversationStatus[] = [
  "unread",
  "needs_reply",
  "follow_up",
  "waiting_customer",
  "order_created",
  "closed",
];

const SAVED_REPLY_KEYS = ["greeting", "price", "stock", "delivery"] as const;

/** A staff reply's stored key: 'apsa:<the composer's client uuid>' (migration 064). */
const REPLY_KEY_RE = /^apsa:([0-9a-f-]{36})$/;

/** While a reply shows "sending", re-read the thread so a stuck one turns failed (server: 2 minutes). */
const SENDING_REFETCH_MS = 30_000;

/** Provider media the thread labels (the file itself is not fetched yet). */
const MEDIA_TYPES: ReadonlySet<string> = new Set(["image", "video", "audio", "file"]);

function ConversationScreen() {
  const { id } = Route.useParams();
  /*
   * Cache identity for this thread, its customer and the catalog it resolves
   * Smart Actions against. Both values come from the /app route guard's
   * server-derived context (validated session + active membership row), never
   * from the URL or the capability snapshot. A conversation id in the URL is
   * not an identity: without the principal in the key, the thread body,
   * message previews and the customer profile behind it stayed readable to
   * whoever mounted this route next in the same tab.
   */
  const { session, organizationId: routeOrganizationId } = Route.useRouteContext();
  const userId = session.userId;
  const activeIdRef = useRef(id);
  activeIdRef.current = id;
  /*
   * Who/where this screen is NOW. A send or retry captures it when it starts
   * and applies its result only if member, organization, conversation and
   * screen epoch are unchanged (sameScope): a reply started as member A in
   * thread X never lands in member B's view, in thread Y, or in a later visit
   * to X whose state it does not know.
   */
  const scopeKey = `${userId}\u0000${routeOrganizationId}\u0000${id}`;
  const epochRef = useRef({ key: scopeKey, operation: 0 });
  if (epochRef.current.key !== scopeKey) {
    epochRef.current = { key: scopeKey, operation: epochRef.current.operation + 1 };
  }
  const scopeRef = useRef<OperationScope>({
    userId,
    organizationId: routeOrganizationId,
    conversationId: id,
    operation: epochRef.current.operation,
  });
  scopeRef.current = {
    userId,
    organizationId: routeOrganizationId,
    conversationId: id,
    operation: epochRef.current.operation,
  };
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  /**
   * An order created (or confirmed) from a conversation is real merchant
   * state the same way a POS sale is — without this, the Orders list and
   * Home kept serving their pre-order cache until it naturally expired,
   * even though the order already existed on the server (see PosCheckoutSheet's
   * invalidateAfterSale for the equivalent POS-side fix).
   */
  function invalidateAfterOrderCreated() {
    void queryClient.invalidateQueries({
      queryKey: ordersKeys.principal(userId, routeOrganizationId),
    });
    void queryClient.invalidateQueries({ queryKey: HOME_QUERY_PREFIX });
    // Confirming (and cancel-to-edit) writes stock movements server-side.
    void queryClient.invalidateQueries({
      queryKey: inventoryKeys.principal(userId, routeOrganizationId),
    });
    // The conversation's customer now has one more order: their order
    // history (customer detail and CustomerDetailSheet) must not serve the
    // pre-order list. This principal's customer partition only.
    void queryClient.invalidateQueries({
      queryKey: customerKeys.principal(userId, routeOrganizationId),
    });
  }

  const [operationError, setOperationError] = useState(false);
  const [olderMessages, setOlderMessages] = useState<Message[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);
  const { t } = useTranslation();
  const { language } = useLanguage();
  const capabilities = useCapabilities();
  /*
   * The three things this screen can start, keyed to the permission each one
   * needs server-side: replying (messages.reply), turning the thread into an
   * order (orders.create), and opening the customer record (customers.read).
   * Every one of them is authorized again by the server when it is invoked.
   */
  const canReply = capabilities.can("messages.reply");
  const canCreateOrder = capabilities.can("orders.create");
  const canViewCustomer = capabilities.can("customers.read");

  const [draft, setDraft] = useState("");
  const [appended, setAppended] = useState<AppendedMessage[]>([]);
  /** The composer text now — a finished send compares against it, never a stale closure. */
  const draftRef = useRef("");
  draftRef.current = draft;
  /** Whether the thread shows a reply still 'sending' (server thread or appended). */
  const unresolvedRef = useRef(false);
  const [status, setStatus] = useState<ConversationStatus | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [lastOrder, setLastOrder] = useState<Order | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [prepareOpen, setPrepareOpen] = useState(false);
  const [prepareItems, setPrepareItems] = useState<PrepareOrderItemInput[]>([]);
  const [sendingReply, setSendingReply] = useState(false);
  const [replyError, setReplyError] = useState<ReplyErrorKind | null>(null);
  /*
   * The identity of the reply being sent. A retry of the SAME text in the
   * same thread, by the same member, reuses its key, so the server never
   * sends it twice (migration 064 begin_outbound_message); any other text,
   * thread or principal starts a new submission.
   */
  const replyAttemptRef = useRef<{ scope: string; body: string; key: string } | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const conversationQuery = useQuery({
    queryKey: conversationKeys.detail(userId, routeOrganizationId, id),
    queryFn: () => getConversation(id),
    refetchInterval: (query) =>
      isProductionId(id) &&
      (unresolvedRef.current || hasUnresolvedOutbound(query.state.data?.messages ?? []))
        ? SENDING_REFETCH_MS
        : false,
  });
  const conversation = conversationQuery.data;

  const customerQuery = useQuery({
    /*
     * The customer profile behind this thread — a phone number, social
     * identities and an address, depending on what the server decided this
     * member may see. It shares the Customer domain's partition with Customer
     * 360 rather than holding a second, differently-keyed copy of the same
     * payload, so one purge covers both.
     */
    queryKey: customerKeys.detail(userId, routeOrganizationId, conversation?.customerId ?? "none"),
    queryFn: () => getCustomer(conversation!.customerId),
    enabled: Boolean(conversation?.customerId) && canViewCustomer,
  });
  const customer = customerQuery.data;
  const displayName = customer
    ? localName(customer, language)
    : (conversation?.customerName ?? t("conversation.unresolvedCustomer"));

  // Catalog for Smart Action variant resolution (§ PRODUCT / VARIANT
  // RESOLUTION) and for the Prepare Order review step. Same production/mock
  // branching as everywhere else — see getProducts()'s own comment.
  const productsQuery = useQuery({
    queryKey: catalogKeys.uiProducts(userId, routeOrganizationId, "smart-action"),
    queryFn: getProducts,
  });
  const products = productsQuery.data ?? [];

  // A refreshed server row replaces an older appended send result, so a
  // sweep's failure (and its Retry) shows without a remount.
  const messages = reconcileThreadMessages(
    olderMessages,
    conversation?.messages ?? [],
    conversationQuery.dataUpdatedAt,
    appended,
  );
  unresolvedRef.current = isProductionId(id) && hasUnresolvedOutbound(messages);
  const currentStatus = status ?? conversation?.status ?? "needs_reply";

  /*
   * Whether this thread's channel can be answered from APSA today (Telegram).
   * Presentation only: the server refuses a reply into a conversation with no
   * live connection, whatever this says.
   */
  const replyAvailable =
    !isProductionId(id) ||
    (conversation !== undefined && REPLYABLE_CHANNELS.has(conversation.channel));

  // Deterministic, client-side only — never a security decision (§
  // SECURITY / TENANT ISOLATION: "intent/suggestion layer is never
  // security-authoritative"). Every action it names still goes through the
  // same server-authoritative path a manual tap would.
  const rawSuggestion = useMemo(
    () =>
      buildSmartActionSuggestion({
        messages: messages.map((message) => ({
          body: message.body,
          direction: message.direction,
          at: message.at,
        })),
        hasCustomer: Boolean(customer),
        products,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages.length, customer, products],
  );

  // Suggestions this member cannot carry out are dropped before they reach the
  // strip. The engine still runs the same way — only the offer narrows.
  //
  // Reply-only actions ("Check stock", "Send price", …) are then dropped too
  // on a production conversation whose channel cannot be answered from APSA
  // yet (every channel but Telegram — the composer disables its own submit
  // for the same reason): a chip that only fills the composer with no way to
  // send it promises something the screen cannot deliver.
  const suggestion = useMemo(
    () =>
      filterUnsendableSmartActions(
        filterSmartActionSuggestion(rawSuggestion, capabilities),
        replyAvailable,
      ),
    [rawSuggestion, capabilities, replyAvailable],
  );

  useEffect(() => {
    setAppended([]);
    setOlderMessages([]);
    setOlderCursor(undefined);
    setOperationError(false);
    setStatus(null);
    setDraft("");
    setLastOrder(null);
    setActionsOpen(false);
    setReplyError(null);
    setSendingReply(false);
    setRetryingId(null);
    replyAttemptRef.current = null;
    // A new member, organization or thread starts from a clean composer.
  }, [id, userId, routeOrganizationId]);

  /*
   * An order draft belongs to ONE conversation's customer, for ONE member of
   * ONE organization. This route stays mounted across conversations, so the
   * order sheets are keyed to that scope (a switch remounts them, discarding
   * the draft and dropping any response still in flight — see
   * PrepareOrderSheet's "Attempt identity") and closed on a switch, so the
   * previous customer's lines can never be submitted for the next one.
   */
  const orderScope = `${userId}\u0000${routeOrganizationId}\u0000${id}`;
  useEffect(() => {
    setOrderOpen(false);
    setPrepareOpen(false);
    setPrepareItems([]);
  }, [orderScope]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  useEffect(() => {
    const messageId = conversation?.readThroughMessageId;
    if (!isProductionId(id) || !messageId) return;
    let active = true;
    void markRealConversationRead(id, messageId)
      .then(() => {
        if (active) {
          void queryClient.invalidateQueries({
            queryKey: conversationKeys.principal(userId, routeOrganizationId),
          });
        }
      })
      .catch(() => {
        if (active) setOperationError(true);
      });
    return () => {
      active = false;
    };
    // The principal is in the deps because it is in the invalidation key: if
    // the active membership changed under this screen, the mark-read that
    // follows must refresh the NEW principal's Inbox, never the old one's.
  }, [id, conversation?.readThroughMessageId, queryClient, userId, routeOrganizationId]);

  async function loadOlder() {
    const cursor = olderCursor === undefined ? conversation?.nextBeforeId : olderCursor;
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await getOlderConversationMessages(id, cursor);
      if (activeIdRef.current !== id) return;
      setOlderMessages((rows) => [...page.messages, ...rows]);
      setOlderCursor(page.nextBeforeId);
      if (page.readThroughMessageId) {
        await markRealConversationRead(id, page.readThroughMessageId);
        void queryClient.invalidateQueries({
          queryKey: conversationKeys.principal(userId, routeOrganizationId),
        });
      }
    } catch {
      setOperationError(true);
    } finally {
      setLoadingOlder(false);
    }
  }

  async function changeStatus(value: ConversationStatus) {
    if (savingStatus) return;
    setSavingStatus(true);
    try {
      if (isProductionId(id)) await updateRealConversationStatus(id, value);
      if (activeIdRef.current !== id) return;
      setStatus(value);
      setStatusOpen(false);
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.principal(userId, routeOrganizationId),
      });
    } catch {
      setOperationError(true);
    } finally {
      setSavingStatus(false);
    }
  }

  function append(message: Message) {
    setAppended((list) => [...list, { message, receivedAt: Date.now() }]);
  }

  /*
   * Production saved replies and Smart Actions only fill the composer: the
   * merchant reads what will go to the customer, then taps Send.
   */
  function send(body: string) {
    if (isProductionId(id)) {
      setDraft(body);
      return;
    }
    const text = body.trim();
    if (!text) return;
    append({
      id: `local-${Date.now()}`,
      direction: "outbound",
      body: text,
      at: new Date().toISOString(),
      state: "sent",
    });
    setDraft("");
  }

  async function deliverReply(raw: string) {
    const body = raw.trim();
    if (!body || sendingReply || !replyAvailable || !canReply) return;
    const started = scopeRef.current;
    const scope = `${started.userId}\u0000${started.organizationId}\u0000${started.conversationId}`;
    const previous = replyAttemptRef.current;
    const key =
      previous && previous.scope === scope && previous.body === body
        ? previous.key
        : crypto.randomUUID();
    replyAttemptRef.current = { scope, body, key };
    setSendingReply(true);
    setReplyError(null);
    try {
      const result = await sendRealConversationReply({
        conversationId: started.conversationId,
        clientMessageId: key,
        body,
        expectedPrincipal: { userId: started.userId, organizationId: started.organizationId },
      });
      if (!sameScope(started, scopeRef.current)) return;
      append(result.message);
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.principal(started.userId, started.organizationId),
      });
      if (result.deliveryError) setReplyError(classifyReplyError(result.deliveryError));
      // Only a terminal 'sent' of THIS key resolves it; a newer draft or key
      // is never discarded, and a replay still 'sending' keeps its key so the
      // next tap reuses it.
      const effects = replyCompletion({
        submittedBody: body,
        currentDraft: draftRef.current,
        key,
        currentKey: replyAttemptRef.current?.key ?? null,
        resultState: result.message.state,
        failed: Boolean(result.deliveryError),
      });
      if (effects.clearKey) replyAttemptRef.current = null;
      if (effects.clearDraft) setDraft("");
    } catch (error) {
      if (!sameScope(started, scopeRef.current)) return;
      setReplyError(classifyReplyError(error));
    } finally {
      if (sameScope(started, scopeRef.current)) setSendingReply(false);
    }
  }

  /*
   * Retry a failed reply from its own bubble, under the key it was first sent
   * with: the server re-sends only a 'failed' row, never a 'sending' or
   * 'sent' one (begin_outbound_message).
   */
  async function retryReply(message: Message) {
    const key = REPLY_KEY_RE.exec(message.providerMessageId ?? "")?.[1];
    if (!key || retryingId || sendingReply || !canReply) return;
    const started = scopeRef.current;
    setRetryingId(message.id);
    setReplyError(null);
    try {
      const result = await sendRealConversationReply({
        conversationId: started.conversationId,
        clientMessageId: key,
        body: message.body,
        expectedPrincipal: { userId: started.userId, organizationId: started.organizationId },
      });
      if (!sameScope(started, scopeRef.current)) return;
      append(result.message);
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.principal(started.userId, started.organizationId),
      });
      const effects = replyCompletion({
        submittedBody: message.body,
        currentDraft: draftRef.current,
        key,
        currentKey: replyAttemptRef.current?.key ?? null,
        resultState: result.message.state,
        failed: Boolean(result.deliveryError),
      });
      if (effects.clearKey) replyAttemptRef.current = null;
      if (effects.clearDraft) setDraft("");
    } catch (error) {
      if (!sameScope(started, scopeRef.current)) return;
      setReplyError(classifyReplyError(error));
    } finally {
      if (sameScope(started, scopeRef.current)) setRetryingId(null);
    }
  }

  /**
   * The one place the chat→order flow starts, wherever it is triggered from.
   * Production threads go through Prepare Order (a review step the merchant
   * confirms); the mock path keeps its own sheet. Neither creates anything on
   * its own — the merchant still taps Create Draft / Confirm.
   */
  function startOrder() {
    setActionsOpen(false);
    if (isProductionId(id)) {
      setPrepareItems([]);
      setPrepareOpen(true);
      return;
    }
    setOrderOpen(true);
  }

  /**
   * Smart Action dispatch. Every branch either (a) opens the Prepare Order
   * review step — never a direct order, the merchant always taps Create Draft
   * / Confirm themselves — or (b) sends a short composer message, exactly as
   * if the merchant had typed it, or (c) opens an existing, already-secure
   * surface (Customer detail). Nothing here creates, confirms, or pays for
   * anything on its own.
   */
  async function handleSmartAction(action: SmartActionId) {
    switch (action) {
      case "prepare_order": {
        setPrepareItems(toPrepareOrderItems(suggestion.items, products));
        setPrepareOpen(true);
        return;
      }
      case "repeat_order": {
        if (!customer) return;
        // §9 negative example note: "location ដដែល" is filtered out of
        // repeat-purchase detection upstream (src/lib/intent/detect.ts), so
        // reaching here means the engine is confident this is a product
        // repeat, not an address repeat.
        /*
         * Production order history only. The old else-branch read the
         * in-memory `orders` fixture through getCustomerOrders(), so a
         * "Repeat order" on a customer whose id was not a production UUID
         * pre-filled the sheet with invented line items. There is no honest
         * fallback for "what did this customer buy last time" — with no real
         * previous order the sheet opens empty and the merchant chooses.
         */
        const previous = isProductionId(customer.id)
          ? await getMostRecentRealOrderForCustomer(customer.id)
          : null;
        setPrepareItems(toRepeatOrderItems(previous?.items ?? [], products));
        setPrepareOpen(true);
        return;
      }
      case "view_product": {
        setPrepareItems([]);
        setPrepareOpen(true);
        return;
      }
      case "view_customer": {
        setCustomerOpen(true);
        return;
      }
      case "check_stock": {
        send(t("conversation.saved.stock"));
        return;
      }
      case "send_price": {
        send(t("conversation.saved.price"));
        return;
      }
      case "delivery_info": {
        send(t("conversation.saved.delivery"));
        return;
      }
      case "ask_quantity": {
        send(t("conversation.intent.prompts.quantity"));
        return;
      }
      case "ask_variant": {
        send(t("conversation.intent.prompts.variant"));
        return;
      }
      case "ask_address": {
        send(t("conversation.intent.prompts.address"));
        return;
      }
    }
  }

  return (
    <div className="flex h-[100dvh] w-full min-w-0 flex-col bg-surface-primary">
      <header className="glass-bar sticky top-0 z-20 border-b border-[var(--glass-border)]">
        <div className="flex items-center gap-1 px-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] pb-2">
          <button
            type="button"
            aria-label={t("conversation.back")}
            onClick={() => void navigate({ to: "/app/inbox" })}
            className="press-tactile tap-target flex shrink-0 items-center justify-center rounded-full text-text-primary lg:hidden"
          >
            <ArrowLeft className="size-5" aria-hidden />
          </button>

          <button
            type="button"
            onClick={() => setCustomerOpen(true)}
            aria-label={t("conversation.openCustomer")}
            className="press-tactile tap-target flex min-w-0 flex-1 items-center gap-2 rounded-2xl px-1 text-left"
            disabled={!customer}
          >
            <span
              aria-hidden
              className="text-label flex size-9 shrink-0 items-center justify-center rounded-full text-text-inverse"
              style={{ backgroundColor: COMPANION_VAR[customer?.companion ?? "nilo"] }}
            >
              {initials(displayName)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-h3 block truncate text-text-primary">{displayName}</span>
              {conversation ? (
                <span className="flex items-center gap-1">
                  <ChannelBadge channel={conversation.channel} withLabel />
                </span>
              ) : null}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setStatusOpen(true)}
            aria-label={t("conversation.statusLabel")}
            aria-haspopup="dialog"
            className="press-tactile tap-target flex shrink-0 items-center justify-center rounded-full px-1"
          >
            <StatusChip status={currentStatus} />
          </button>
        </div>

        {/*
         * Order context, only once there is an order to talk about. It reads
         * as a status line rather than a control panel, and the whole strip
         * is one target to the order itself — where the money and delivery
         * actions actually live and are actually authorised.
         */}
        {lastOrder ? (
          <button
            type="button"
            onClick={() => void navigate({ to: "/app/orders/$id", params: { id: lastOrder.id } })}
            className="press flex w-full items-center gap-2 border-t border-border-default bg-action-primary-soft/60 px-4 py-2 text-left"
          >
            <span className="text-label tnum shrink-0 text-status-info-text">{lastOrder.code}</span>
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              <StatusChip status={lastOrder.paymentStatus} />
              <StatusChip status={lastOrder.fulfillmentStatus} />
            </span>
            <span className="text-caption shrink-0 text-action-primary">
              {t("conversation.orderActions.view")}
            </span>
          </button>
        ) : null}
      </header>

      <div className="scroll-pane min-h-0 flex-1 bg-surface-page px-4 py-3">
        {conversationQuery.isPending ? <ListSkeleton rows={4} /> : null}

        {conversationQuery.isError ? (
          <ErrorState
            title={t("conversation.error.title")}
            body={t("conversation.error.body")}
            onRetry={() => void conversationQuery.refetch()}
          />
        ) : null}

        {customerQuery.isError ? (
          <ErrorState
            title={t("conversation.customerUnavailable.title")}
            body={t("conversation.customerUnavailable.body")}
            onRetry={() => void customerQuery.refetch()}
          />
        ) : null}

        {conversationQuery.isSuccess && messages.length === 0 ? (
          <EmptyState title={t("conversation.empty.title")} body={t("conversation.empty.body")} />
        ) : null}

        {operationError ? (
          <p
            role="alert"
            className="text-body-sm mb-2 rounded-2xl bg-status-danger-soft px-4 py-2.5 text-status-danger-text"
          >
            {t("conversation.operationFailed")}
          </p>
        ) : null}
        {(olderCursor === undefined ? conversation?.nextBeforeId : olderCursor) ? (
          <div className="flex justify-center pb-2">
            <Button
              variant="outline"
              disabled={loadingOlder}
              onClick={() => void loadOlder()}
              className="press tap-target text-label rounded-full border-border-default bg-surface-primary px-4"
            >
              {loadingOlder ? t("common.loading") : t("conversation.loadEarlier")}
            </Button>
          </div>
        ) : null}
        <div className="space-y-2">
          {messages.flatMap((message) => {
            const bubble = (
              <MessageBubble
                key={message.id}
                message={message}
                attachment={
                  message.messageType && MEDIA_TYPES.has(message.messageType) ? (
                    <span className="text-caption opacity-80">
                      {t(`conversation.media.${message.messageType}`)}
                    </span>
                  ) : undefined
                }
              />
            );
            const retryable =
              isProductionId(id) &&
              message.direction === "outbound" &&
              message.state === "failed" &&
              REPLY_KEY_RE.test(message.providerMessageId ?? "");
            if (!retryable) return [bubble];
            return [
              bubble,
              <div
                key={`${message.id}-failed`}
                className="flex flex-col items-end gap-1 pl-[22%] text-right"
              >
                <p className="text-caption text-status-danger-text">
                  {t(`conversation.replyError.${classifyReplyError(message.sendError ?? "")}`)}
                </p>
                {canReply ? (
                  <button
                    type="button"
                    onClick={() => void retryReply(message)}
                    disabled={retryingId !== null || sendingReply}
                    aria-busy={retryingId === message.id}
                    className="text-caption tap-target rounded-full px-3 font-medium text-action-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action-primary disabled:opacity-40"
                  >
                    {t("conversation.retrySend")}
                  </button>
                ) : null}
              </div>,
            ];
          })}
        </div>
        <div ref={endRef} />
      </div>

      {/*
       * The chat keeps its screen. Business controls are contextual: the
       * Smart Action strip appears only when the engine has something worth
       * suggesting, and everything else lives one tap away behind the
       * composer's action button rather than parked permanently over the
       * thread.
       */}
      <div className="glass-bar border-t border-[var(--glass-border)] pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
        {conversation ? (
          <div className="px-4 pt-2.5">
            <SmartActionStrip
              suggestion={suggestion}
              onAction={(action) => void handleSmartAction(action)}
            />
          </div>
        ) : null}

        {!canReply ? (
          <p
            id="composer-permission-note"
            className="text-caption px-4 pt-2 text-text-secondary"
            role="status"
          >
            {t("capability.actionDenied")}
          </p>
        ) : !replyAvailable ? (
          <p className="text-caption px-4 pt-2 text-text-secondary">
            {t("conversation.providerPending")}
          </p>
        ) : null}

        {replyError ? (
          <p role="alert" className="text-caption px-4 pt-2 text-status-danger-text">
            {t(`conversation.replyError.${replyError}`)}
          </p>
        ) : null}

        <form
          className="flex items-end gap-1.5 px-3 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (isProductionId(id)) void deliverReply(draft);
            else send(draft);
          }}
        >
          <button
            type="button"
            aria-label={t("conversation.actions.title")}
            aria-haspopup="dialog"
            aria-expanded={actionsOpen}
            onClick={() => setActionsOpen(true)}
            className="press-tactile tap-target flex shrink-0 items-center justify-center rounded-full bg-action-primary-soft text-action-primary"
          >
            <Plus className="size-5" aria-hidden />
          </button>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => {
              /*
               * Keyboard-safe composer: once the keyboard has had a beat to
               * open, keep the newest message in view above it instead of
               * letting the thread sit scrolled somewhere upstream.
               */
              window.setTimeout(() => {
                endRef.current?.scrollIntoView({ block: "end" });
              }, 300);
            }}
            enterKeyHint="send"
            disabled={!canReply}
            {...(canReply ? {} : { "aria-describedby": "composer-permission-note" })}
            placeholder={t("conversation.composerPlaceholder")}
            aria-label={t("conversation.composerPlaceholder")}
            className="h-12 min-w-0 flex-1 rounded-full border-border-default bg-surface-primary px-4"
          />
          <button
            type="submit"
            aria-label={t("conversation.send")}
            aria-busy={sendingReply}
            disabled={!canReply || !replyAvailable || sendingReply || draft.trim().length === 0}
            className="press-tactile tap-target flex shrink-0 items-center justify-center rounded-full bg-action-primary px-4 text-text-on-action disabled:opacity-40"
          >
            <Send className="size-5" aria-hidden />
          </button>
        </form>
      </div>

      <BottomSheet
        open={actionsOpen}
        onOpenChange={setActionsOpen}
        title={t("conversation.actions.title")}
        description={t("conversation.actions.description")}
        snap="half"
      >
        <div className="space-y-2">
          {/*
           * Kept visible but disabled when the member lacks orders.create:
           * the row is the one place that teaches "turning a chat into an
           * order is a thing you need access for". Hiding it would just leave
           * a gap they cannot ask about.
           */}
          <ActionRow
            emphasis
            icon={ShoppingBag}
            label={t("conversation.createOrder")}
            description={
              canCreateOrder
                ? t("conversation.actions.createOrderBody")
                : t("capability.actionDenied")
            }
            disabled={!customer || !canCreateOrder}
            onClick={startOrder}
          />
          <ActionRow
            icon={UserRound}
            label={t("conversation.actions.viewCustomer")}
            description={
              canViewCustomer
                ? t("conversation.actions.viewCustomerBody")
                : t("capability.actionDenied")
            }
            disabled={!customer || !canViewCustomer}
            onClick={() => {
              setActionsOpen(false);
              setCustomerOpen(true);
            }}
          />
          <ActionRow
            icon={MessageSquareQuote}
            label={t("conversation.savedReplies")}
            description={
              !canReply
                ? t("capability.actionDenied")
                : !replyAvailable
                  ? t("conversation.providerPending")
                  : t("conversation.actions.savedRepliesBody")
            }
            disabled={!canReply || !replyAvailable}
            onClick={() => {
              setActionsOpen(false);
              setSavedOpen(true);
            }}
          />
          <ActionRow
            icon={ImagePlus}
            label={t("conversation.attachment")}
            description={t("conversation.actions.attachmentBody")}
            disabled
          />
          {lastOrder ? (
            <>
              <ActionRow
                icon={Wallet}
                label={t("conversation.orderActions.payment")}
                description={t("conversation.actions.paymentBody", { code: lastOrder.code })}
                onClick={() => {
                  setActionsOpen(false);
                  void navigate({ to: "/app/orders/$id", params: { id: lastOrder.id } });
                }}
              />
              <ActionRow
                icon={Truck}
                label={t("conversation.orderActions.delivery")}
                description={t("conversation.actions.deliveryBody", { code: lastOrder.code })}
                onClick={() => {
                  setActionsOpen(false);
                  void navigate({ to: "/app/orders/$id", params: { id: lastOrder.id } });
                }}
              />
            </>
          ) : null}
        </div>
      </BottomSheet>

      <BottomSheet
        open={statusOpen}
        onOpenChange={setStatusOpen}
        title={t("conversation.statusLabel")}
        snap="peek"
      >
        <ul className="space-y-2">
          {STATUSES.filter((value) => !isProductionId(id) || value !== "unread").map((value) => (
            <li key={value}>
              <button
                type="button"
                disabled={savingStatus}
                onClick={() => void changeStatus(value)}
                aria-pressed={currentStatus === value}
                className={cn(
                  "tap-target flex w-full items-center rounded-xl border px-4 text-left",
                  currentStatus === value ? "border-action-primary" : "border-border-default",
                )}
              >
                <StatusChip status={value} />
              </button>
            </li>
          ))}
        </ul>
      </BottomSheet>

      <BottomSheet
        open={savedOpen}
        onOpenChange={setSavedOpen}
        title={t("conversation.savedReplies")}
        snap="half"
      >
        <ul className="space-y-2">
          {SAVED_REPLY_KEYS.map((key) => (
            <li key={key}>
              <button
                type="button"
                onClick={() => {
                  send(t(`conversation.saved.${key}`));
                  setSavedOpen(false);
                }}
                className="tap-target text-body w-full rounded-xl border border-border-default px-4 py-3 text-left text-text-primary"
              >
                {t(`conversation.saved.${key}`)}
              </button>
            </li>
          ))}
        </ul>
      </BottomSheet>

      {customer ? (
        <CustomerDetailSheet
          open={customerOpen}
          onOpenChange={setCustomerOpen}
          customer={customer}
          displayName={displayName}
          userId={userId}
          organizationId={routeOrganizationId}
        />
      ) : null}

      {customer && conversation ? (
        <CreateOrderSheet
          key={`create:${orderScope}`}
          open={orderOpen}
          onOpenChange={setOrderOpen}
          customer={customer}
          displayName={displayName}
          channel={conversation.channel}
          onCreated={(order) => {
            append({
              id: `sys-${order.code}`,
              direction: "system",
              body: t("createOrder.created", { code: order.code }),
              at: order.createdAt,
            });
            setStatus("order_created");
            setLastOrder(order);
          }}
        />
      ) : null}

      {customer && conversation ? (
        <PrepareOrderSheet
          key={`prepare:${orderScope}`}
          open={prepareOpen}
          onOpenChange={setPrepareOpen}
          customer={customer}
          displayName={displayName}
          channel={conversation.channel}
          products={products}
          initialItems={prepareItems}
          // Conversation has no production id today (Inbox is not yet
          // productionized — see APSA_BUILD_STATUS.md), so this is always
          // null in practice. Wired now so a real conversation id flows
          // through unchanged once Inbox is productionized, with no change
          // needed here.
          sourceConversationRef={isProductionId(id) ? id : null}
          // The create's replay identity outlives this keyed sheet; it is scoped
          // to exactly the member, organization and conversation it is keyed by.
          replayScope={{ userId, organizationId: routeOrganizationId, conversationId: id }}
          onCreated={(order) => {
            append({
              id: `sys-${order.code}`,
              direction: "system",
              body: t("createOrder.created", { code: order.code }),
              at: order.createdAt,
            });
            setStatus("order_created");
            setLastOrder(order);
            invalidateAfterOrderCreated();
          }}
          onConfirmed={(order) => {
            setLastOrder(order);
            invalidateAfterOrderCreated();
          }}
        />
      ) : null}
    </div>
  );
}
