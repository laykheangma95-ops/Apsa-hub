/**
 * Reserved operational history reasons.
 *
 * Some history reasons are markers that trusted server workflows write and
 * other workflows read back as fact (e.g. Pack Order's packed marker decides
 * whether an order is packed). A generic status-transition API that accepts a
 * free-text reason must never let a caller write one of these, or the fact
 * could be forged. Generic APIs reject any reason this function flags; only the
 * owning service writes the marker through the repository directly.
 */
import { PACK_ORDER_PACKED_REASON_CODE } from "@/lib/pack";
import { COURIER_HANDOFF_CONFIRMED_REASON_CODE } from "@/lib/handoff";

const RESERVED_OPERATIONAL_REASONS: ReadonlySet<string> = new Set([
  PACK_ORDER_PACKED_REASON_CODE,
  COURIER_HANDOFF_CONFIRMED_REASON_CODE,
]);

/** The `system:` namespace is reserved for server-written reason codes. */
const RESERVED_REASON_PREFIX = "system:";

/**
 * True when a caller-supplied reason would collide with a reserved marker.
 * Compared trimmed and case-insensitively so whitespace or casing cannot slip
 * a marker past the check (the delivery RPC trims reasons before storing).
 */
export function isReservedOperationalReason(reason: string | null | undefined): boolean {
  if (reason == null) return false;
  const normalized = reason.trim().toLowerCase();
  if (normalized === "") return false;
  return (
    RESERVED_OPERATIONAL_REASONS.has(normalized) || normalized.startsWith(RESERVED_REASON_PREFIX)
  );
}
