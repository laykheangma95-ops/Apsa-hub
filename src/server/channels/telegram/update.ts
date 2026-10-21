/**
 * Telegram Update → APSA inbound message. Pure; no I/O.
 *
 * Telegram's shape stops here (API_AND_EVENTS.md §100: "Map what is common.
 * Store provider-specific metadata separately."). What leaves this module is
 * the provider-neutral input of ingest_telegram_inbound (migration 064).
 *
 * Only private chats with a human sender are ingested — a merchant's bot added
 * to a group must not turn every group member into a Customer. Everything else
 * is acknowledged and ignored, with a reason for the log.
 */
import type { MessageContentType } from "@/server/conversations/types";

export interface TelegramInbound {
  kind: "message";
  chatId: string;
  senderId: string;
  senderName: string | null;
  senderHandle: string | null;
  messageRef: string;
  body: string;
  type: Exclude<MessageContentType, "system">;
  occurredAt: string;
  attachments: Record<string, unknown>[] | null;
}

export type TelegramIgnoredReason =
  "not_a_message" | "not_private_chat" | "bot_sender" | "malformed" | "unsupported_content";

export type ParsedTelegramUpdate =
  TelegramInbound | { kind: "ignored"; reason: TelegramIgnoredReason };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function safeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function fileAttachment(kind: string, file: unknown): Json | null {
  if (!isObject(file) || typeof file["file_id"] !== "string") return null;
  const attachment: Json = { kind, provider_file_id: String(file["file_id"]).slice(0, 256) };
  const mime = str(file["mime_type"], 100);
  if (mime) attachment["mime_type"] = mime;
  const name = str(file["file_name"], 200);
  if (name) attachment["file_name"] = name;
  if (safeInt(file["file_size"])) attachment["file_size"] = file["file_size"];
  if (safeInt(file["duration"])) attachment["duration_seconds"] = file["duration"];
  return attachment;
}

/** The update_id, read for replay protection after the secret has been verified. */
export function telegramUpdateId(rawBody: Uint8Array): string | null {
  try {
    const update = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
    if (isObject(update) && safeInt(update["update_id"]) && update["update_id"] >= 0) {
      return String(update["update_id"]);
    }
  } catch {
    // fall through
  }
  return null;
}

export function parseTelegramUpdate(update: unknown): ParsedTelegramUpdate {
  if (!isObject(update)) return { kind: "ignored", reason: "malformed" };
  const message = update["message"];
  if (!isObject(message)) return { kind: "ignored", reason: "not_a_message" };

  const chat = message["chat"];
  const from = message["from"];
  if (!isObject(chat) || !safeInt(chat["id"]) || !safeInt(message["message_id"])) {
    return { kind: "ignored", reason: "malformed" };
  }
  if (chat["type"] !== "private") return { kind: "ignored", reason: "not_private_chat" };
  if (!isObject(from) || !safeInt(from["id"])) return { kind: "ignored", reason: "malformed" };
  if (from["is_bot"] === true) return { kind: "ignored", reason: "bot_sender" };
  if (!safeInt(message["date"])) return { kind: "ignored", reason: "malformed" };

  const caption = str(message["caption"], 4096) ?? "";
  let body: string;
  let type: TelegramInbound["type"];
  let attachments: Json[] | null = null;

  const text = str(message["text"], 4096);
  if (text) {
    body = text;
    type = "text";
  } else if (Array.isArray(message["photo"]) && message["photo"].length > 0) {
    // Telegram lists every size; the last is the largest.
    const largest = fileAttachment("photo", message["photo"][message["photo"].length - 1]);
    if (!largest) return { kind: "ignored", reason: "malformed" };
    body = caption;
    type = "image";
    attachments = [largest];
  } else if (isObject(message["video"]) || isObject(message["video_note"])) {
    const video = fileAttachment("video", message["video"] ?? message["video_note"]);
    if (!video) return { kind: "ignored", reason: "malformed" };
    body = caption;
    type = "video";
    attachments = [video];
  } else if (isObject(message["voice"]) || isObject(message["audio"])) {
    const audio = fileAttachment("audio", message["voice"] ?? message["audio"]);
    if (!audio) return { kind: "ignored", reason: "malformed" };
    body = caption;
    type = "audio";
    attachments = [audio];
  } else if (isObject(message["document"])) {
    const document = fileAttachment("file", message["document"]);
    if (!document) return { kind: "ignored", reason: "malformed" };
    body = caption;
    type = "file";
    attachments = [document];
  } else if (isObject(message["sticker"])) {
    const sticker = fileAttachment("sticker", message["sticker"]);
    if (!sticker) return { kind: "ignored", reason: "malformed" };
    body = str(message["sticker"]["emoji"], 16) ?? "";
    type = "image";
    attachments = [sticker];
  } else if (isObject(message["contact"]) && str(message["contact"]["phone_number"], 32)) {
    // A customer sharing a phone number is order-critical: keep it as text.
    body = str(message["contact"]["phone_number"], 32)!;
    type = "text";
  } else if (
    isObject(message["location"]) &&
    typeof message["location"]["latitude"] === "number" &&
    typeof message["location"]["longitude"] === "number"
  ) {
    body = `${message["location"]["latitude"]}, ${message["location"]["longitude"]}`;
    type = "text";
  } else {
    return { kind: "ignored", reason: "unsupported_content" };
  }

  const first = str(from["first_name"], 100);
  const last = str(from["last_name"], 100);
  return {
    kind: "message",
    chatId: String(chat["id"]),
    senderId: String(from["id"]),
    senderName: [first, last].filter(Boolean).join(" ") || null,
    senderHandle: str(from["username"], 64),
    messageRef: `tg:${message["message_id"]}`,
    body,
    type,
    occurredAt: new Date((message["date"] as number) * 1000).toISOString(),
    attachments,
  };
}
