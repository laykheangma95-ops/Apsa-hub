import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How long after Needs Attention starts closing the tiles go back to sizing
 * themselves from the screen. Longer than the collapse (--dur-base, 240ms) so
 * they never resize while the list is still folding away.
 */
export const TILE_RELEASE_MS = 400;

/**
 * Holds Home's Quick Action tiles at their current size while something above
 * them grows.
 *
 * The tiles fill whatever height is left on screen. Opening Needs Attention
 * takes some of that height, which would shrink every tile under the
 * merchant's eyes; instead, `hold()` — called in the tap, before the list
 * opens — measures a tile and pins that size, and the page scrolls. `release()`
 * lets them fit the screen again once the list has closed.
 */
export function useHeldTileSize() {
  const gridRef = useRef<HTMLDivElement>(null);
  const [heldSize, setHeldSize] = useState<number | null>(null);
  const releaseTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(releaseTimer.current), []);

  const hold = useCallback(() => {
    window.clearTimeout(releaseTimer.current);
    const tile = gridRef.current?.querySelector<HTMLElement>("[data-tile]");
    const width = tile?.getBoundingClientRect().width ?? 0;
    if (width > 0) setHeldSize(width);
  }, []);

  const release = useCallback(() => {
    window.clearTimeout(releaseTimer.current);
    releaseTimer.current = window.setTimeout(() => setHeldSize(null), TILE_RELEASE_MS);
  }, []);

  return { gridRef, heldSize, hold, release };
}
