/**
 * Conversation domain server functions — TanStack Start API boundary.
 *
 * Security model (identical to src/api/customers.ts, src/api/orders.ts):
 *   - Session is read from HttpOnly cookies (never trusted from request body).
 *   - Organization is resolved from the user's active DB membership (never from client input).
 *   - All server-only modules (@/lib/supabase/server, @/server/conversations/*)
 *     are dynamically imported inside handler bodies so they never enter the client bundle.
 *   - Every handler requires an active session AND a messages.* permission before touching data.
 *
 * Usage from components: import these functions and call them directly —
 * TanStack Start routes them to the server automatically. In practice, UI
 * code should go through src/lib/api/index.ts's isProductionId-gated wrappers
 * rather than importing this module directly (see that file's own comments).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSessionFn } from "@/api/auth";
import type { AuthorizationContext } from "@/server/auth/authorization";

// ── Internal helper: resolve session + organization ────────────────────────────
// organizationId is NEVER accepted from the caller — always derived from DB membership.

async function resolveAuthContext(): Promise<AuthorizationContext> {
  const session = await getSessionFn();
  if (!session || !session.emailVerified) {
    const { UnauthorizedError } = await import("@/server/auth/authorization");
    throw new UnauthorizedError("Not authenticated");
  }

  const { supabaseAdmin } = await import("@/lib/supabase/server");
  const { AuthorizationService } = await import("@/server/auth/authorization");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rawMembership } = await (supabaseAdmin as any)
    .from("memberships")
    .select("organization_id")
    .eq("user_id", session.userId)
    .eq("status", "active")
    .order("joined_at", { ascending: false })
    .limit(1)
    .single();

  if (!rawMembership) {
    const { ForbiddenError } = await import("@/server/auth/authorization");
    throw new ForbiddenError("No active organization membership");
  }

  const membership = rawMembership as { organization_id: string };
  return AuthorizationService.forRequest(session.userId, membership.organization_id);
}

const CONVERSATION_STATUS_VALUES = [
  "unread",
  "needs_reply",
  "follow_up",
  "waiting_customer",
  "order_created",
  "closed",
] as const;

const CHANNEL_VALUES = ["facebook", "instagram", "telegram", "pos"] as const;

// ── listConversationsFn ────────────────────────────────────────────────────────

export const listConversationsFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        status: z.enum([...CONVERSATION_STATUS_VALUES, "all"]).optional(),
        channel: z.enum([...CHANNEL_VALUES, "all"]).optional(),
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().max(500).optional(),
      })
      .optional()
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { listConversations } = await import("@/server/conversations/service");
    const input: Parameters<typeof listConversations>[1] = {};
    if (data?.status !== undefined) input.status = data.status;
    if (data?.channel !== undefined) input.channel = data.channel;
    if (data?.query !== undefined) input.query = data.query;
    if (data?.limit !== undefined) input.limit = data.limit;
    if (data?.cursor !== undefined) input.cursor = data.cursor;
    return listConversations(authCtx, input);
  });

// ── listConversationCountsFn ───────────────────────────────────────────────────

export const listConversationCountsFn = createServerFn().handler(async () => {
  const authCtx = await resolveAuthContext();
  const { listConversationCounts } = await import("@/server/conversations/service");
  return listConversationCounts(authCtx);
});

// ── getConversationDetailFn ────────────────────────────────────────────────────

export const getConversationDetailFn = createServerFn()
  .validator((data: unknown) =>
    z.object({ conversationId: z.string().uuid("Invalid conversation ID") }).parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { getConversationDetail } = await import("@/server/conversations/service");
    return getConversationDetail(authCtx, data.conversationId);
  });

// ── listConversationMessagesFn ─────────────────────────────────────────────────

export const listConversationMessagesFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        conversationId: z.string().uuid("Invalid conversation ID"),
        beforeId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { listConversationMessages } = await import("@/server/conversations/service");
    const input: Parameters<typeof listConversationMessages>[2] = {};
    if (data.beforeId !== undefined) input.beforeId = data.beforeId;
    if (data.limit !== undefined) input.limit = data.limit;
    return listConversationMessages(authCtx, data.conversationId, input);
  });

// ── markConversationReadFn ─────────────────────────────────────────────────────

export const markConversationReadFn = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        conversationId: z.string().uuid("Invalid conversation ID"),
        messageId: z.string().uuid(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { markConversationRead } = await import("@/server/conversations/service");
    return markConversationRead(authCtx, data.conversationId, data.messageId);
  });

// ── updateConversationStatusFn ─────────────────────────────────────────────────

export const updateConversationStatusFn = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        conversationId: z.string().uuid("Invalid conversation ID"),
        status: z.enum(CONVERSATION_STATUS_VALUES),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { updateConversationStatus } = await import("@/server/conversations/service");
    return updateConversationStatus(authCtx, data.conversationId, data.status);
  });

// ── assignConversationFn ───────────────────────────────────────────────────────

export const assignConversationFn = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        conversationId: z.string().uuid("Invalid conversation ID"),
        assignedUserId: z.string().uuid().nullable(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { assignConversation } = await import("@/server/conversations/service");
    return assignConversation(authCtx, data.conversationId, data.assignedUserId);
  });
