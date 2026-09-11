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
  getCustomerOrders,
  getMostRecentRealOrderForCustomer,
  getProducts,
  isProductionId,
} from "@/api/inbox";
import {
  buildSmartActionSuggestion,
  filterSmartActionSuggestion,
  toPrepareOrderItems,
  toRepeatOrderItems,
  type PrepareOrderItemInput,
  type SmartActionId,
} from "@/lib/conversation/smart-actions";
import { useCapabilities } from "@/hooks/use-capabilities";
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

function ConversationScreen() {
  const { id } = Route.useParams();
  const activeIdRef = useRef(id);
  activeIdRef.current = id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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
  const [appended, setAppended] = useState<Message[]>([]);
  const [status, setStatus] = useState<ConversationStatus | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [lastOrder, setLastOrder] = useState<Order | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [prepareOpen, setPrepareOpen] = useState(false);
  const [prepareItems, setPrepareItems] = useState<PrepareOrderItemInput[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  const conversationQuery = useQuery({
    queryKey: ["conversation", id],
    queryFn: () => getConversation(id),
  });
  const conversation = conversationQuery.data;

  const customerQuery = useQuery({
    queryKey: ["customer", conversation?.customerId],
    queryFn: () => getCustomer(conversation!.customerId),
    enabled: Boolean(conversation?.customerId),
  });
  const customer = customerQuery.data;
  const displayName = customer
    ? localName(customer, language)
    : (conversation?.customerName ?? t("conversation.unresolvedCustomer"));

  // Catalog for Smart Action variant resolution (§ PRODUCT / VARIANT
  // RESOLUTION) and for the Prepare Order review step. Same production/mock
  // branching as everywhere else — see getProducts()'s own comment.
  const productsQuery = useQuery({
    queryKey: ["conversation-smart-action-products"],
    queryFn: getProducts,
  });
  const products = productsQuery.data ?? [];

  const messages = [
    ...new Map(
      [...olderMessages, ...(conversation?.messages ?? []), ...appended].map((message) => [
        message.id,
        message,
      ]),
    ).values(),
  ];
  const currentStatus = status ?? conversation?.status ?? "needs_reply";

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
  const suggestion = useMemo(
    () => filterSmartActionSuggestion(rawSuggestion, capabilities),
    [rawSuggestion, capabilities],
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
  }, [id]);

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
          void queryClient.invalidateQueries({ queryKey: ["conversations"] });
          void queryClient.invalidateQueries({ queryKey: ["conversation-counts"] });
        }
      })
      .catch(() => {
        if (active) setOperationError(true);
      });
    return () => {
      active = false;
    };
  }, [id, conversation?.readThroughMessageId, queryClient]);

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
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
        void queryClient.invalidateQueries({ queryKey: ["conversation-counts"] });
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
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["conversation-counts"] });
    } catch {
      setOperationError(true);
    } finally {
      setSavingStatus(false);
    }
  }

  function append(message: Message) {
    setAppended((list) => [...list, message]);
  }

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
        const previous = isProductionId(customer.id)
          ? await getMostRecentRealOrderForCustomer(customer.id)
          : ((await getCustomerOrders(customer.id))[0] ?? null);
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
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
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
        ) : isProductionId(id) ? (
          <p className="text-caption px-4 pt-2 text-text-secondary">
            {t("conversation.providerPending")}
          </p>
        ) : null}

        <form
          className="flex items-end gap-1.5 px-3 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            send(draft);
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
            disabled={!canReply || isProductionId(id) || draft.trim().length === 0}
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
            description={t("conversation.actions.savedRepliesBody")}
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
        />
      ) : null}

      {customer && conversation ? (
        <CreateOrderSheet
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
          onConfirmed={(order) => setLastOrder(order)}
        />
      ) : null}
    </div>
  );
}
