/**
 * Database row types for the conversation domain.
 * Matches the columns in migrations 031-032.
 *
 * Temporary hand-authored types, same convention as src/server/customers/types.ts.
 * After migrations are applied to the live Supabase project, regenerate with
 * `supabase gen types typescript --local > src/lib/supabase/types.ts` and replace
 * these with the generated Database["public"]["Tables"][...]["Row"] paths.
 */

export type ConversationProvider = "FACEBOOK" | "INSTAGRAM" | "TELEGRAM";

/** Mirrors src/types/index.ts ConversationStatus exactly. */
export type ConversationStatusRow =
  "unread" | "needs_reply" | "follow_up" | "waiting_customer" | "order_created" | "closed";

export interface ConversationRow {
  id: string;
  organization_id: string;
  workspace_id: string | null;
  customer_id: string | null;
  provider: ConversationProvider;
  provider_conversation_id: string;
  status: ConversationStatusRow;
  assigned_user_id: string | null;
  unread_count: number;
  last_message_preview: string | null;
  last_message_at: string;
  created_at: string;
  updated_at: string;
}

/** Mirrors src/types/index.ts MessageDirection exactly. */
export type MessageDirectionRow = "inbound" | "outbound" | "system";

export type MessageSenderType = "customer" | "staff" | "system";

export type MessageContentType = "text" | "image" | "video" | "audio" | "file" | "system";

/** Mirrors src/types/index.ts DeliveryState exactly. */
export type MessageStateRow = "sending" | "sent" | "delivered" | "read" | "failed";

export interface MessageRow {
  id: string;
  organization_id: string;
  conversation_id: string;
  provider_message_id: string | null;
  direction: MessageDirectionRow;
  sender_type: MessageSenderType;
  sender_user_id: string | null;
  message_type: MessageContentType;
  body: string;
  state: MessageStateRow | null;
  attachments: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  occurred_at: string;
  created_at: string;
}
