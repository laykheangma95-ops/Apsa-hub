/**
 * Component-side access to tab memory (src/lib/tab-memory.ts).
 *
 * `useTabState` is a drop-in for `useState` on anything a merchant would be
 * annoyed to lose when they glance at another tab: a filter, a search box, a
 * selected segment. `useTabScrollMemory` does the same for how far down a list
 * they had read.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AppNavTabId } from "@/design-system/app-nav-config";
import { readTabState, recallTabScroll, rememberTabScroll, writeTabState } from "@/lib/tab-memory";

/**
 * `useState`, but the value survives leaving the tab and coming back.
 *
 * The initial value is only consulted the first time this tab meets this key;
 * afterwards the remembered value wins. Keys are scoped per tab, so Inbox's
 * "status" and Sales' "status" never collide.
 */
export function useTabState<T>(tab: AppNavTabId, key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const remembered = readTabState<T>(tab, key);
    return remembered === undefined ? initial : remembered;
  });

  const set = useCallback(
    (next: T) => {
      writeTabState(tab, key, next);
      setValue(next);
    },
    [tab, key],
  );

  return [value, set];
}

/**
 * Restore a tab root's scroll position on entry and record it on the way out.
 *
 * Pass a ref when the screen scrolls inside its own pane (Inbox does); omit it
 * for the ordinary case where the window scrolls. Restoration happens in a
 * layout-safe frame after mount, so it runs once the restored list has
 * actually been laid out rather than against a zero-height skeleton.
 */
export function useTabScrollMemory<T extends HTMLElement>(
  tab: AppNavTabId,
  ref?: RefObject<T | null>,
  /** Skip restoration while the list is still loading its first page. */
  ready = true,
): void {
  const restored = useRef(false);

  useEffect(() => {
    const target = ref?.current ?? null;
    const read = () => (target ? target.scrollTop : window.scrollY);
    const write = (top: number) => {
      if (target) target.scrollTop = top;
      else window.scrollTo(0, top);
    };

    if (!restored.current && ready) {
      const top = recallTabScroll(tab);
      restored.current = true;
      if (top > 0) {
        const frame = requestAnimationFrame(() => write(top));
        // Cancelling matters: an unmount before paint would otherwise scroll
        // whatever screen replaced this one.
        return () => cancelAnimationFrame(frame);
      }
    }
    return undefined;
  }, [tab, ref, ready]);

  useEffect(() => {
    const target = ref?.current ?? null;
    const node: HTMLElement | Window = target ?? window;
    const onScroll = () => {
      rememberTabScroll(tab, target ? target.scrollTop : window.scrollY);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      onScroll();
      node.removeEventListener("scroll", onScroll);
    };
  }, [tab, ref]);
}
