/**
 * Organization server functions — the real server request boundary for org creation.
 *
 * Route components import this file only. They must NEVER import from
 * @/server/org/create-organization directly — that module contains service-role
 * code that must stay server-side.
 *
 * TanStack Start extracts the handler body into the server bundle.
 * The client bundle receives only the RPC stub.
 */

import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { AUTH_COOKIE } from "./auth";
import type { CreateOrgResult } from "@/server/org/create-organization";

// ── Input type (public — client submits this) ─────────────────────────────────

export interface CreateOrgInput {
  legalName: string;
  slug: string;
  displayName?: string;
  businessType?: string;
  defaultCurrency?: "USD" | "KHR";
  timezone?: string;
}

// ── createOrganizationFn ───────────────────────────────────────────────────────

/**
 * Create an organization for the currently authenticated user.
 *
 * Security guarantees:
 *   - Caller's identity comes from the validated server-side session cookie
 *   - No client-provided userId, roleId, or organizationId is accepted
 *   - OWNER role is assigned by the DB function using the seeded template
 *   - Entire creation is a single DB transaction (migration 009)
 *   - Slug uniqueness enforced by DB constraint — no race condition
 */
export const createOrganizationFn = createServerFn({ method: "POST" })
  .validator((data: unknown): CreateOrgInput => {
    if (!data || typeof data !== "object") throw new Error("Invalid request body");
    const d = data as Record<string, unknown>;

    const legalName = String(d["legalName"] ?? "").trim();
    const slug = String(d["slug"] ?? "")
      .trim()
      .toLowerCase();
    if (!legalName) throw new Error("legalName is required");
    if (!slug) throw new Error("slug is required");

    // Slug format: matches DB constraint  ^[a-z0-9][a-z0-9\-]{1,61}[a-z0-9]$
    // Allow 2-char slugs too (single char slugs are blocked by DB)
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug) || slug.length < 2 || slug.length > 63) {
      throw new Error("slug must be 2–63 lowercase alphanumeric characters and hyphens");
    }

    return {
      legalName,
      slug,
      defaultCurrency:
        d["defaultCurrency"] === "KHR" || d["defaultCurrency"] === "USD"
          ? (d["defaultCurrency"] as "USD" | "KHR")
          : "USD",
      timezone: d["timezone"] ? String(d["timezone"]) : "Asia/Phnom_Penh",
      ...(d["displayName"] ? { displayName: String(d["displayName"]).trim() } : {}),
      ...(d["businessType"] ? { businessType: String(d["businessType"]).trim() } : {}),
    };
  })
  .handler(async ({ data }): Promise<CreateOrgResult> => {
    // ── 1. Validate auth from cookie ─────────────────────────────────────────
    const token = getCookie(AUTH_COOKIE);
    if (!token) {
      return { ok: false, code: "internal_error", message: "Not authenticated" };
    }

    const { createServerClient } = await import("@/lib/supabase/server");
    const client = createServerClient(token);

    const {
      data: { user },
      error,
    } = await client.auth.getUser();

    if (error || !user) {
      return { ok: false, code: "internal_error", message: "Session invalid" };
    }

    // ── 2. Enforce email verification ────────────────────────────────────────
    if (!user.email_confirmed_at) {
      return { ok: false, code: "internal_error", message: "Email not verified" };
    }

    // ── 3. Validate and parse input ──────────────────────────────────────────
    const { createOrganizationSchema, createOrganizationForFounder } = await import(
      "@/server/org/create-organization"
    );

    const parseResult = createOrganizationSchema.safeParse(data);
    if (!parseResult.success) {
      return {
        ok: false,
        code: "internal_error",
        message: parseResult.error.issues.map((i) => i.message).join("; "),
      };
    }

    // ── 4. Execute transactional org creation ────────────────────────────────
    // user.id comes from the validated JWT — never from client input
    return createOrganizationForFounder(user.id, parseResult.data);
  });
