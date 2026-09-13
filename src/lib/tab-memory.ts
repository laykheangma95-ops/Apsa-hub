import type { AppNavTabId } from "@/design-system/app-nav-config";

/**
 * What each tab was doing when the merchant left it.
 *
 * Switching tabs unmounts the route underneath, so anything a screen kept in
 * `useState` — the status filter, the search text, how far down the list they
 * had read — is gone by the time they come back. On a phone that is the
 * difference between "I'll check the other thing for a second" and "I lost my
 * place", and it is the single most-felt thing about WeChat's and Taobao's
 * bars: you leave a tab and it is exactly where you left it.
 *
 * This module is that memory, and nothing else. It holds presentation state
 * only: paths, scroll offsets, filter selections. No records, no money, no
 * customer data — a merchant's *place*, not their business.
 */
export interface TabMemoryEntry {
  /**
   * The last location visited inside this tab — path AND query string, detail
   * screens included. The query string matters: a filter that is deep-linkable
   * lives in the URL, so remembering the path alone would bring a merchant
   * back to Inbox with their "unread only" filter silently dropped.
   */
  href?: string;
  /** Scroll offset of the tab root, in px. */
  scrollTop?: number;
  /** Per-screen UI state (filters, search text, open segment). */
  state?: Record<string, unknown>;
}

const MEMORY = new Map<AppNavTabId, TabMemoryEntry>();

/**
 * The principal this memory belongs to.
 *
 * One browser tab can serve more than one person: sign out, sign in as
 * somebody else, or switch organization, all without a reload. A remembered
 * search string ("Sokha") or a remembered path (/app/orders/<uuid>) is the
 * previous principal's context, so the memory is dropped whole the moment the
 * principal changes rather than carried across.
 */
let currentPrincipal: string | undefined;

export function clearTabMemory(): void {
  MEMORY.clear();
}

/**
 * Drop everything when the signed-in principal or active organization changes.
 *
 * Both values must come from the server-derived /app route context. They
 * partition a cache; they authorize nothing.
 */
export function enforceTabMemoryPrincipal(userId: string, organizationId: string): void {
  // "/" cannot appear in a UUID, so no two principals collide on this string.
  const principal = `${userId}/${organizationId}`;
  if (currentPrincipal === principal) return;
  clearTabMemory();
  currentPrincipal = principal;
}

function entry(tab: AppNavTabId): TabMemoryEntry {
  const existing = MEMORY.get(tab);
  if (existing) return existing;
  const created: TabMemoryEntry = {};
  MEMORY.set(tab, created);
  return created;
}

export function rememberTabPath(tab: AppNavTabId, href: string): void {
  entry(tab).href = href;
}

export function recallTabPath(tab: AppNavTabId): string | undefined {
  return MEMORY.get(tab)?.href;
}

export function rememberTabScroll(tab: AppNavTabId, scrollTop: number): void {
  entry(tab).scrollTop = scrollTop;
}

export function recallTabScroll(tab: AppNavTabId): number {
  return MEMORY.get(tab)?.scrollTop ?? 0;
}

export function readTabState<T>(tab: AppNavTabId, key: string): T | undefined {
  return MEMORY.get(tab)?.state?.[key] as T | undefined;
}

export function writeTabState<T>(tab: AppNavTabId, key: string, value: T): void {
  const target = entry(tab);
  target.state = { ...(target.state ?? {}), [key]: value };
}
