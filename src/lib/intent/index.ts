/**
 * Cambodia-first commerce intent detection.
 *
 * Deterministic, provider-free, and safe by default: the engine suggests, a
 * merchant decides. It never creates orders, never touches money, and never
 * rewrites what the customer wrote.
 */
export { detectIntent, CONFIDENCE, type DetectOptions } from "./detect";
export {
  detectConversationIntent,
  type ContextMessage,
  type ConversationIntentOptions,
  type ConversationIntentResult,
} from "./context";
export {
  resolveAgainstCatalog,
  catalogAttributes,
  type CatalogAttributes,
  type ResolvedItem,
} from "./catalog";
export { normalizeMessage, isFragment, khmerDigitsToArabic } from "./normalize";
export { scan, findPhoneSpans, lexiconEntry, type ScanOptions } from "./scan";
export { groupItems } from "./items";
export { LEXICON, type LexiconEntry } from "./lexicon";
export type {
  ConfidenceBand,
  IntentResult,
  IntentToken,
  LineItemCandidate,
  PrimaryIntent,
  ProductReference,
  SignalKind,
  SuggestedActionId,
} from "./types";
