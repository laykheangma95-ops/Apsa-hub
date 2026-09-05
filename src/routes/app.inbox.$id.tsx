import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ImagePlus, MessageSquareQuote, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
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
  getCustomer,
  getCustomerOrders,
  getMostRecentRealOrderForCustomer,
  getProducts,
  isProductionId,
} from "@/lib/api";
import {
  buildSmartActionSuggestion,
  toPrepareOrderItems,
  toRepeatOrderItems,
  type PrepareOrderItemInput,
  type SmartActionId,
} from "@/lib/conversation/smart-actions";
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
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { language } = useLanguage();

  const [draft, setDraft] = useState("");
  const [appended, setAppended] = useState<Message[]>([]);
  const [status, setStatus] = useState<ConversationStatus | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [lastOrder, setLastOrder] = useState<Order | null>(null);
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
  const displayName = customer ? localName(customer, language) : "…";

  // Catalog for Smart Action variant resolution (§ PRODUCT / VARIANT
  // RESOLUTION) and for the Prepare Order review step. Same production/mock
  // branching as everywhere else — see getProducts()'s own comment.
  const productsQuery = useQuery({
    queryKey: ["conversation-smart-action-products"],
    queryFn: getProducts,
  });
  const products = productsQuery.data ?? [];

  const messages = [...(conversation?.messages ?? []), ...appended];
  const currentStatus = status ?? conversation?.status ?? "needs_reply";

  // Deterministic, client-side only — never a security decision (§
  // SECURITY / TENANT ISOLATION: "intent/suggestion layer is never
  // security-authoritative"). Every action it names still goes through the
  // same server-authoritative path a manual tap would.
  const suggestion = useMemo(
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

  useEffect(() => {
    setAppended([]);
    setStatus(null);
    setDraft("");
    setLastOrder(null);
  }, [id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  function append(message: Message) {
    setAppended((list) => [...list, message]);
  }

  function send(body: string) {
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
      <header className="flex items-center gap-2 border-b border-border-default px-3 pt-[calc(env(safe-area-inset-top)+0.5rem)] pb-2">
        <button
          type="button"
          aria-label={t("conversation.back")}
          onClick={() => void navigate({ to: "/app/inbox" })}
          className="tap-target flex shrink-0 items-center justify-center rounded-full text-text-primary lg:hidden"
        >
          <ArrowLeft className="size-5" aria-hidden />
        </button>

        <button
          type="button"
          onClick={() => setCustomerOpen(true)}
          aria-label={t("conversation.openCustomer")}
          className="tap-target flex min-w-0 flex-1 items-center gap-2 text-left"
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
          className="tap-target shrink-0 rounded-full px-1"
        >
          <StatusChip status={currentStatus} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
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

        <div className="space-y-2">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        </div>
        <div ref={endRef} />
      </div>

      {/* One bottom surface: order action first, composer beneath it. */}
      <div className="surface-glass elevation-3 border-t border-border-default pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
        <div className="px-4 pt-3">
          {conversation ? (
            <SmartActionStrip
              suggestion={suggestion}
              onAction={(action) => void handleSmartAction(action)}
            />
          ) : null}
          {lastOrder ? (
            <nav
              aria-label={t("conversation.orderActions.label")}
              className="scrollbar-none mb-2 flex gap-2 overflow-x-auto"
            >
              {(["payment", "delivery", "view"] as const).map((action) => (
                <button
                  key={action}
                  type="button"
                  className="press tap-target text-label shrink-0 rounded-full border border-border-default bg-surface-primary px-4 text-text-primary"
                >
                  <span className="chip-text">{t(`conversation.orderActions.${action}`)}</span>
                </button>
              ))}
            </nav>
          ) : null}
          <Button
            className="press tap-target elevation-action h-12 w-full"
            disabled={!customer}
            onClick={() => setOrderOpen(true)}
          >
            {t("conversation.createOrder")}
          </Button>
        </div>

        <form
          className="flex items-end gap-1.5 px-3 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            send(draft);
          }}
        >
          <button
            type="button"
            aria-label={t("conversation.savedReplies")}
            onClick={() => setSavedOpen(true)}
            className="press tap-target flex shrink-0 items-center justify-center rounded-full text-text-secondary"
          >
            <MessageSquareQuote className="size-5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t("conversation.attachment")}
            className="press tap-target flex shrink-0 items-center justify-center rounded-full text-text-secondary"
          >
            <ImagePlus className="size-5" aria-hidden />
          </button>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("conversation.composerPlaceholder")}
            aria-label={t("conversation.composerPlaceholder")}
            className="h-12 min-w-0 flex-1 rounded-full bg-surface-primary"
          />
          <button
            type="submit"
            aria-label={t("conversation.send")}
            disabled={draft.trim().length === 0}
            className="press tap-target flex shrink-0 items-center justify-center rounded-full bg-action-primary px-4 text-text-on-action disabled:opacity-40"
          >
            <Send className="size-5" aria-hidden />
          </button>
        </form>
      </div>

      <BottomSheet
        open={statusOpen}
        onOpenChange={setStatusOpen}
        title={t("conversation.statusLabel")}
        snap="peek"
      >
        <ul className="space-y-2">
          {STATUSES.map((value) => (
            <li key={value}>
              <button
                type="button"
                onClick={() => {
                  setStatus(value);
                  setStatusOpen(false);
                }}
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
