import type { ReactNode } from "react";

/**
 * Fail-closed rendering boundary for cached Handoff preview data.
 *
 * `children` is a function so the authorized subtree is not evaluated at all
 * after the current capability snapshot loses `delivery.handoff`, even if
 * React Query still holds a preview fetched while the grant existed.
 */
export function HandoffPreviewAccess({
  allowed,
  denied,
  children,
}: {
  allowed: boolean;
  denied: ReactNode;
  children: () => ReactNode;
}) {
  return <>{allowed ? children() : denied}</>;
}
