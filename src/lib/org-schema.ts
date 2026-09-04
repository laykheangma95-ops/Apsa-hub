/**
 * Organization creation contract — shared by the API boundary and the server service.
 *
 * This module is client-safe on purpose: it holds only zod schemas and types, so
 * the API boundary (src/api/org.ts) and the onboarding form can both use it
 * without pulling any server-only module into the browser bundle.
 *
 * Slug validation mirrors the DB constraint organizations_slug_format:
 *   CHECK (slug ~ '^[a-z0-9][a-z0-9\-]{1,61}[a-z0-9]$')
 * It is a format check only — availability is decided exclusively by the DB
 * unique constraint organizations_slug_unique.
 */
import { z } from "zod";

export const slugSchema = z
  .string()
  .min(3, "Slug must be at least 3 characters")
  .max(63, "Slug must be at most 63 characters")
  .regex(
    /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
    "Slug must start and end with a letter or number, and contain only lowercase letters, numbers, and hyphens",
  );

export const CreateOrganizationInputSchema = z.object({
  legalName: z.string().min(1).max(255),
  displayName: z.string().min(1).max(255),
  slug: slugSchema,
  businessType: z.string().max(100).optional(),
  currency: z.enum(["USD", "KHR"]).default("USD"),
});

export type CreateOrganizationInput = z.infer<typeof CreateOrganizationInputSchema>;

export interface CreateOrganizationSuccess {
  ok: true;
  orgId: string;
  slug: string;
}

export type CreateOrganizationResult =
  | CreateOrganizationSuccess
  | { ok: false; code: "unauthenticated" }
  | { ok: false; code: "email_not_verified" }
  | { ok: false; code: "already_member"; orgId: string }
  | { ok: false; code: "slug_taken" }
  | { ok: false; code: "invalid_slug" }
  | { ok: false; code: "invalid_input"; detail: string }
  | { ok: false; code: "internal_error"; message: string };
