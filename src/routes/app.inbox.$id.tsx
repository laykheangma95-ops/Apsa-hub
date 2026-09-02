import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ImagePlus, MessageSquareQuote, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { getConversation, getCustomer } from "@/lib/api";
import { initials, localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { CompanionColor, ConversationStatus, Message } from "@/types";

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

  const messages = [...(conversation?.messages ?? []), ...appended];
  const currentStatus = status ?? conversation?.status ?? "needs_reply";

  useEffect(() => {
    setAppended([]);
    setStatus(null);
    setDraft("");
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

      {/* Persistent order action sits directly above the composer. */}
      <div className="border-t border-border-default px-4 py-2">
        <Button
          className="tap-target h-12 w-full"
          disabled={!customer}
          onClick={() => setOrderOpen(true)}
        >
          {t("conversation.createOrder")}
        </Button>
      </div>

      <form
        className="flex items-end gap-2 border-t border-border-default px-3 py-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]"
        onSubmit={(event) => {
          event.preventDefault();
          send(draft);
        }}
      >
        <button
          type="button"
          aria-label={t("conversation.savedReplies")}
          onClick={() => setSavedOpen(true)}
          className="tap-target flex shrink-0 items-center justify-center rounded-full text-text-secondary"
        >
          <MessageSquareQuote className="size-5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={t("conversation.attachment")}
          className="tap-target flex shrink-0 items-center justify-center rounded-full text-text-secondary"
        >
          <ImagePlus className="size-5" aria-hidden />
        </button>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("conversation.composerPlaceholder")}
          aria-label={t("conversation.composerPlaceholder")}
          className="h-12 min-w-0 flex-1"
        />
        <button
          type="submit"
          aria-label={t("conversation.send")}
          disabled={draft.trim().length === 0}
          className="tap-target flex shrink-0 items-center justify-center rounded-full bg-action-primary px-4 text-text-on-action disabled:opacity-40"
        >
          <Send className="size-5" aria-hidden />
        </button>
      </form>

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
          }}
        />
      ) : null}
    </div>
  );
}
