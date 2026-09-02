import type {
  CustomerEvent,
  CustomerNote,
  Delivery,
  OrderEvent,
  PaymentRecord,
} from "@/types";
import { usd } from "@/lib/money";

export const orderEvents: Record<string, OrderEvent[]> = {
  "ord-1": [
    { id: "oe-1", kind: "created", at: "2026-09-02T05:12:00.000Z", actor: "Lyda", context: "instagram" },
    { id: "oe-2", kind: "payment_confirmed", at: "2026-09-02T05:20:00.000Z", actor: "Lyda", context: "khqr" },
    { id: "oe-3", kind: "packing_started", at: "2026-09-02T06:00:00.000Z", actor: "Ratana" },
    { id: "oe-4", kind: "in_transit", at: "2026-09-02T08:10:00.000Z", context: "J&T Express" },
    { id: "oe-5", kind: "delivered", at: "2026-09-02T12:40:00.000Z", context: "J&T Express" },
  ],
  "ord-2": [
    { id: "oe-6", kind: "created", at: "2026-09-01T09:20:00.000Z", actor: "Lyda", context: "facebook" },
    { id: "oe-7", kind: "payment_confirmed", at: "2026-09-01T09:35:00.000Z", actor: "Lyda", context: "bank_transfer" },
    { id: "oe-8", kind: "delivered", at: "2026-09-01T15:05:00.000Z", context: "VET Express" },
  ],
  "ord-5": [
    { id: "oe-9", kind: "created", at: "2026-08-30T04:00:00.000Z", actor: "Lyda", context: "instagram" },
    { id: "oe-10", kind: "note", at: "2026-08-30T04:20:00.000Z", actor: "Lyda", context: "Customer will send the transfer slip tonight." },
    { id: "oe-11", kind: "packing_started", at: "2026-08-30T06:10:00.000Z", actor: "Ratana" },
  ],
  "ord-6": [
    { id: "oe-12", kind: "created", at: "2026-08-26T07:40:00.000Z", actor: "Sokchea", context: "telegram" },
    { id: "oe-13", kind: "payment_confirmed", at: "2026-08-26T08:00:00.000Z", actor: "Sokchea", context: "bank_transfer" },
    { id: "oe-14", kind: "picked_up", at: "2026-08-26T10:30:00.000Z", context: "Capital Express" },
    { id: "oe-15", kind: "in_transit", at: "2026-08-26T11:00:00.000Z", context: "Capital Express" },
  ],
  "ord-7": [
    { id: "oe-16", kind: "created", at: "2026-09-03T02:10:00.000Z", actor: "Ratana", context: "telegram" },
    { id: "oe-17", kind: "picked_up", at: "2026-09-03T04:00:00.000Z", context: "Grab Express" },
    { id: "oe-18", kind: "in_transit", at: "2026-09-03T04:20:00.000Z", context: "Grab Express" },
  ],
  "ord-8": [
    { id: "oe-19", kind: "created", at: "2026-08-24T03:00:00.000Z", actor: "Lyda", context: "facebook" },
    { id: "oe-20", kind: "payment_failed", at: "2026-08-24T03:40:00.000Z", actor: "Lyda", context: "khqr" },
    { id: "oe-21", kind: "cancelled", at: "2026-08-24T09:00:00.000Z", actor: "Sokchea", context: "Customer changed their mind." },
  ],
  "ord-9": [
    { id: "oe-22", kind: "created", at: "2026-08-12T06:00:00.000Z", actor: "Lyda", context: "instagram" },
    { id: "oe-23", kind: "payment_confirmed", at: "2026-08-12T06:15:00.000Z", actor: "Lyda", context: "cash" },
    { id: "oe-24", kind: "delivered", at: "2026-08-13T10:00:00.000Z", context: "VET Express" },
    { id: "oe-25", kind: "returned", at: "2026-08-16T04:00:00.000Z", actor: "Ratana", context: "Wrong size." },
    { id: "oe-26", kind: "refunded", at: "2026-08-16T05:30:00.000Z", actor: "Sokchea", context: "bank_transfer" },
  ],
};

export const orderPayments: Record<string, PaymentRecord[]> = {
  "ord-1": [
    {
      id: "pay-1",
      method: "khqr",
      amount: usd(1890),
      status: "paid",
      reference: "KHQR-882301",
      confirmedManuallyBy: "Lyda",
      at: "2026-09-02T05:20:00.000Z",
    },
  ],
  "ord-2": [
    {
      id: "pay-2",
      method: "bank_transfer",
      amount: usd(2070),
      status: "paid",
      reference: "ABA-77120",
      confirmedManuallyBy: "Lyda",
      at: "2026-09-01T09:35:00.000Z",
    },
  ],
  "ord-5": [
    {
      id: "pay-3",
      method: "bank_transfer",
      amount: usd(1000),
      status: "partially_paid",
      reference: "ABA-90311",
      confirmedManuallyBy: "Lyda",
      at: "2026-08-30T05:00:00.000Z",
    },
  ],
  "ord-6": [
    {
      id: "pay-4",
      method: "bank_transfer",
      amount: usd(10150),
      status: "paid",
      reference: "ACLEDA-31882",
      confirmedManuallyBy: "Sokchea",
      at: "2026-08-26T08:00:00.000Z",
    },
  ],
  "ord-7": [],
  "ord-8": [
    {
      id: "pay-5",
      method: "khqr",
      amount: usd(1450),
      status: "failed",
      reference: "KHQR-771002",
      at: "2026-08-24T03:40:00.000Z",
    },
  ],
  "ord-9": [
    {
      id: "pay-6",
      method: "cash",
      amount: usd(2180),
      status: "paid",
      confirmedManuallyBy: "Lyda",
      at: "2026-08-12T06:15:00.000Z",
    },
    {
      id: "pay-7",
      method: "bank_transfer",
      amount: usd(2180),
      status: "refunded",
      reference: "ABA-REF-2201",
      confirmedManuallyBy: "Sokchea",
      at: "2026-08-16T05:30:00.000Z",
    },
  ],
};

export const deliveries: Delivery[] = [
  {
    id: "dlv-1",
    orderId: "ord-6",
    orderCode: "APSA-0136",
    customerId: "cus-4",
    courierId: "capital",
    courierName: "Capital Express",
    trackingNumber: "CE-2026-88431",
    status: "in_transit",
    fee: usd(150),
    events: [
      { id: "de-1", status: "requested", at: "2026-08-26T09:00:00.000Z" },
      { id: "de-2", status: "accepted", at: "2026-08-26T09:30:00.000Z" },
      { id: "de-3", status: "picked_up", at: "2026-08-26T10:30:00.000Z" },
      { id: "de-4", status: "in_transit", at: "2026-08-26T11:00:00.000Z", context: "Toul Kork hub" },
    ],
  },
  {
    id: "dlv-2",
    orderId: "ord-7",
    orderCode: "APSA-0142",
    customerId: "cus-7",
    courierId: "grab",
    courierName: "Grab Express",
    trackingNumber: "GE-2026-11207",
    status: "in_transit",
    fee: usd(150),
    codAmount: usd(3240),
    codCollected: false,
    settlementPending: true,
    events: [
      { id: "de-5", status: "requested", at: "2026-09-03T03:00:00.000Z" },
      { id: "de-6", status: "accepted", at: "2026-09-03T03:20:00.000Z" },
      { id: "de-7", status: "picked_up", at: "2026-09-03T04:00:00.000Z" },
      { id: "de-8", status: "in_transit", at: "2026-09-03T04:20:00.000Z" },
    ],
  },
  {
    id: "dlv-3",
    orderId: "ord-1",
    orderCode: "APSA-0139",
    customerId: "cus-5",
    courierId: "jt",
    courierName: "J&T Express",
    trackingNumber: "JT-2026-55190",
    status: "delivered",
    fee: usd(90),
    events: [
      { id: "de-9", status: "requested", at: "2026-09-02T06:10:00.000Z" },
      { id: "de-10", status: "accepted", at: "2026-09-02T06:40:00.000Z" },
      { id: "de-11", status: "picked_up", at: "2026-09-02T07:50:00.000Z" },
      { id: "de-12", status: "in_transit", at: "2026-09-02T08:10:00.000Z" },
      { id: "de-13", status: "delivered", at: "2026-09-02T12:40:00.000Z" },
    ],
  },
  {
    id: "dlv-4",
    orderId: "ord-5",
    orderCode: "APSA-0141",
    customerId: "cus-2",
    courierId: "vet",
    courierName: "VET Express",
    trackingNumber: "VET-2026-40012",
    status: "failed",
    fee: usd(120),
    failureReason: "customer_unavailable",
    events: [
      { id: "de-14", status: "requested", at: "2026-08-30T06:30:00.000Z" },
      { id: "de-15", status: "accepted", at: "2026-08-30T07:00:00.000Z" },
      { id: "de-16", status: "picked_up", at: "2026-08-30T08:15:00.000Z" },
      { id: "de-17", status: "in_transit", at: "2026-08-30T08:45:00.000Z" },
      { id: "de-18", status: "failed", at: "2026-08-30T13:20:00.000Z", context: "No answer after three calls." },
    ],
  },
];

export const customerNotes: CustomerNote[] = [
  {
    id: "cn-1",
    customerId: "cus-1",
    body: "Prefers delivery after 5pm. Calls before arriving.",
    staffName: "Lyda",
    at: "2026-08-22T09:00:00.000Z",
  },
  {
    id: "cn-2",
    customerId: "cus-1",
    body: "Always orders size M. Loves black.",
    staffName: "Sokchea",
    at: "2026-07-11T02:30:00.000Z",
  },
  {
    id: "cn-3",
    customerId: "cus-2",
    body: "VIP — send new arrivals first.",
    staffName: "Lyda",
    at: "2026-08-02T04:00:00.000Z",
  },
];

export const customerEvents: Record<string, CustomerEvent[]> = {
  "cus-1": [
    { id: "ce-1", kind: "message_received", at: "2026-09-03T01:40:00.000Z", context: "facebook" },
    { id: "ce-2", kind: "order_created", at: "2026-09-01T09:20:00.000Z", context: "APSA-0138" },
    { id: "ce-3", kind: "payment_confirmed", at: "2026-09-01T09:35:00.000Z", context: "APSA-0138" },
    { id: "ce-4", kind: "delivered", at: "2026-09-01T15:05:00.000Z", context: "APSA-0138" },
    { id: "ce-5", kind: "note_added", at: "2026-08-22T09:00:00.000Z", context: "Lyda" },
  ],
  "cus-2": [
    { id: "ce-6", kind: "order_created", at: "2026-08-30T04:00:00.000Z", context: "APSA-0141" },
    { id: "ce-7", kind: "delivery_created", at: "2026-08-30T06:30:00.000Z", context: "VET Express" },
  ],
  "cus-4": [
    { id: "ce-8", kind: "order_created", at: "2026-08-26T07:40:00.000Z", context: "APSA-0136" },
    { id: "ce-9", kind: "payment_confirmed", at: "2026-08-26T08:00:00.000Z", context: "APSA-0136" },
    { id: "ce-10", kind: "delivery_created", at: "2026-08-26T09:00:00.000Z", context: "Capital Express" },
  ],
  "cus-5": [
    { id: "ce-11", kind: "order_created", at: "2026-09-02T05:12:00.000Z", context: "APSA-0139" },
    { id: "ce-12", kind: "delivered", at: "2026-09-02T12:40:00.000Z", context: "APSA-0139" },
  ],
  "cus-7": [
    { id: "ce-13", kind: "conversation_opened", at: "2026-09-03T01:00:00.000Z", context: "telegram" },
    { id: "ce-14", kind: "order_created", at: "2026-09-03T02:10:00.000Z", context: "APSA-0142" },
  ],
};
