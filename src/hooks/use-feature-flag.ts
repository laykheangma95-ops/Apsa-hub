/**
 * Read a feature flag from a component without breaking hydration.
 *
 * The server has no localStorage, so the server snapshot is always the env
 * baseline. `useSyncExternalStore` renders that baseline for the first client
 * paint too, then re-renders once with the browser's own override if one is
 * set — instead of the silent markup mismatch a bare localStorage read in
 * render would cause.
 */
import { useCallback, useSyncExternalStore } from "react";
import {
  FLAG_CHANGE_EVENT,
  featureFlagBaseline,
  isFeatureEnabled,
  type FeatureFlag,
} from "@/lib/feature-flags";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(FLAG_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(FLAG_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useFeatureFlag(flag: FeatureFlag): boolean {
  const getSnapshot = useCallback(() => isFeatureEnabled(flag), [flag]);
  const getServerSnapshot = useCallback(() => featureFlagBaseline(flag), [flag]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
