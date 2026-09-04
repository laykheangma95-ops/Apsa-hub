/**
 * Customer service — business logic layer.
 *
 * All public functions:
 *   1. Accept an AuthorizationContext (server-verified user + org).
 *   2. Check the required permission before touching the DB.
 *   3. Delegate raw DB operations to the repository.
 *   4. Map DB rows to domain/API shapes.
 *
 * Authorization context carries:
 *   ctx.userId         — from validated JWT
 *   ctx.organizationId — from active DB membership (never from client)
 *
 * Never import this file from browser-bundled code.
 */
import type { AuthorizationContext } from "@/server/auth/authorization";
import { auditLogRequired } from "@/server/auth/audit";
import * as repo from "./repository";
import type { CustomerRow, CustomerIdentityRow, CustomerAddressRow } from "./types";
import type { Channel, CompanionColor, Address, Money, SocialIdentity } from "@/types";

// ── Provider → Channel mapping ────────────────────────────────────────────────

const PROVIDER_TO_CHANNEL: Record<string, Channel | undefined> = {
  FACEBOOK: "facebook",
  INSTAGRAM: "instagram",
  TELEGRAM: "telegram",
};

// ── Companion color derivation (deterministic, UI-only) ───────────────────────

const COMPANIONS: CompanionColor[] = ["nilo", "minto", "vela", "suri", "luma"];

function deriveCompanion(customerId: string): CompanionColor {
  const sum = customerId
    .slice(-12)
    .split("")
    .reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return COMPANIONS[sum % COMPANIONS.length]!;
}

// ── Domain shape builders ─────────────────────────────────────────────────────

function toSocialIdentities(rows: CustomerIdentityRow[]): SocialIdentity[] {
  const result: SocialIdentity[] = [];
  for (const row of rows) {
    const channel = PROVIDER_TO_CHANNEL[row.provider];
    if (!channel) continue;
    result.push({ channel, handle: row.handle ?? row.provider_user_id });
  }
  return result;
}

function toAddress(row: CustomerAddressRow): Address {
  return {
    houseNo: row.house_no ?? "",
    street: row.street ?? "",
    sangkat: row.sangkat ?? "",
    khan: row.khan ?? "",
    city: row.city ?? "",
    ...(row.landmark ? { landmark: row.landmark } : {}),
  };
}

// ── Customer 360 shape ────────────────────────────────────────────────────────

export interface CustomerProfile {
  id: string;
  nameKm: string;
  nameEn: string;
  phone: string;
  identities: SocialIdentity[];
  tags: string[];
  address?: Address;
  orderCount: number;
  lifetimeSpend: Money;
  lastPurchaseAt?: string;
  companion: CompanionColor;
}

export interface CustomerNote {
  id: string;
  customerId: string;
  body: string;
  staffName: string;
  at: string;
}

export interface Customer360Result {
  customer: CustomerProfile;
  notes: CustomerNote[];
  /** Orders and events remain empty until their domains are productionized. */
  orders: never[];
  events: never[];
  activeConversationId: null;
}

// ── Service functions ─────────────────────────────────────────────────────────

export async function getCustomer360(
  ctx: AuthorizationContext,
  customerId: string,
): Promise<Customer360Result> {
  ctx.require("customers.read");

  const [customer, identities, addresses, tags, rawNotes] = await Promise.all([
    repo.findCustomerById(ctx.organizationId, customerId),
    repo.findIdentitiesByCustomer(ctx.organizationId, customerId),
    repo.findAddressesByCustomer(ctx.organizationId, customerId),
    repo.findTagsByCustomer(ctx.organizationId, customerId),
    repo.findNotesByCustomer(ctx.organizationId, customerId),
  ]);

  if (!customer) {
    throw Object.assign(new Error("Customer not found"), { statusCode: 404 });
  }

  // Use the default address if present.
  const defaultAddress = addresses.find((a) => a.is_default) ?? addresses[0];

  const profile: CustomerProfile = {
    id: customer.id,
    nameKm: customer.display_name,
    nameEn: customer.display_name,
    phone: customer.primary_phone ?? "",
    identities: toSocialIdentities(identities),
    tags: tags.map((t) => t.name),
    ...(defaultAddress ? { address: toAddress(defaultAddress) } : {}),
    orderCount: 0,
    lifetimeSpend: { amount: 0, currency: "USD" },
    companion: deriveCompanion(customer.id),
  };

  const notes: CustomerNote[] = rawNotes.map((n) => ({
    id: n.id,
    customerId: n.customer_id,
    body: n.body,
    staffName: n.author_display_name ?? "Staff",
    at: n.created_at,
  }));

  return {
    customer: profile,
    notes,
    orders: [],
    events: [],
    activeConversationId: null,
  };
}

export async function listCustomers(
  ctx: AuthorizationContext,
  opts: { limit?: number; offset?: number; status?: "active" | "archived" } = {},
): Promise<CustomerRow[]> {
  ctx.require("customers.read");
  return repo.listCustomers(ctx.organizationId, opts);
}

export async function createCustomer(
  ctx: AuthorizationContext,
  input: {
    display_name: string;
    primary_phone?: string | null;
    primary_email?: string | null;
    language?: string | null;
  },
): Promise<CustomerRow> {
  ctx.require("customers.create");

  if (!input.display_name || !input.display_name.trim()) {
    throw Object.assign(new Error("display_name is required"), { statusCode: 400 });
  }

  const customer = await repo.createCustomer(ctx.organizationId, {
    ...input,
    display_name: input.display_name.trim(),
  });

  return customer;
}

export async function updateCustomer(
  ctx: AuthorizationContext,
  customerId: string,
  patch: Partial<{
    display_name: string;
    primary_phone: string | null;
    primary_email: string | null;
    language: string | null;
    status: "active" | "archived";
  }>,
): Promise<CustomerRow> {
  ctx.require("customers.update_basic");

  if (patch.status === "archived") {
    ctx.require("customers.archive");
  }

  if (patch.display_name !== undefined && !patch.display_name?.trim()) {
    throw Object.assign(new Error("display_name cannot be empty"), { statusCode: 400 });
  }

  const updated = await repo.updateCustomer(ctx.organizationId, customerId, patch);
  if (!updated) {
    throw Object.assign(new Error("Customer not found"), { statusCode: 404 });
  }

  return updated;
}

export async function addCustomerNote(
  ctx: AuthorizationContext,
  customerId: string,
  body: string,
): Promise<CustomerNote> {
  ctx.require("customers.add_note");

  const trimmed = body.trim();
  if (!trimmed) {
    throw Object.assign(new Error("Note body cannot be empty"), { statusCode: 400 });
  }

  // Verify the customer belongs to this org before inserting.
  const customer = await repo.findCustomerById(ctx.organizationId, customerId);
  if (!customer) {
    throw Object.assign(new Error("Customer not found"), { statusCode: 404 });
  }

  const note = await repo.createCustomerNote(
    ctx.organizationId,
    customerId,
    ctx.userId,
    trimmed,
  );

  return {
    id: note.id,
    customerId: note.customer_id,
    body: note.body,
    staffName: note.author_display_name ?? "Staff",
    at: note.created_at,
  };
}

export async function addIdentityToCustomer(
  ctx: AuthorizationContext,
  customerId: string,
  input: {
    provider: string;
    provider_user_id: string;
    handle?: string | null;
    display_name?: string | null;
    identity_metadata?: Record<string, unknown> | null;
    confidence?: number;
  },
): Promise<CustomerIdentityRow> {
  ctx.require("customers.update_basic");

  const customer = await repo.findCustomerById(ctx.organizationId, customerId);
  if (!customer) {
    throw Object.assign(new Error("Customer not found"), { statusCode: 404 });
  }

  return repo.addCustomerIdentity(ctx.organizationId, customerId, input);
}

export async function exportCustomers(
  ctx: AuthorizationContext,
): Promise<CustomerRow[]> {
  ctx.require("customers.export");

  // Mandatory audit — blocks the export if the audit record fails to persist.
  await auditLogRequired(ctx, {
    action: "customers.export",
    resourceType: "customers",
    reason: "bulk export",
  });

  return repo.listCustomers(ctx.organizationId, { status: "active" });
}
