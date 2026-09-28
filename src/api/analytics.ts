/**
 * Browser-safe, authenticated Analytics read boundary.
 *
 * No UI route calls these yet — this phase ships the server foundation only
 * (see src/server/analytics/service.ts). Identical security posture to
 * src/api/home.ts: session from HttpOnly cookies, organization resolved from
 * the caller's own active DB membership, never from client input.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSessionFn } from "@/api/auth";
import type { AuthorizationContext } from "@/server/auth/authorization";

const rangeSchema = z.object({ range: z.enum(["today", "week", "month"]).default("today") });

async function resolveAuthContext(): Promise<AuthorizationContext> {
  const session = await getSessionFn();
  if (!session || !session.emailVerified) {
    const { UnauthorizedError } = await import("@/server/auth/authorization");
    throw new UnauthorizedError("Not authenticated");
  }
  const { AuthorizationService, ForbiddenError } = await import("@/server/auth/authorization");
  // organization_id is derived from the canonical active membership
  // (src/lib/active-organization.ts), never client input.
  const { resolveActiveOrganizationId } = await import("@/server/auth/active-organization");
  const organizationId = await resolveActiveOrganizationId(session.userId);
  if (!organizationId) throw new ForbiddenError("No active organization membership");
  return AuthorizationService.forRequest(session.userId, organizationId);
}

export const getBusinessSummaryFn = createServerFn()
  .validator((data: unknown) => rangeSchema.parse(data))
  .handler(async ({ data }) => {
    const ctx = await resolveAuthContext();
    const { getBusinessSummary } = await import("@/server/analytics/service");
    return getBusinessSummary(ctx, data.range);
  });

export const getTopSellingItemsFn = createServerFn()
  .validator((data: unknown) =>
    rangeSchema.extend({ limit: z.number().int().min(1).max(100).optional() }).parse(data),
  )
  .handler(async ({ data }) => {
    const ctx = await resolveAuthContext();
    const { getTopSellingItems } = await import("@/server/analytics/service");
    return getTopSellingItems(ctx, data.range, data.limit);
  });

export const getCustomerSummaryFn = createServerFn()
  .validator((data: unknown) => rangeSchema.parse(data))
  .handler(async ({ data }) => {
    const ctx = await resolveAuthContext();
    const { getCustomerSummary } = await import("@/server/analytics/service");
    return getCustomerSummary(ctx, data.range);
  });
