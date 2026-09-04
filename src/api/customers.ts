/**
 * Customer domain server functions — TanStack Start API boundary.
 *
 * Security model:
 *   - Session is read from HttpOnly cookies (never trusted from request body).
 *   - Organization is resolved from the user's active DB membership (never from client input).
 *   - All server-only modules (@/lib/supabase/server, @/server/customers/*)
 *     are dynamically imported inside handler bodies so they never enter the client bundle.
 *   - Every handler requires an active session AND a customers.* permission before touching data.
 *
 * Usage from components: import these functions and call them directly —
 * TanStack Start routes them to the server automatically.
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

// ── getCustomer360Fn ───────────────────────────────────────────────────────────

export const getCustomer360Fn = createServerFn()
  .validator((data: unknown) =>
    z.object({ id: z.string().uuid("Invalid customer ID") }).parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { getCustomer360 } = await import("@/server/customers/service");
    return getCustomer360(authCtx, data.id);
  });

// ── addCustomerNoteFn ──────────────────────────────────────────────────────────

export const addCustomerNoteFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        customerId: z.string().uuid("Invalid customer ID"),
        body: z.string().min(1, "Note body cannot be empty").max(5000),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { addCustomerNote } = await import("@/server/customers/service");
    return addCustomerNote(authCtx, data.customerId, data.body);
  });

// ── listCustomersFn ────────────────────────────────────────────────────────────

export const listCustomersFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
        status: z.enum(["active", "archived"]).optional(),
      })
      .optional()
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { listCustomers } = await import("@/server/customers/service");
    const opts: { limit?: number; offset?: number; status?: "active" | "archived" } = {};
    if (data?.limit !== undefined) opts.limit = data.limit;
    if (data?.offset !== undefined) opts.offset = data.offset;
    if (data?.status !== undefined) opts.status = data.status;
    return listCustomers(authCtx, opts);
  });

// ── createCustomerFn ───────────────────────────────────────────────────────────

export const createCustomerFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        display_name: z.string().min(1).max(200),
        primary_phone: z.string().max(30).nullish(),
        primary_email: z.string().email().nullish(),
        language: z.string().max(10).nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { createCustomer } = await import("@/server/customers/service");
    const input: {
      display_name: string;
      primary_phone?: string | null;
      primary_email?: string | null;
      language?: string | null;
    } = { display_name: data.display_name };
    if (data.primary_phone !== undefined) input.primary_phone = data.primary_phone ?? null;
    if (data.primary_email !== undefined) input.primary_email = data.primary_email ?? null;
    if (data.language !== undefined) input.language = data.language ?? null;
    return createCustomer(authCtx, input);
  });

// ── updateCustomerFn ───────────────────────────────────────────────────────────

export const updateCustomerFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        customerId: z.string().uuid("Invalid customer ID"),
        display_name: z.string().min(1).max(200).optional(),
        primary_phone: z.string().max(30).nullish(),
        primary_email: z.string().email().nullish(),
        language: z.string().max(10).nullish(),
        status: z.enum(["active", "archived"]).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { updateCustomer } = await import("@/server/customers/service");
    const { customerId, ...rest } = data;
    const patch: Partial<{
      display_name: string;
      primary_phone: string | null;
      primary_email: string | null;
      language: string | null;
      status: "active" | "archived";
    }> = {};
    if (rest.display_name !== undefined) patch.display_name = rest.display_name;
    if (rest.primary_phone !== undefined) patch.primary_phone = rest.primary_phone ?? null;
    if (rest.primary_email !== undefined) patch.primary_email = rest.primary_email ?? null;
    if (rest.language !== undefined) patch.language = rest.language ?? null;
    if (rest.status !== undefined) patch.status = rest.status;
    return updateCustomer(authCtx, customerId, patch);
  });

// ── addIdentityFn ──────────────────────────────────────────────────────────────

export const addIdentityFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        customerId: z.string().uuid("Invalid customer ID"),
        provider: z.enum([
          "FACEBOOK",
          "INSTAGRAM",
          "TELEGRAM",
          "TIKTOK",
          "PHONE",
          "EMAIL",
          "APSA_CONSUMER",
          "MINI_STORE",
        ]),
        provider_user_id: z.string().min(1).max(500),
        handle: z.string().max(200).nullish(),
        display_name: z.string().max(200).nullish(),
        confidence: z.number().int().min(0).max(100).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { addIdentityToCustomer } = await import("@/server/customers/service");
    const { customerId, ...rest } = data;
    const input: {
      provider: string;
      provider_user_id: string;
      handle?: string | null;
      display_name?: string | null;
      confidence?: number;
    } = { provider: rest.provider, provider_user_id: rest.provider_user_id };
    if (rest.handle !== undefined) input.handle = rest.handle ?? null;
    if (rest.display_name !== undefined) input.display_name = rest.display_name ?? null;
    if (rest.confidence !== undefined) input.confidence = rest.confidence;
    // Return as plain object to satisfy serialization check
    const row = await addIdentityToCustomer(authCtx, customerId, input);
    return {
      id: row.id,
      organization_id: row.organization_id,
      customer_id: row.customer_id,
      provider: row.provider,
      provider_user_id: row.provider_user_id,
      handle: row.handle,
      display_name: row.display_name,
      confidence: row.confidence,
      verified_at: row.verified_at,
      created_at: row.created_at,
    };
  });
