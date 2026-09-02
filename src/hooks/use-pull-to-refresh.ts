import { useCallback, useEffect, useRef, useState } from "react";

const THRESHOLD = 72;
const MAX_PULL = 96;

/**
 * Touch pull-to-refresh for a scrollable list container.
 * Only engages when the container is already scrolled to the top.
 */
export function usePullToRefresh(onRefresh: () => Promise<unknown> | unknown) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const startY = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const run = useCallback(async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
      setPull(0);
    }
  }, [onRefresh]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const onTouchStart = (event: TouchEvent) => {
      if (node.scrollTop > 0 || refreshing) return;
      startY.current = event.touches[0]?.clientY ?? null;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (startY.current === null) return;
      const current = event.touches[0]?.clientY ?? 0;
      const delta = current - startY.current;
      if (delta <= 0) {
        setPull(0);
        return;
      }
      setPull(Math.min(MAX_PULL, delta * 0.5));
    };

    const onTouchEnd = () => {
      if (startY.current === null) return;
      startY.current = null;
      setPull((value) => {
        if (value >= THRESHOLD) void run();
        return value >= THRESHOLD ? value : 0;
      });
    };

    node.addEventListener("touchstart", onTouchStart, { passive: true });
    node.addEventListener("touchmove", onTouchMove, { passive: true });
    node.addEventListener("touchend", onTouchEnd);
    return () => {
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("touchend", onTouchEnd);
    };
  }, [refreshing, run]);

  return { containerRef, pull, refreshing, threshold: THRESHOLD, refresh: run };
}
