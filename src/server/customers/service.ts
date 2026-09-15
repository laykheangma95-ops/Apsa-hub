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
import {
  CUSTOMER_SEARCH_MAX_QUERY_LENGTH,
  escapeLikePattern,
  looksLikeCustomerPhoneQuery,
  normalizeCustomerNameQuery,
  phoneDigitsMatch,
} from "@/lib/customer-search";
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
  /** Empty string when caller lacks customers.view_sensitive. */
  phone: string;
  identities: SocialIdentity[];
  tags: string[];
  /** Absent when caller lacks customers.view_sensitive. */
  address?: Address;
  orderCount: number;
  lifetimeSpend: Money;
  lastPurchaseAt?: string;
  companion: CompanionColor;
  /** Server-authoritative sensitive-field visibility flag. */
  sensitiveVisible: boolean;
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

  // Sensitive fields (phone, address) are only returned to callers with customers.view_sensitive.
  // This is the server-side enforcement — UI checks sensitiveVisible, never trusts a client role.
  const sensitiveVisible = ctx.can("customers.view_sensitive");

  // Use the default address if present and the caller has sensitive access.
  const defaultAddress = sensitiveVisible
    ? (addresses.find((a) => a.is_default) ?? addresses[0])
    : undefined;

  const profile: CustomerProfile = {
    id: customer.id,
    nameKm: customer.display_name,
    nameEn: customer.display_name,
    phone: sensitiveVisible ? (customer.primary_phone ?? "") : "",
    identities: toSocialIdentities(identities),
    tags: tags.map((t) => t.name),
    ...(defaultAddress ? { address: toAddress(defaultAddress) } : {}),
    orderCount: 0,
    lifetimeSpend: { amount: 0, currency: "USD" },
    companion: deriveCompanion(customer.id),
    sensitiveVisible,
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

/**
 * Lightweight, PII-gated row for list contexts (e.g. an order-create customer
 * picker) that need a name and an id but not the full Customer 360 profile.
 *
 * Same gating rule as CustomerProfile above: phone is only ever populated for
 * a caller holding customers.view_sensitive. This is enforced HERE, not in the
 * UI — a browser role check would not be authorization (ARCHITECTURE.md:
 * "Service/application layer is authoritative for authorization").
 */
export interface CustomerListItem {
  id: string;
  nameKm: string;
  nameEn: string;
  /** "" when the caller lacks customers.view_sensitive, or when none is on file. */
  phone: string;
  status: CustomerRow["status"];
  /** Server-authoritative sensitive-field visibility flag — same meaning as CustomerProfile's. */
  sensitiveVisible: boolean;
}

/** Pure mapper — kept separate from the DB call so the gating rule is unit-testable without a DB. */
export function toCustomerListItem(row: CustomerRow, sensitiveVisible: boolean): CustomerListItem {
  return {
    id: row.id,
    nameKm: row.display_name,
    nameEn: row.display_name,
    phone: sensitiveVisible ? (row.primary_phone ?? "") : "",
    status: row.status,
    sensitiveVisible,
  };
}

export async function listCustomers(
  ctx: AuthorizationContext,
  opts: { limit?: number; offset?: number; status?: "active" | "archived" } = {},
): Promise<CustomerListItem[]> {
  ctx.require("customers.read");
  const rows = await repo.listCustomers(ctx.organizationId, opts);
  const sensitiveVisible = ctx.can("customers.view_sensitive");
  return rows.map((row) => toCustomerListItem(row, sensitiveVisible));
}

// ── Search ────────────────────────────────────────────────────────────────────

/** Which column the server actually matched on. `null` when nothing was searched. */
export type CustomerSearchField = "name" | "phone";

/**
 * One truthful page of a customer search.
 *
 * Four different negative answers are kept apart all the way to the screen,
 * because collapsing any of them into "no customer" is how a staff member
 * tells a caller they are not a customer when they are:
 *
 *   EMPTY        items: [], field set, denied false  — the search ran and
 *                matched nothing.
 *   DENIED       phoneSearchDenied: true             — the query was a phone
 *                number and this member may not search by phone. NO QUERY WAS
 *                ISSUED; `items` being empty says nothing about what exists.
 *   INCOMPLETE   hasMore / truncated                 — more may exist beyond
 *                this page, or beyond the scan bound.
 *   ERROR        — not represented here at all. A failed search THROWS; it
 *                never arrives as an empty page.
 */
export interface CustomerSearchPage {
  items: CustomerListItem[];
  /** The column that participated. null when nothing was searched (denied, or empty query). */
  field: CustomerSearchField | null;
  /** True when the server held at least one row beyond this page. Probe-derived, never estimated. */
  hasMore: boolean;
  /** True when a bounded phone scan stopped before the tenant's rows were exhausted. */
  truncated: boolean;
  /**
   * True when the query was phone-shaped and the caller lacks
   * customers.view_sensitive. The phone column was NOT read.
   */
  phoneSearchDenied: boolean;
  /** Server-authoritative PII gate for the rows in `items` — same meaning as CustomerProfile's. */
  sensitiveVisible: boolean;
  limit: number;
  offset: number;
}

export interface SearchCustomersOptions {
  query: string;
  limit?: number | undefined;
  offset?: number | undefined;
}

const CUSTOMER_SEARCH_DEFAULT_LIMIT = 20;
const CUSTOMER_SEARCH_MAX_LIMIT = 50;

/**
 * Rows read per phone-scan round trip, and the ceiling on rows read for one
 * phone search. A safety valve, not a correctness boundary: within it the scan
 * is complete, and when it stops early the page says `truncated` rather than
 * presenting a short list as the whole truth.
 */
const PHONE_SCAN_WINDOW = 500;
const PHONE_SCAN_SAFETY_LIMIT = 5_000;

/**
 * Find customers by display name, or by phone number.
 *
 * ── THE PHONE RULE, WHICH IS THE WHOLE POINT OF THIS FUNCTION ────────────────
 *
 * Phone matching requires BOTH `customers.read` AND
 * `customers.view_sensitive`, and the check happens BEFORE any phone data is
 * read — not after. That ordering is the security property, and it is not
 * interchangeable with masking the result:
 *
 *   A member without customers.view_sensitive who could match on the phone
 *   column and receive a blanked phone back has still learned that a customer
 *   with that number exists in this organization. WHICH ROWS COME BACK is the
 *   disclosure, not the digits printed on them. Masking after the fact leaves
 *   Customer search usable as a phone-number existence oracle, which is
 *   exactly what customers.view_sensitive gates.
 *
 * So for an unauthorized caller the phone query is never issued at all, and
 * the page comes back with `phoneSearchDenied: true` and no items. The UI must
 * present that as "you may not search by phone", never as "no such customer" —
 * and because the two are different fields on this result, it can.
 *
 * The caller never states which field to search. The SERVER decides, from the
 * shape of the query (src/lib/customer-search.ts) and from the caller's own
 * resolved grants. A client that could name the field could name "phone".
 *
 * ── WHAT IS MATCHED ──────────────────────────────────────────────────────────
 *
 * Name: case-insensitive substring of display_name, filtered in Postgres,
 * ordered deterministically, one page at a time with a probe row for hasMore.
 * Every match is returned — several customers sharing a name all come back,
 * and this function never picks one of them.
 *
 * Phone: digit-sequence prefix match, exactly as documented in
 * src/lib/customer-search.ts. No country-code conversion is performed or
 * implied, because APSA stores no normalized phone and therefore has no data
 * contract that would make one correct.
 *
 * Archived customers are excluded from both: a picker offering an archived
 * customer to attach to a new order is a defect, and the Customer 360 route
 * still reaches one directly by id.
 */
export async function searchCustomers(
  ctx: AuthorizationContext,
  options: SearchCustomersOptions,
): Promise<CustomerSearchPage> {
  ctx.require("customers.read");

  const sensitiveVisible = ctx.can("customers.view_sensitive");
  const limit = Math.min(
    Math.max(options.limit ?? CUSTOMER_SEARCH_DEFAULT_LIMIT, 1),
    CUSTOMER_SEARCH_MAX_LIMIT,
  );
  const offset = Math.max(options.offset ?? 0, 0);

  const base = {
    items: [] as CustomerListItem[],
    field: null as CustomerSearchField | null,
    hasMore: false,
    truncated: false,
    phoneSearchDenied: false,
    sensitiveVisible,
    limit,
    offset,
  };

  const raw = options.query.slice(0, CUSTOMER_SEARCH_MAX_QUERY_LENGTH);

  if (looksLikeCustomerPhoneQuery(raw)) {
    /*
     * THE GATE. Note what is above this line: nothing has touched the database
     * yet. An unauthorized caller leaves here having caused no read of any
     * kind, so there is no query plan, no row count and no timing difference
     * that could answer "does this number exist here?".
     */
    if (!sensitiveVisible) return { ...base, phoneSearchDenied: true };
    return searchByPhone(ctx.organizationId, raw, { ...base, field: "phone" });
  }

  const name = normalizeCustomerNameQuery(raw);
  if (name.length === 0) return base;

  // limit + 1: the extra row is the completeness probe and is never returned.
  const rows = await repo.searchCustomersByName(ctx.organizationId, {
    pattern: `%${escapeLikePattern(name)}%`,
    limit: limit + 1,
    offset,
  });

  return {
    ...base,
    field: "name",
    hasMore: rows.length > limit,
    items: rows.slice(0, limit).map((row) => toCustomerListItem(row, sensitiveVisible)),
  };
}

/**
 * The bounded phone scan. Only ever reached after the grant check above.
 *
 * Walks the tenant's phone-bearing customers newest-first in windows,
 * comparing digit sequences, and stops as soon as it has one row more than the
 * page needs. `truncated` is set when PHONE_SCAN_SAFETY_LIMIT stopped it
 * before the rows ran out — the one circumstance in which this answer is
 * knowingly incomplete, and it is reported rather than hidden.
 */
async function searchByPhone(
  organizationId: string,
  query: string,
  base: CustomerSearchPage,
): Promise<CustomerSearchPage> {
  const { limit, offset, sensitiveVisible } = base;
  // Everything up to the end of this page, plus one probe row for hasMore.
  const wanted = offset + limit + 1;

  const matched: CustomerRow[] = [];
  let scanned = 0;
  let exhausted = false;
  let truncated = false;

  while (matched.length < wanted && !exhausted) {
    if (scanned >= PHONE_SCAN_SAFETY_LIMIT) {
      truncated = true;
      break;
    }
    const window = Math.min(PHONE_SCAN_WINDOW, PHONE_SCAN_SAFETY_LIMIT - scanned);
    const rows = await repo.scanCustomersWithPhone(organizationId, {
      offset: scanned,
      limit: window,
    });
    scanned += rows.length;
    if (rows.length < window) exhausted = true;

    for (const row of rows) {
      if (phoneDigitsMatch(row.primary_phone, query)) matched.push(row);
    }
  }

  const page = matched.slice(offset, offset + limit);
  return {
    ...base,
    items: page.map((row) => toCustomerListItem(row, sensitiveVisible)),
    hasMore: matched.length > offset + limit,
    truncated,
  };
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

  const note = await repo.createCustomerNote(ctx.organizationId, customerId, ctx.userId, trimmed);

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

export async function exportCustomers(ctx: AuthorizationContext): Promise<CustomerRow[]> {
  ctx.require("customers.export");

  // Mandatory audit — blocks the export if the audit record fails to persist.
  await auditLogRequired(ctx, {
    action: "customers.export",
    resourceType: "customers",
    reason: "bulk export",
  });

  const rows = await repo.listCustomers(ctx.organizationId, { status: "active" });

  // Strip PII (phone, email) when caller lacks customers.export_sensitive (owner only).
  if (!ctx.can("customers.export_sensitive")) {
    return rows.map((r) => ({ ...r, primary_phone: null, primary_email: null }));
  }
  return rows;
}
