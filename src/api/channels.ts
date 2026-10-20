/**
 * Messaging channel server functions — TanStack Start API boundary.
 *
 * Security model (identical to src/api/conversations.ts):
 *   - Session is read from HttpOnly cookies (never trusted from request body).
 *   - Organization is resolved from the user's active DB membership (never from client input).
 *   - Server-only modules are dynamically imported inside handler bodies so
 *     they never enter the client bundle.
 *   - Each service function checks its own permission before any I/O.
 *
 * The bot token travels browser → server exactly once, in connectTelegramBotFn,
 * and is never returned by any function here.
 */
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

  const { AuthorizationService } = await import("@/server/auth/authorization");

  // organization_id is derived from the canonical active membership
  // (src/lib/active-organization.ts), never client input.
  const { resolveActiveOrganizationId } = await import("@/server/auth/active-organization");
  const organizationId = await resolveActiveOrganizationId(session.userId);

  if (!organizationId) {
    const { ForbiddenError } = await import("@/server/auth/authorization");
    throw new ForbiddenError("No active organization membership");
  }

  return AuthorizationService.forRequest(session.userId, organizationId);
}

const expectedPrincipalSchema = z
  .object({ userId: z.string().uuid(), organizationId: z.string().uuid() })
  .strict();

// ── listChannelConnectionsFn ──────────────────────────────────────────────────

export const listChannelConnectionsFn = createServerFn().handler(async () => {
  const authCtx = await resolveAuthContext();
  const { listChannelConnections } = await import("@/server/channels/service");
  return listChannelConnections(authCtx);
});

// ── connectTelegramBotFn ──────────────────────────────────────────────────────

export const connectTelegramBotFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ token: z.string().min(1).max(200) }).parse(data))
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { connectTelegramBot } = await import("@/server/channels/service");
    return connectTelegramBot(authCtx, data.token);
  });

// ── disconnectChannelFn ───────────────────────────────────────────────────────

export const disconnectChannelFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ connectionId: z.string().uuid() }).parse(data))
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { disconnectChannel } = await import("@/server/channels/service");
    return disconnectChannel(authCtx, data.connectionId);
  });

// ── sendConversationReplyFn ───────────────────────────────────────────────────

export const sendConversationReplyFn = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        conversationId: z.string().uuid("Invalid conversation ID"),
        clientMessageId: z.string().uuid(),
        body: z.string().min(1).max(4096),
        expectedPrincipal: expectedPrincipalSchema,
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { sendConversationReply } = await import("@/server/channels/service");
    return sendConversationReply(authCtx, data);
  });
