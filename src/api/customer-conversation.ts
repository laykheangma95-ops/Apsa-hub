/**
 * Customer → Conversation linkage server function.
 *
 * Lightweight lookup: given a customer ID, returns the most recent
 * conversation ID within the caller's organization — or null when none
 * exists. Used by surfaces that already have a customer ID (Parcel
 * Investigation, Order Detail) and need to offer "Open Conversation"
 * without fetching the full Customer 360 payload.
 *
 * Security:
 *   - Session from HttpOnly cookies; organization from active membership.
 *   - Requires both customers.read and messages.read.
 *   - Organization-scoped: a customer in Org A has no conversation in Org B.
 *   - Customer ownership verified before conversation lookup.
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
  const { resolveActiveOrganizationId } = await import("@/server/auth/active-organization");
  const organizationId = await resolveActiveOrganizationId(session.userId);

  if (!organizationId) {
    const { ForbiddenError } = await import("@/server/auth/authorization");
    throw new ForbiddenError("No active organization membership");
  }

  return AuthorizationService.forRequest(session.userId, organizationId);
}

export const findCustomerConversationFn = createServerFn()
  .validator((data: unknown) =>
    z.object({ customerId: z.string().uuid("Invalid customer ID") }).parse(data),
  )
  .handler(async ({ data }): Promise<{ conversationId: string | null }> => {
    const authCtx = await resolveAuthContext();
    authCtx.require("customers.read");
    authCtx.require("messages.read");

    const customerRepo = await import("@/server/customers/repository");
    const customer = await customerRepo.findCustomerById(authCtx.organizationId, data.customerId);
    if (!customer) return { conversationId: null };

    const { findActiveConversationIdByCustomer } = await import(
      "@/server/conversations/repository"
    );
    const conversationId = await findActiveConversationIdByCustomer(
      authCtx.organizationId,
      data.customerId,
    );

    return { conversationId };
  });
