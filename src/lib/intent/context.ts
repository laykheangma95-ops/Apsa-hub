/**
 * §17 Bounded conversation context.
 *
 * Cambodian chat arrives in bursts of very short messages ("អានេះមានអត់" / "M" /
 * "black" / "យក2"). The basic deterministic mode combines only a small, explicit
 * window of recent fragments — it never attempts open-ended semantic reasoning
 * over a whole thread.
 */
import { detectIntent } from "./detect";
import { isFragment, normalizeMessage } from "./normalize";
import type { IntentResult } from "./types";

export interface ContextMessage {
  body: string;
  direction: "inbound" | "outbound" | "system";
  /** ISO timestamp; when absent the message is treated as in-window */
  at?: string;
}

export interface ConversationIntentOptions {
  /** how many trailing inbound fragments may be combined (default 5) */
  maxMessages?: number;
  /** how far back the window may reach, in milliseconds (default 30 minutes) */
  maxAgeMs?: number;
}

export interface ConversationIntentResult extends IntentResult {
  /** the original messages that contributed, oldest first */
  contextWindow: string[];
  /**
   * True when the candidate came from the merchant's own last message that the
   * customer confirmed ("M black 2 មែនទេ?" → "បានបង"). §11.
   */
  derivedFromMerchantMessage: boolean;
}

const DEFAULT_MAX_MESSAGES = 5;
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;

function timeOf(message: ContextMessage): number | undefined {
  if (!message.at) return undefined;
  const value = Date.parse(message.at);
  return Number.isNaN(value) ? undefined : value;
}

/**
 * Detect intent for the latest inbound message, using a bounded window of the
 * fragments that immediately precede it.
 */
export function detectConversationIntent(
  messages: ContextMessage[],
  options: ConversationIntentOptions = {},
): ConversationIntentResult {
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  const latestIndex = findLastIndex(messages, (message) => message.direction === "inbound");
  if (latestIndex === -1) {
    return { ...detectIntent(""), contextWindow: [], derivedFromMerchantMessage: false };
  }

  const latest = messages[latestIndex] as ContextMessage;
  const latestOwn = detectIntent(latest.body);

  // A change of mind is never merged with older fragments — it replaces them.
  if (latestOwn.negated) {
    return { ...latestOwn, contextWindow: [latest.body], derivedFromMerchantMessage: false };
  }

  // §11: a bare confirmation resolves against the merchant's own last message.
  if (isBareConfirmation(latestOwn)) {
    const merchant = lastMerchantCandidate(messages, latestIndex);
    if (merchant) {
      return {
        ...latestOwn,
        items: merchant.items,
        ...(merchant.quantity !== undefined ? { quantity: merchant.quantity } : {}),
        ...(merchant.size !== undefined ? { size: merchant.size } : {}),
        ...(merchant.color !== undefined ? { color: merchant.color } : {}),
        confidence: 0.5,
        band: "medium",
        prepareOrder: true,
        suggestedActions: ["prepare_order"],
        requiresProductResolution: true,
        contextWindow: [latest.body],
        derivedFromMerchantMessage: true,
      };
    }
    return { ...latestOwn, contextWindow: [latest.body], derivedFromMerchantMessage: false };
  }

  // Only fragments are merged; a self-contained message stands on its own.
  if (!isFragment(latestOwn.normalized)) {
    return { ...latestOwn, contextWindow: [latest.body], derivedFromMerchantMessage: false };
  }

  const latestAt = timeOf(latest);
  const window: ContextMessage[] = [latest];

  for (let i = latestIndex - 1; i >= 0 && window.length < maxMessages; i -= 1) {
    const candidate = messages[i];
    if (!candidate || candidate.direction !== "inbound") continue;

    const candidateAt = timeOf(candidate);
    if (latestAt !== undefined && candidateAt !== undefined && latestAt - candidateAt > maxAgeMs) {
      break;
    }

    const normalized = normalizeMessage(candidate.body);
    if (!isFragment(normalized)) break;

    const own = detectIntent(candidate.body);
    // Everything before a cancellation is stale context.
    if (own.negated) break;

    window.unshift(candidate);
  }

  const contextWindow = window.map((message) => message.body);
  if (window.length === 1) {
    return { ...latestOwn, contextWindow, derivedFromMerchantMessage: false };
  }

  const combined = window.map((message) => message.body).join(" ");
  const merged = detectIntent(combined, { fragmentContext: true });

  return {
    ...merged,
    original: latest.body,
    contextWindow,
    derivedFromMerchantMessage: false,
  };
}

function isBareConfirmation(result: IntentResult): boolean {
  return (
    result.intent === "confirmation" &&
    result.items.length === 0 &&
    result.productReference === undefined
  );
}

function lastMerchantCandidate(
  messages: ContextMessage[],
  beforeIndex: number,
): IntentResult | undefined {
  for (let i = beforeIndex - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    if (message.direction === "inbound") continue;
    const result = detectIntent(message.body);
    return result.items.length > 0 ? result : undefined;
  }
  return undefined;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && predicate(item)) return i;
  }
  return -1;
}
