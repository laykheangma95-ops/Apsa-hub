import type { Conversation, ConversationDetail, Message } from "@/types";

export const conversations: Conversation[] = [
  {
    id: "con-1",
    customerId: "cus-1",
    channel: "facebook",
    lastMessage: "យក ២",
    lastMessageAt: "2026-09-02T09:12:00.000Z",
    unreadCount: 2,
    status: "needs_reply",
    assignedStaffId: "staff-1",
  },
  {
    id: "con-2",
    customerId: "cus-2",
    channel: "instagram",
    lastMessage: "តម្លៃសេរ៉ូមប៉ុន្មានដែរបង?",
    lastMessageAt: "2026-09-02T08:41:00.000Z",
    unreadCount: 1,
    status: "unread",
    assignedStaffId: "staff-2",
  },
  {
    id: "con-3",
    customerId: "cus-3",
    channel: "facebook",
    lastMessage: "Can you deliver to Toul Kork today?",
    lastMessageAt: "2026-09-02T07:55:00.000Z",
    unreadCount: 0,
    status: "follow_up",
    assignedStaffId: "staff-3",
  },
  {
    id: "con-4",
    customerId: "cus-4",
    channel: "telegram",
    lastMessage: "ខ្ញុំនឹងផ្ទេរប្រាក់នៅរសៀលនេះ",
    lastMessageAt: "2026-09-02T06:30:00.000Z",
    unreadCount: 3,
    status: "waiting_customer",
    assignedStaffId: "staff-1",
  },
  {
    id: "con-5",
    customerId: "cus-5",
    channel: "instagram",
    lastMessage: "Order APSA-0139 created",
    lastMessageAt: "2026-09-02T05:12:00.000Z",
    unreadCount: 0,
    status: "order_created",
    assignedStaffId: "staff-2",
  },
  {
    id: "con-6",
    customerId: "cus-6",
    channel: "facebook",
    lastMessage: "Thanks, received it this morning!",
    lastMessageAt: "2026-09-02T03:20:00.000Z",
    unreadCount: 0,
    status: "closed",
    assignedStaffId: "staff-3",
  },
  {
    id: "con-7",
    customerId: "cus-7",
    channel: "telegram",
    lastMessage: "សូមផ្ញើរូបពណ៌ត្នោតបន្តិច",
    lastMessageAt: "2026-09-01T13:45:00.000Z",
    unreadCount: 1,
    status: "needs_reply",
    assignedStaffId: "staff-2",
  },
  {
    id: "con-8",
    customerId: "cus-2",
    channel: "instagram",
    lastMessage: "Do you restock the cream bag?",
    lastMessageAt: "2026-09-01T11:02:00.000Z",
    unreadCount: 0,
    status: "follow_up",
  },
  {
    id: "con-9",
    customerId: "cus-4",
    channel: "telegram",
    lastMessage: "COD is fine for me",
    lastMessageAt: "2026-09-01T09:30:00.000Z",
    unreadCount: 0,
    status: "order_created",
    assignedStaffId: "staff-1",
  },
  {
    id: "con-10",
    customerId: "cus-3",
    channel: "facebook",
    lastMessage: "តើមាន size XL អត់?",
    lastMessageAt: "2026-09-01T08:15:00.000Z",
    unreadCount: 4,
    status: "unread",
  },
  {
    id: "con-11",
    customerId: "cus-6",
    channel: "facebook",
    lastMessage: "I'll decide tomorrow, thank you",
    lastMessageAt: "2026-08-31T14:00:00.000Z",
    unreadCount: 0,
    status: "waiting_customer",
    assignedStaffId: "staff-3",
  },
  {
    id: "con-12",
    customerId: "cus-5",
    channel: "instagram",
    lastMessage: "Delivered — thanks for the fast service",
    lastMessageAt: "2026-08-31T10:20:00.000Z",
    unreadCount: 0,
    status: "closed",
    assignedStaffId: "staff-2",
  },
];

/**
 * Dara Sok's thread is the reference thread for the Message → Order flow.
 * The three Khmer lines below are verbatim and must not be edited.
 */
const daraThread: Message[] = [
  {
    id: "msg-1",
    direction: "inbound",
    body: "សួស្តីបង",
    at: "2026-09-02T09:02:00.000Z",
  },
  {
    id: "msg-2",
    direction: "inbound",
    body: "មានពណ៌ខ្មៅ size M អត់?",
    at: "2026-09-02T09:05:00.000Z",
  },
  {
    id: "msg-3",
    direction: "outbound",
    body: "មានបាទ",
    at: "2026-09-02T09:09:00.000Z",
    state: "read",
  },
  {
    id: "msg-4",
    direction: "inbound",
    body: "យក ២",
    at: "2026-09-02T09:12:00.000Z",
  },
];

export const conversationMessages: Record<string, Message[]> = {
  "con-1": daraThread,
  "con-2": [
    { id: "m2-1", direction: "inbound", body: "សួស្តី", at: "2026-09-02T08:38:00.000Z" },
    {
      id: "m2-2",
      direction: "inbound",
      body: "តម្លៃសេរ៉ូមប៉ុន្មានដែរបង?",
      at: "2026-09-02T08:41:00.000Z",
    },
  ],
  "con-3": [
    {
      id: "m3-1",
      direction: "inbound",
      body: "Hi, I saw the shoulder bag post",
      at: "2026-09-02T07:48:00.000Z",
    },
    {
      id: "m3-2",
      direction: "outbound",
      body: "Hi! Yes, black and brown are both in stock.",
      at: "2026-09-02T07:52:00.000Z",
      state: "read",
    },
    {
      id: "m3-3",
      direction: "inbound",
      body: "Can you deliver to Toul Kork today?",
      at: "2026-09-02T07:55:00.000Z",
    },
  ],
  "con-4": [
    {
      id: "m4-1",
      direction: "outbound",
      body: "សរុប $101.50 រួមទាំងដឹកជញ្ជូន",
      at: "2026-09-02T06:20:00.000Z",
      state: "read",
    },
    {
      id: "m4-2",
      direction: "inbound",
      body: "ខ្ញុំនឹងផ្ទេរប្រាក់នៅរសៀលនេះ",
      at: "2026-09-02T06:30:00.000Z",
    },
  ],
  "con-5": [
    {
      id: "m5-1",
      direction: "inbound",
      body: "One Vitamin C serum please",
      at: "2026-09-02T05:06:00.000Z",
    },
    {
      id: "m5-2",
      direction: "system",
      body: "Order APSA-0139 created",
      at: "2026-09-02T05:12:00.000Z",
    },
  ],
  "con-6": [
    {
      id: "m6-1",
      direction: "inbound",
      body: "Thanks, received it this morning!",
      at: "2026-09-02T03:20:00.000Z",
    },
  ],
  "con-7": [
    {
      id: "m7-1",
      direction: "inbound",
      body: "សូមផ្ញើរូបពណ៌ត្នោតបន្តិច",
      at: "2026-09-01T13:45:00.000Z",
    },
  ],
  "con-8": [
    {
      id: "m8-1",
      direction: "inbound",
      body: "Do you restock the cream bag?",
      at: "2026-09-01T11:02:00.000Z",
    },
  ],
  "con-9": [
    { id: "m9-1", direction: "inbound", body: "COD is fine for me", at: "2026-09-01T09:30:00.000Z" },
    { id: "m9-2", direction: "system", body: "Order APSA-0136 created", at: "2026-09-01T09:31:00.000Z" },
  ],
  "con-10": [
    { id: "m10-1", direction: "inbound", body: "តើមាន size XL អត់?", at: "2026-09-01T08:15:00.000Z" },
  ],
  "con-11": [
    {
      id: "m11-1",
      direction: "inbound",
      body: "I'll decide tomorrow, thank you",
      at: "2026-08-31T14:00:00.000Z",
    },
  ],
  "con-12": [
    {
      id: "m12-1",
      direction: "inbound",
      body: "Delivered — thanks for the fast service",
      at: "2026-08-31T10:20:00.000Z",
    },
  ],
};
export type { ConversationDetail };
