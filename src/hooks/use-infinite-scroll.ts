import { useEffect, useRef } from "react";

interface InfiniteScrollOptions {
  /** True while another page exists to fetch. */
  hasMore: boolean;
  /** True while a page is already in flight — prevents duplicate requests. */
  loading: boolean;
  onLoadMore: () => void;
  /** How far below the fold to start fetching. One screen by default. */
  rootMargin?: string;
}

/**
 * Loads the next page as the merchant approaches the end of a list.
 *
 * A "Load more" button is a tap the merchant should never have to spend: on a
 * phone the inbox is scrolled, not paged. The sentinel is placed after the last
 * row and fires once per page, guarded by `loading` so a slow network cannot
 * queue several fetches for the same cursor.
 */
export function useInfiniteScroll({
  hasMore,
  loading,
  onLoadMore,
  rootMargin = "600px",
}: InfiniteScrollOptions) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const callbackRef = useRef(onLoadMore);
  callbackRef.current = onLoadMore;

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || loading) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) callbackRef.current();
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, rootMargin]);

  return sentinelRef;
}
