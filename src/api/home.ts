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
  const { supabaseAdmin } = await import("@/lib/supabase/server");
  const { AuthorizationService, ForbiddenError } = await import("@/server/auth/authorization");
  // organization_id is derived from active membership, never client input.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabaseAdmin as any)
    .from("memberships")
    .select("organization_id")
    .eq("user_id", session.userId)
    .eq("status", "active")
    .order("joined_at", { ascending: false })
    .limit(1)
    .single();
  if (!data) throw new ForbiddenError("No active organization membership");
  return AuthorizationService.forRequest(
    session.userId,
    (data as { organization_id: string }).organization_id,
  );
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
