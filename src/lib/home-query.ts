import type { MetricRange } from "@/types";

/**
 * Home data is sensitive tenant data. Principal and organization are part of
 * its cache identity so a sign-out/sign-in or organization change cannot reuse
 * another scope's result. Neither value is trusted by the server for access.
 */
export function homeQueryKey(userId: string, organizationId: string, range: MetricRange) {
  return ["home", "authenticated", userId, organizationId, range] as const;
}
