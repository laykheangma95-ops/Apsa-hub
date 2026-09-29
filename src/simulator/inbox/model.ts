/**
 * Isolated, in-memory model for the Inbox simulator.
 *
 * Pure state machine: no imports from src/lib/api, src/lib/mock, Supabase,
 * server functions, React Query or any provider. Every id is synthetic
 * (sim_*). Money is integer minor units with an explicit currency.
 */
import type { ConversationStatus } from "@/types";

export type SimChannel = "facebook" | "instagram" | "telegram";
export type SimDirection = "inbound" | "outbound" | "system";

export interface SimMessage {
  id: string;
  direction: SimDirection;
  body: string;
  at: string;
}

export interface SimCustomer {
  id: string;
  name: string;
  phone: string;
  address: string;
  handle: string;
}

export interface SimProduct {
  id: string;
  name: string;
  unitMinor: number;
  currency: "KHR";
}

export interface SimConversation {
  id: string;
  customerId: string;
  channel: SimChannel;
  status: ConversationStatus;
  unread: number;
  messages: SimMessage[];
}

export interface SimOrder {
  id: string;
  customerId: string;
  conversationId: string;
  productId: string;
  quantity: number;
  totalMinor: number;
  currency: "KHR";
  simulated: true;
}

export interface SimState {
  conversations: SimConversation[];
  orders: SimOrder[];
  seq: number;
}

export const SIM_CUSTOMERS: readonly SimCustomer[] = [
  {
    id: "sim_customer_001",
    name: "Simulated Customer One",
    phone: "000 000 001",
    address: "Simulated address 1, Test Street",
    handle: "sim.one",
  },
  {
    id: "sim_customer_002",
    name: "Simulated Customer Two",
    phone: "000 000 002",
    address: "Simulated address 2, Test Street",
    handle: "sim.two",
  },
  {
    id: "sim_customer_003",
    name: "Simulated Customer Three",
    phone: "000 000 003",
    address: "Simulated address 3, Test Street",
    handle: "sim.three",
  },
];

export const SIM_PRODUCTS: readonly SimProduct[] = [
  { id: "sim_product_001", name: "Simulated Product A", unitMinor: 2500000, currency: "KHR" },
  { id: "sim_product_002", name: "Simulated Product B", unitMinor: 4000000, currency: "KHR" },
];

const T0 = "2026-01-01T00:00:00.000Z";

export function initialSimState(): SimState {
  return {
    conversations: [
      {
        id: "sim_conv_001",
        customerId: "sim_customer_001",
        channel: "facebook",
        status: "unread",
        unread: 2,
        messages: [
          { id: "sim_msg_001", direction: "inbound", body: "Simulated hello", at: T0 },
          {
            id: "sim_msg_002",
            direction: "inbound",
            body: "Simulated: is Product A in stock?",
            at: T0,
          },
        ],
      },
      {
        id: "sim_conv_002",
        customerId: "sim_customer_002",
        channel: "instagram",
        status: "needs_reply",
        unread: 1,
        messages: [
          { id: "sim_msg_003", direction: "inbound", body: "Simulated price question", at: T0 },
        ],
      },
      {
        id: "sim_conv_003",
        customerId: "sim_customer_003",
        channel: "telegram",
        status: "waiting_customer",
        unread: 0,
        messages: [
          { id: "sim_msg_004", direction: "inbound", body: "Simulated order request", at: T0 },
          { id: "sim_msg_005", direction: "outbound", body: "Simulated merchant reply", at: T0 },
        ],
      },
    ],
    orders: [],
    seq: 100,
  };
}

export type SimAction =
  | { type: "open"; conversationId: string }
  | { type: "receive"; conversationId: string; text: string; at: string }
  | { type: "reply"; conversationId: string; text: string; at: string }
  | { type: "setStatus"; conversationId: string; status: ConversationStatus }
  | {
      type: "createOrder";
      conversationId: string;
      productId: string;
      quantity: number;
      at: string;
    }
  | { type: "reset" };

function pad(n: number): string {
  return String(n).padStart(3, "0");
}

function mapConv(
  state: SimState,
  id: string,
  fn: (c: SimConversation) => SimConversation,
): SimState {
  return {
    ...state,
    conversations: state.conversations.map((c) => (c.id === id ? fn(c) : c)),
  };
}

export function simReducer(state: SimState, action: SimAction): SimState {
  switch (action.type) {
    case "reset":
      return initialSimState();
    case "open":
      return mapConv(state, action.conversationId, (c) => ({
        ...c,
        unread: 0,
        status: c.status === "unread" ? "needs_reply" : c.status,
      }));
    case "receive": {
      const text = action.text.trim();
      if (!text) return state;
      const seq = state.seq + 1;
      return mapConv({ ...state, seq }, action.conversationId, (c) => ({
        ...c,
        unread: c.unread + 1,
        status: c.status === "order_created" || c.status === "closed" ? c.status : "unread",
        messages: [
          ...c.messages,
          { id: `sim_msg_${pad(seq)}`, direction: "inbound", body: text, at: action.at },
        ],
      }));
    }
    case "reply": {
      const text = action.text.trim();
      if (!text) return state;
      const seq = state.seq + 1;
      return mapConv({ ...state, seq }, action.conversationId, (c) => ({
        ...c,
        unread: 0,
        status:
          c.status === "order_created" || c.status === "closed" ? c.status : "waiting_customer",
        messages: [
          ...c.messages,
          { id: `sim_msg_${pad(seq)}`, direction: "outbound", body: text, at: action.at },
        ],
      }));
    }
    case "setStatus":
      return mapConv(state, action.conversationId, (c) => ({ ...c, status: action.status }));
    case "createOrder": {
      const conv = state.conversations.find((c) => c.id === action.conversationId);
      const product = SIM_PRODUCTS.find((p) => p.id === action.productId);
      const quantity = Math.trunc(action.quantity);
      if (!conv || !product || !(quantity >= 1) || quantity > 99) return state;
      const seq = state.seq + 1;
      const order: SimOrder = {
        id: `sim_order_${pad(state.orders.length + 1)}`,
        customerId: conv.customerId,
        conversationId: conv.id,
        productId: product.id,
        quantity,
        totalMinor: product.unitMinor * quantity,
        currency: product.currency,
        simulated: true,
      };
      const next = mapConv({ ...state, seq, orders: [...state.orders, order] }, conv.id, (c) => ({
        ...c,
        status: "order_created",
        messages: [
          ...c.messages,
          {
            id: `sim_msg_${pad(seq)}`,
            direction: "system",
            body: `Simulated order ${order.id} created (local only)`,
            at: action.at,
          },
        ],
      }));
      return next;
    }
  }
}
