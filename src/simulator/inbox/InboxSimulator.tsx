import { ArrowLeft, RotateCcw, Send, ShoppingBag, UserRound } from "lucide-react";
import { useReducer, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChannelBadge } from "@/design-system/ChannelBadge";
import { MessageBubble } from "@/design-system/MessageBubble";
import { StatusChip } from "@/design-system/StatusChip";
import type { ConversationStatus } from "@/types";
import {
  initialSimState,
  SIM_CUSTOMERS,
  SIM_PRODUCTS,
  simReducer,
  type SimConversation,
} from "./model";

const STATUS_OPTIONS: ConversationStatus[] = [
  "unread",
  "needs_reply",
  "waiting_customer",
  "follow_up",
  "order_created",
  "closed",
];

const customerOf = (id: string) => SIM_CUSTOMERS.find((c) => c.id === id);

/** Local-only. Imports nothing that can reach a database, provider or order path. */
export default function InboxSimulator() {
  const [state, dispatch] = useReducer(simReducer, undefined, initialSimState);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showCustomer, setShowCustomer] = useState(false);
  const [showOrder, setShowOrder] = useState(false);
  const [inbound, setInbound] = useState("");
  const [reply, setReply] = useState("");
  const [productId, setProductId] = useState(SIM_PRODUCTS[0]?.id ?? "");
  const [quantity, setQuantity] = useState(1);

  const conv: SimConversation | undefined = state.conversations.find((c) => c.id === openId);
  const customer = conv ? customerOf(conv.customerId) : undefined;
  const orders = conv ? state.orders.filter((o) => o.conversationId === conv.id) : [];
  const now = () => new Date().toISOString();

  function resetAll() {
    dispatch({ type: "reset" });
    setOpenId(null);
    setShowCustomer(false);
    setShowOrder(false);
    setInbound("");
    setReply("");
    setQuantity(1);
  }

  const banner = (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-border-default bg-surface-primary p-3">
      <div className="min-w-0">
        <p className="text-label">Inbox simulator · development only</p>
        <p className="text-caption text-text-muted">
          Local memory only. No database, provider, order, payment, inventory or delivery.
        </p>
      </div>
      <Button variant="outline" onClick={resetAll} className="tap-target shrink-0">
        <RotateCcw className="mr-2 size-4" aria-hidden />
        Reset
      </Button>
    </div>
  );

  if (!conv || !customer) {
    return (
      <main className="min-h-screen bg-surface-secondary px-4 py-4 text-text-primary">
        <div className="mx-auto w-full max-w-xl">
          {banner}
          <ul className="space-y-2">
            {state.conversations.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => {
                    dispatch({ type: "open", conversationId: c.id });
                    setOpenId(c.id);
                  }}
                  className="tap-target flex w-full items-center gap-3 rounded-2xl border border-border-default bg-surface-primary p-3 text-start focus-visible:outline focus-visible:outline-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-label truncate">{customerOf(c.customerId)?.name}</p>
                    <p className="text-caption truncate text-text-muted">
                      {c.messages[c.messages.length - 1]?.body}
                    </p>
                  </div>
                  {c.unread > 0 && (
                    <span className="text-caption rounded-full bg-action-primary px-2 py-0.5 text-text-inverse">
                      {c.unread} unread
                    </span>
                  )}
                  <StatusChip status={c.status} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-surface-secondary px-4 py-4 text-text-primary">
      <div className="mx-auto w-full max-w-xl">
        {banner}
        <section className="overflow-hidden rounded-2xl border border-border-default bg-surface-primary">
          <header className="flex items-center gap-2 border-b border-border-default p-3">
            <Button
              variant="ghost"
              className="tap-target"
              onClick={() => {
                setOpenId(null);
                setShowCustomer(false);
                setShowOrder(false);
              }}
              aria-label="Back to simulated inbox"
            >
              <ArrowLeft className="size-4" aria-hidden />
            </Button>
            <div className="min-w-0 flex-1">
              <p className="text-label truncate">{customer.name}</p>
              <p className="text-caption text-text-muted">{conv.id}</p>
            </div>
            <ChannelBadge channel={conv.channel} withLabel />
            <StatusChip status={conv.status} />
          </header>

          <div className="flex flex-wrap items-center gap-2 border-b border-border-default p-3">
            <select
              aria-label="Conversation status"
              value={conv.status}
              onChange={(e) =>
                dispatch({
                  type: "setStatus",
                  conversationId: conv.id,
                  status: e.target.value as ConversationStatus,
                })
              }
              className="h-11 rounded-xl border border-border-default bg-surface-primary px-3 text-body"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s.replaceAll("_", " ")}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              className="tap-target"
              onClick={() => setShowCustomer((v) => !v)}
            >
              <UserRound className="mr-2 size-4" aria-hidden />
              Customer
            </Button>
            <Button
              variant="outline"
              className="tap-target"
              onClick={() => setShowOrder((v) => !v)}
            >
              <ShoppingBag className="mr-2 size-4" aria-hidden />
              Create order
            </Button>
          </div>

          {showCustomer && (
            <dl className="text-body-sm space-y-1 border-b border-border-default p-3">
              <div>
                <dt className="text-caption text-text-muted">ID</dt>
                <dd>{customer.id}</dd>
              </div>
              <div>
                <dt className="text-caption text-text-muted">Phone</dt>
                <dd>{customer.phone}</dd>
              </div>
              <div>
                <dt className="text-caption text-text-muted">Address</dt>
                <dd>{customer.address}</dd>
              </div>
              <div>
                <dt className="text-caption text-text-muted">Simulated orders</dt>
                <dd>{state.orders.filter((o) => o.customerId === customer.id).length}</dd>
              </div>
            </dl>
          )}

          {showOrder && (
            <div className="space-y-2 border-b border-border-default p-3">
              <select
                aria-label="Simulated product"
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
                className="h-11 w-full rounded-xl border border-border-default bg-surface-primary px-3 text-body"
              >
                {SIM_PRODUCTS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.unitMinor} {p.currency}
                  </option>
                ))}
              </select>
              <Input
                type="number"
                min={1}
                max={99}
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
                aria-label="Quantity"
                className="h-11"
              />
              <Button
                className="tap-target w-full"
                onClick={() => {
                  dispatch({
                    type: "createOrder",
                    conversationId: conv.id,
                    productId,
                    quantity,
                    at: now(),
                  });
                  setShowOrder(false);
                }}
              >
                Create simulated order
              </Button>
            </div>
          )}

          {orders.length > 0 && (
            <ul className="text-body-sm space-y-1 border-b border-border-default p-3">
              {orders.map((o) => (
                <li key={o.id}>
                  {o.id} · {o.customerId} · {o.conversationId} · {o.totalMinor} {o.currency} ·
                  simulated
                </li>
              ))}
            </ul>
          )}

          <div className="min-h-[240px] space-y-2 px-3 py-4">
            {conv.messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={{ id: m.id, direction: m.direction, body: m.body, at: m.at }}
              />
            ))}
          </div>

          <div className="space-y-2 border-t border-border-default p-3">
            <div className="flex gap-2">
              <Input
                value={inbound}
                onChange={(e) => setInbound(e.target.value)}
                placeholder="Simulate incoming message…"
                aria-label="Simulated incoming message"
                className="h-11"
              />
              <Button
                variant="outline"
                className="tap-target shrink-0"
                disabled={!inbound.trim()}
                onClick={() => {
                  dispatch({ type: "receive", conversationId: conv.id, text: inbound, at: now() });
                  setInbound("");
                }}
              >
                Receive
              </Button>
            </div>
            <div className="flex gap-2">
              <Input
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Reply as merchant (local)…"
                aria-label="Merchant reply"
                className="h-11"
              />
              <Button
                className="tap-target shrink-0"
                disabled={!reply.trim()}
                aria-label="Send simulated reply"
                onClick={() => {
                  dispatch({ type: "reply", conversationId: conv.id, text: reply, at: now() });
                  setReply("");
                }}
              >
                <Send className="size-4" aria-hidden />
              </Button>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
