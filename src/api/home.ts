/** Browser-safe, authenticated command-center read boundary. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSessionFn } from "@/api/auth";
import type { AuthorizationContext } from "@/server/auth/authorization";

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

export const getHomeSummaryFn = createServerFn()
  .validator((data: unknown) =>
    z.object({ range: z.enum(["today", "week", "month"]).default("today") }).parse(data),
  )
  .handler(async ({ data }) => {
    const ctx = await resolveAuthContext();
    const { getHomeSummary } = await import("@/server/home/service");
    return getHomeSummary(ctx, data.range);
  });
