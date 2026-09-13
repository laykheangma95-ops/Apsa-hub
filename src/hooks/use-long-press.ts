/**
 * Press-and-hold on a control that also has a normal tap.
 *
 * Used by the bottom bar: tapping Inbox opens Inbox, holding it opens Inbox
 * filtered to unread. The shortcut has to be purely additive — a merchant who
 * has never heard of it must never lose the ordinary tap — so:
 *
 *  - the primary action stays on `onClick`, which is what a keyboard's Enter
 *    and Space fire; holding is a pointer gesture layered over it, never a
 *    replacement for it;
 *  - the hold cancels on real movement, because a scroll that starts on a tab
 *    is a scroll, not a hold;
 *  - the click the platform emits when a fired hold is released is swallowed
 *    exactly once, so one gesture never runs both actions.
 */
import { useCallback, useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

const HOLD_MS = 480;
/** Past this much travel the gesture is a drag, not a hold. */
const MOVE_TOLERANCE_PX = 10;

export interface LongPressHandlers {
  onClick: () => void;
  onPointerDown: (event: ReactPointerEvent) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}

export function useLongPress(
  onLongPress: (() => void) | undefined,
  onPress: () => void,
): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const swallowNextClick = useRef(false);

  const clearTimer = useCallback(() => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    origin.current = null;
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  return {
    onClick: () => {
      if (swallowNextClick.current) {
        swallowNextClick.current = false;
        return;
      }
      onPress();
    },
    onPointerDown: (event) => {
      if (!onLongPress) return;
      origin.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => {
        clearTimer();
        swallowNextClick.current = true;
        onLongPress();
      }, HOLD_MS);
    },
    onPointerMove: (event) => {
      const start = origin.current;
      if (!start) return;
      const travelled =
        Math.abs(event.clientX - start.x) > MOVE_TOLERANCE_PX ||
        Math.abs(event.clientY - start.y) > MOVE_TOLERANCE_PX;
      if (travelled) clearTimer();
    },
    onPointerUp: clearTimer,
    onPointerLeave: clearTimer,
    onPointerCancel: () => {
      clearTimer();
      // A cancelled gesture never fired, so nothing is owed a swallowed click.
      swallowNextClick.current = false;
    },
    /*
     * Holding a control on a touch device raises the platform's own callout
     * menu over the shortcut. Suppressing it is the only way the hold reads as
     * an app gesture rather than a mis-tap.
     */
    onContextMenu: (event) => {
      if (onLongPress) event.preventDefault();
    },
  };
}
