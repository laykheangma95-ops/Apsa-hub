import { createFileRoute, notFound } from "@tanstack/react-router";
import { RotateCcw, Send, ShoppingBag, Smartphone, Store, UserRound } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChannelBadge, MessageBubble, StatusChip } from "@/design-system";
import { prototypeFixturesAllowed } from "@/lib/api/prototype-gate";
import { customers } from "@/lib/mock/customers";
import type { Channel, ConversationStatus, Message } from "@/types";

export const Route = createFileRoute("/design/inbox-simulator")({
  beforeLoad: () => {
    if (!prototypeFixturesAllowed()) throw notFound();
  },
  head: () => ({
    meta: [
      { title: "Inbox simulator — APSA" },
      {
        name: "description",
        content:
          "Development-only simulator for customer messages, merchant replies, conversation status and chat-to-order handoff.",
      },
    ],
  }),
  component: InboxSimulator,
});

type SimulatorChannel = Extract<Channel, "facebook" | "instagram" | "telegram">;

const CHANNELS: SimulatorChannel[] = ["facebook", "instagram", "telegram"];

const STATUS_OPTIONS: ConversationStatus[] = [
  "unread",
  "needs_reply",
  "waiting_customer",
  "follow_up",
  "order_created",
  "closed",
];

const STARTER_MESSAGES: Message[] = [
  {
    id: "sim-1",
    direction: "inbound",
    body: "សួស្តីបង",
    at: "2026-09-29T02:00:00.000Z",
  },
  {
    id: "sim-2",
    direction: "inbound",
    body: "មានពណ៌ខ្មៅ size M អត់?",
    at: "2026-09-29T02:01:00.000Z",
  },
];

function InboxSimulator() {
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? "");
  const [channel, setChannel] = useState<SimulatorChannel>("facebook");
  const [status, setStatus] = useState<ConversationStatus>("needs_reply");
  const [messages, setMessages] = useState<Message[]>(STARTER_MESSAGES);
  const [customerDraft, setCustomerDraft] = useState("");
  const [merchantDraft, setMerchantDraft] = useState("");
  const [orderPrepared, setOrderPrepared] = useState(false);
  const idRef = useRef(10);

  const customer = useMemo(
    () => customers.find((item) => item.id === customerId) ?? customers[0],
    [customerId],
  );

  function nextId(prefix: string) {
    idRef.current += 1;
    return `${prefix}-${idRef.current}`;
  }

  function appendInbound() {
    const text = customerDraft.trim();
    if (!text) return;
    setMessages((current) => [
      ...current,
      {
        id: nextId("customer"),
        direction: "inbound",
        body: text,
        at: new Date().toISOString(),
      },
    ]);
    setCustomerDraft("");
    setStatus("needs_reply");
  }

  function appendOutbound() {
    const text = merchantDraft.trim();
    if (!text) return;
    setMessages((current) => [
      ...current,
      {
        id: nextId("merchant"),
        direction: "outbound",
        body: text,
        at: new Date().toISOString(),
        state: "sent",
      },
    ]);
    setMerchantDraft("");
    setStatus("waiting_customer");
  }

  function prepareOrder() {
    setOrderPrepared(true);
    setStatus("order_created");
    setMessages((current) => [
      ...current,
      {
        id: nextId("system"),
        direction: "system",
        body: "Order draft prepared from this conversation",
        at: new Date().toISOString(),
      },
    ]);
  }

  function reset() {
    setCustomerId(customers[0]?.id ?? "");
    setChannel("facebook");
    setStatus("needs_reply");
    setMessages(STARTER_MESSAGES);
    setCustomerDraft("");
    setMerchantDraft("");
    setOrderPrepared(false);
  }

  if (!customer) return null;

  return (
    <main className="min-h-screen bg-surface-secondary px-4 py-6 text-text-primary sm:px-6">
      <div className="mx-auto w-full max-w-6xl">
        <div className="mb-5 flex flex-col gap-3 rounded-3xl border border-border-default bg-surface-primary p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-caption font-medium uppercase tracking-wide text-status-info-text">
              Development only
            </p>
            <h1 className="text-h1 mt-1">Inbox simulator</h1>
            <p className="text-body-sm mt-2 max-w-2xl text-text-secondary">
              Simulate a customer messaging APSA, reply as the merchant, change conversation state,
              and exercise the chat-to-order handoff without connecting Facebook, Instagram or
              Telegram.
            </p>
          </div>
          <Button variant="outline" onClick={reset} className="tap-target shrink-0">
            <RotateCcw className="mr-2 size-4" aria-hidden />
            Reset scenario
          </Button>
        </div>

        <section className="mb-5 grid gap-3 rounded-3xl border border-border-default bg-surface-primary p-4 sm:grid-cols-3">
          <label className="space-y-1.5">
            <span className="text-label text-text-secondary">Test customer</span>
            <select
              value={customerId}
              onChange={(event) => setCustomerId(event.target.value)}
              className="h-11 w-full rounded-xl border border-border-default bg-surface-primary px-3 text-body text-text-primary"
            >
              {customers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.nameEn} · {item.nameKm}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1.5">
            <span className="text-label text-text-secondary">Channel</span>
            <select
              value={channel}
              onChange={(event) => setChannel(event.target.value as SimulatorChannel)}
              className="h-11 w-full rounded-xl border border-border-default bg-surface-primary px-3 text-body text-text-primary"
            >
              {CHANNELS.map((item) => (
                <option key={item} value={item}>
                  {item[0]?.toUpperCase()}
                  {item.slice(1)}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1.5">
            <span className="text-label text-text-secondary">Conversation status</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as ConversationStatus)}
              className="h-11 w-full rounded-xl border border-border-default bg-surface-primary px-3 text-body text-text-primary"
            >
              {STATUS_OPTIONS.map((item) => (
                <option key={item} value={item}>
                  {item.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
        </section>

        <div className="grid gap-5 lg:grid-cols-2">
          <section className="overflow-hidden rounded-[28px] border border-border-default bg-surface-primary shadow-sm">
            <header className="flex items-center gap-3 border-b border-border-default px-4 py-4">
              <div className="flex size-10 items-center justify-center rounded-full bg-surface-secondary">
                <Smartphone className="size-5" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-label">Customer simulator</p>
                <p className="text-caption truncate text-text-muted">
                  What the customer would type in {channel}
                </p>
              </div>
              <ChannelBadge channel={channel} withLabel />
            </header>

            <div className="min-h-[420px] space-y-2 bg-surface-secondary/50 px-4 py-5">
              {messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={{
                    ...message,
                    direction:
                      message.direction === "inbound"
                        ? "outbound"
                        : message.direction === "outbound"
                          ? "inbound"
                          : "system",
                  }}
                />
              ))}
            </div>

            <div className="border-t border-border-default p-4">
              <div className="flex gap-2">
                <Input
                  value={customerDraft}
                  onChange={(event) => setCustomerDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      appendInbound();
                    }
                  }}
                  placeholder="Type as the customer…"
                  aria-label="Customer message"
                  className="h-11"
                />
                <Button
                  onClick={appendInbound}
                  disabled={!customerDraft.trim()}
                  className="tap-target shrink-0"
                  aria-label="Send customer message to APSA"
                >
                  <Send className="size-4" aria-hidden />
                </Button>
              </div>
            </div>
          </section>

          <section className="overflow-hidden rounded-[28px] border border-border-default bg-surface-primary shadow-sm">
            <header className="flex items-center gap-3 border-b border-border-default px-4 py-4">
              <div className="flex size-10 items-center justify-center rounded-full bg-brand-primary-soft">
                <Store className="size-5 text-action-primary" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-label">APSA merchant inbox</p>
                <p className="text-caption truncate text-text-muted">
                  {customer.nameEn} · {customer.nameKm}
                </p>
              </div>
              <StatusChip status={status} />
            </header>

            <div className="border-b border-border-default bg-surface-primary px-4 py-3">
              <div className="flex items-center gap-2">
                <UserRound className="size-4 text-text-muted" aria-hidden />
                <span className="text-body-sm text-text-secondary">{customer.phone}</span>
                <span className="text-caption text-text-muted">· simulated fixture</span>
              </div>
            </div>

            <div className="min-h-[340px] space-y-2 px-4 py-5">
              {messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}
            </div>

            <div className="space-y-3 border-t border-border-default p-4">
              <div className="flex gap-2">
                <Input
                  value={merchantDraft}
                  onChange={(event) => setMerchantDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      appendOutbound();
                    }
                  }}
                  placeholder="Reply as merchant…"
                  aria-label="Merchant reply"
                  className="h-11"
                />
                <Button
                  onClick={appendOutbound}
                  disabled={!merchantDraft.trim()}
                  className="tap-target shrink-0"
                  aria-label="Send merchant reply"
                >
                  <Send className="size-4" aria-hidden />
                </Button>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setMerchantDraft("មានបាទ ខ្មៅ Size M មាន។")}
                  className="tap-target justify-start"
                >
                  Quick reply · In stock
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setMerchantDraft("សរុប ៛53,000 រួមទាំងដឹកជញ្ជូន។")}
                  className="tap-target justify-start"
                >
                  Quick reply · Price
                </Button>
              </div>

              <Button
                type="button"
                onClick={prepareOrder}
                disabled={orderPrepared}
                className="tap-target w-full"
              >
                <ShoppingBag className="mr-2 size-4" aria-hidden />
                {orderPrepared ? "Order draft prepared" : "Prepare order from chat"}
              </Button>

              <p className="text-caption text-text-muted">
                Simulator only: no provider API, database, payment, inventory or real order is
                written from this page.
              </p>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
