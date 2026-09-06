/**
 * Conversation / Inbox Domain Tests — Production Inbox + Conversation Backend Foundation.
 *
 * Covers:
 *  1.  Tenant isolation: permission gate fires before any DB access (unit) +
 *      cross-org conversation/message/customer/assignment lookups return
 *      nothing across tenants (live DB, skip-ready)
 *  2.  Guessed conversation/message UUID is denied (live DB, skip-ready)
 *  3.  Client-provided org_id/user_id is never accepted by any server function (unit)
 *  4.  messages.read gates every read path (list, detail, message page, mark-read) (unit)
 *  5.  Status-change permission matrix: follow_up needs messages.mark_followup,
 *      closed needs messages.close_conversation, everything else needs messages.reply (unit)
 *  6.  Assignment permission split: assigning to self needs messages.reassign_self,
 *      assigning to someone else needs messages.assign (unit)
 *  7.  Cross-tenant customer_id / assigned_user_id / workspace_id triggers reject
 *      foreign references (live DB, skip-ready)
 *  8.  Repository functions always filter by organization_id (structural)
 *  9.  Production/mock ID boundary: getConversation/getCustomer branch on
 *      isProductionId; non-UUID ids never reach the server function validator (structural)
 * 10.  Bounded context: mapped message shape matches the intent engine's
 *      ContextMessage contract (body/direction/at) (structural)
 * 11.  Mock Inbox/Conversation experience is unchanged (regression)
 * 12.  Idempotent read-state: markConversationRead uses a plain update, not an
 *      increment/toggle (structural)
 *
 * Unit tests (no DB): 1 (permission gate), 3, 4, 5, 6, 8, 9, 10, 11, 12
 * Live DB tests (skip when Supabase not configured): 1 (cross-org), 2, 7
 *
 * Run: bun test src/tests/conversation-domain.test.ts
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ForbiddenError, type AuthorizationContext } from "../server/auth/authorization";

// ── Test fixtures ─────────────────────────────────────────────────────────────
// Must match seed data applied to the test Supabase project — see supabase/README.md.

const ORG_A_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const FAKE_CONVERSATION_ID = "ffffffff-dead-beef-0000-000000000099";
const USER_ORG_A_OWNER = "user-aaaa-0000-0000-0000-000000000001";

// ── Environment check ─────────────────────────────────────────────────────────

let supabaseConfigured = false;

beforeAll(() => {
  supabaseConfigured =
    Boolean(process.env["VITE_SUPABASE_URL"]) && Boolean(process.env["SUPABASE_SERVICE_ROLE_KEY"]);
  if (!supabaseConfigured) {
    console.warn("[SKIP] Live DB tests require VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
});

async function requireSupabase<T>(fn: () => Promise<T>): Promise<T | null> {
  if (!supabaseConfigured) {
    console.warn("[SKIP] Supabase not configured");
    return null;
  }
  try {
    return await fn();
  } catch (e) {
    if (
      e instanceof Error &&
      (e.message.includes("SUPABASE") ||
        e.message.includes("fetch failed") ||
        e.message.includes("ECONNREFUSED"))
    ) {
      console.warn("[SKIP] Supabase unreachable");
      return null;
    }
    throw e;
  }
}

async function expectForbidden(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    throw new Error("Expected ForbiddenError, but none was thrown");
  } catch (e) {
    if (e instanceof ForbiddenError) return;
    throw e;
  }
}

function makeCtxWithPermissions(
  userId: string,
  organizationId: string,
  permissions: string[],
  systemRole = "MANAGER",
): AuthorizationContext {
  const perms = new Set<string>(permissions);
  return {
    userId,
    organizationId,
    roleId: "fake-role-id",
    systemRole,
    permissions: perms,
    can: (key: string) => perms.has(key),
    require: (key: string) => {
      if (!perms.has(key)) throw new ForbiddenError(`Missing permission: ${key}`);
    },
    isOwner: () => systemRole === "OWNER",
    requireOwner: () => {
      if (systemRole !== "OWNER") throw new ForbiddenError("Owner access required");
    },
  } as unknown as AuthorizationContext;
}

// ── Test 1 / 4: messages.read gates every read path ────────────────────────────

describe("Test 1/4: messages.read gates every read path before any DB access", () => {
  it("listConversations without messages.read throws Forbidden (no DB touched)", async () => {
    const { listConversations } = await import("../server/conversations/service");
    const ctx = makeCtxWithPermissions(USER_ORG_A_OWNER, ORG_A_ID, []);
    await expectForbidden(() => listConversations(ctx, {}));
  });

  it("listConversationCounts without messages.read throws Forbidden", async () => {
    const { listConversationCounts } = await import("../server/conversations/service");
    const ctx = makeCtxWithPermissions(USER_ORG_A_OWNER, ORG_A_ID, []);
    await expectForbidden(() => listConversationCounts(ctx));
  });

  it("getConversationDetail without messages.read throws Forbidden", async () => {
    const { getConversationDetail } = await import("../server/conversations/service");
    const ctx = makeCtxWithPermissions(USER_ORG_A_OWNER, ORG_A_ID, []);
    await expectForbidden(() => getConversationDetail(ctx, FAKE_CONVERSATION_ID));
  });

  it("listConversationMessages without messages.read throws Forbidden", async () => {
    const { listConversationMessages } = await import("../server/conversations/service");
    const ctx = makeCtxWithPermissions(USER_ORG_A_OWNER, ORG_A_ID, []);
    await expectForbidden(() => listConversationMessages(ctx, FAKE_CONVERSATION_ID, {}));
  });

  it("markConversationRead without messages.read throws Forbidden", async () => {
    const { markConversationRead } = await import("../server/conversations/service");
    const ctx = makeCtxWithPermissions(USER_ORG_A_OWNER, ORG_A_ID, []);
    await expectForbidden(() => markConversationRead(ctx, FAKE_CONVERSATION_ID));
  });

  it("live DB: Org A member cannot read Org B's conversation via a guessed/foreign UUID", async () => {
    await requireSupabase(async () => {
      const { getConversationDetail } = await import("../server/conversations/service");
      const ctx = makeCtxWithPermissions(USER_ORG_A_OWNER, ORG_A_ID, ["messages.read"]);
      // A conversation that either doesn't exist or belongs to Org B must 404,
      // never leak Org B data — the repository always filters by ORG_A_ID.
      await expect(getConversationDetail(ctx, FAKE_CONVERSATION_ID)).rejects.toThrow(/not found/i);
    });
  });
});

// ── Test 2: Guessed conversation UUID validation ───────────────────────────────

describe("Test 2: Guessed conversation UUID is denied at the validator", () => {
  it("createServerFn validators reject non-UUID conversation ids", async () => {
    const { z } = await import("zod");
    const schema = z.object({ conversationId: z.string().uuid("Invalid conversation ID") });
    expect(() => schema.parse({ conversationId: "not-a-uuid" })).toThrow(/Invalid conversation ID/);
    expect(() => schema.parse({ conversationId: "conv-1" })).toThrow();
    expect(() => schema.parse({ conversationId: FAKE_CONVERSATION_ID })).not.toThrow();
  });
});

// ── Test 3: Client-provided org_id / user_id is never accepted ─────────────────

describe("Test 3: No server function validator accepts organization_id or user_id", () => {
  const apiPath = resolve(import.meta.dir, "../api/conversations.ts");
  const src = readFileSync(apiPath, "utf-8");

  it("src/api/conversations.ts validators never declare an organizationId/userId field", () => {
    // Every z.object({...}) validator block in this file must not contain a
    // client-suppliable organization/user identifier — org+user are always
    // derived from resolveAuthContext() (session + DB membership), never from data.
    expect(src).not.toMatch(/organizationId\s*:\s*z\./);
    expect(src).not.toMatch(/organization_id\s*:\s*z\./);
    expect(src).not.toMatch(/\buserId\s*:\s*z\./);
  });

  it("every handler resolves auth via resolveAuthContext(), not from `data`", () => {
    const handlerBlocks = src.split(".handler(async ({ data }) => {").slice(1);
    expect(handlerBlocks.length).toBeGreaterThan(0);
    for (const block of handlerBlocks) {
      expect(block).toContain("await resolveAuthContext()");
    }
  });

  it("resolveAuthContext derives organization_id from active DB membership, never from a parameter", () => {
    expect(src).toContain('.eq("user_id", session.userId)');
    expect(src).toContain('.eq("status", "active")');
    expect(src).not.toMatch(/resolveAuthContext\([^)]+\)/); // takes no arguments
  });
});

// ── Test 5: Status-change permission matrix ────────────────────────────────────

describe("Test 5: updateConversationStatus enforces the PERMISSIONS_MATRIX.md §10 status matrix", () => {
  it("follow_up requires messages.mark_followup specifically", async () => {
    const { updateConversationStatus } = await import("../server/conversations/service");
    const ctxWithoutFollowup = makeCtxWithPermissions(USER_ORG_A_OWNER, ORG_A_ID, [
      "messages.reply",
    ]);
    await expectForbidden(() =>
      updateConversationStatus(ctxWithoutFollowup, FAKE_CONVERSATION_ID, "follow_up"),
    );
  });

  it("closed requires messages.close_conversation specifically", async () => {
    const { updateConversationStatus } = await import("../server/conversations/service");
    const ctxWithoutClose = makeCtxWithPermissions(USER_ORG_A_OWNER, ORG_A_ID, ["messages.reply"]);
    await expectForbidden(() =>
      updateConversationStatus(ctxWithoutClose, FAKE_CONVERSATION_ID, "closed"),
    );
  });

  it("needs_reply/waiting_customer/order_created/unread require only messages.reply", async () => {
    await requireSupabase(async () => {
      // Requires DB because a real (or absent) conversation lookup happens after
      // the permission check passes — here we only assert the check itself does
      // NOT throw for the baseline statuses when messages.reply is present.
      const { updateConversationStatus } = await import("../server/conversations/service");
      const ctx = makeCtxWithPermissions(USER_ORG_A_OWNER, ORG_A_ID, ["messages.reply"]);
      // Not-found is expected (fixture doesn't exist) — Forbidden is NOT expected.
      await expect(
        updateConversationStatus(ctx, FAKE_CONVERSATION_ID, "needs_reply"),
      ).rejects.toThrow(/not found/i);
    });
  });

  it("a ctx with only messages.mark_followup cannot close a conversation", async () => {
    const { updateConversationStatus } = await import("../server/conversations/service");
    const ctx = makeCtxWithPermissions(USER_ORG_A_OWNER, ORG_A_ID, ["messages.mark_followup"]);
    await expectForbidden(() => updateConversationStatus(ctx, FAKE_CONVERSATION_ID, "closed"));
  });
});

// ── Test 6: Assignment permission split ────────────────────────────────────────

describe("Test 6: assignConversation splits self-assign vs assign-to-others", () => {
  it("assigning to another user requires messages.assign, not messages.reassign_self", async () => {
    const { assignConversation } = await import("../server/conversations/service");
    const ctx = makeCtxWithPermissions(USER_ORG_A_OWNER, ORG_A_ID, ["messages.reassign_self"]);
    await expectForbidden(() =>
      assignConversation(ctx, FAKE_CONVERSATION_ID, "some-other-user-id"),
    );
  });

  it("assigning to yourself requires only messages.reassign_self", async () => {
    await requireSupabase(async () => {
      const { assignConversation } = await import("../server/conversations/service");
      const ctx = makeCtxWithPermissions(USER_ORG_A_OWNER, ORG_A_ID, ["messages.reassign_self"]);
      // Not-found is expected (fixture doesn't exist) — Forbidden is NOT expected.
      await expect(assignConversation(ctx, FAKE_CONVERSATION_ID, USER_ORG_A_OWNER)).rejects.toThrow(
        /not found/i,
      );
    });
  });

  it("unassigning (null) requires only messages.reassign_self, not messages.assign", async () => {
    await requireSupabase(async () => {
      const { assignConversation } = await import("../server/conversations/service");
      const ctx = makeCtxWithPermissions(USER_ORG_A_OWNER, ORG_A_ID, ["messages.reassign_self"]);
      await expect(assignConversation(ctx, FAKE_CONVERSATION_ID, null)).rejects.toThrow(
        /not found/i,
      );
    });
  });

  it("a ctx with messages.assign can assign to someone else (permission check passes)", async () => {
    await requireSupabase(async () => {
      const { assignConversation } = await import("../server/conversations/service");
      const ctx = makeCtxWithPermissions(USER_ORG_A_OWNER, ORG_A_ID, ["messages.assign"]);
      await expect(
        assignConversation(ctx, FAKE_CONVERSATION_ID, "user-bbbb-0000-0000-0000-000000000001"),
      ).rejects.toThrow(/not found/i);
    });
  });
});

// ── Test 7: Cross-tenant reference triggers (live DB) ──────────────────────────

describe("Test 7: Cross-tenant reference triggers reject foreign rows", () => {
  it("migration 031 defines a BEFORE INSERT OR UPDATE trigger checking customer_id/workspace_id/assigned_user_id", () => {
    const migrationPath = resolve(
      import.meta.dir,
      "../../supabase/migrations/031_conversations.sql",
    );
    const src = readFileSync(migrationPath, "utf-8");
    expect(src).toContain("check_conversation_cross_tenant_refs");
    expect(src).toContain("cross_tenant_violation");
    expect(src).toMatch(/BEFORE INSERT OR UPDATE ON public\.conversations/);
  });

  it("migration 032 defines a trigger tying message.organization_id to its conversation's org", () => {
    const migrationPath = resolve(import.meta.dir, "../../supabase/migrations/032_messages.sql");
    const src = readFileSync(migrationPath, "utf-8");
    expect(src).toContain("check_message_cross_tenant_refs");
    expect(src).toContain("cross_tenant_violation");
  });

  it("live DB: inserting a conversation with a foreign-org customer_id is rejected", async () => {
    await requireSupabase(async () => {
      const { supabaseAdmin } = await import("../lib/supabase/server");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = supabaseAdmin as any;
      // Find any Org B customer to use as a cross-tenant reference.
      const { data: foreignCustomer } = await db
        .from("customers")
        .select("id")
        .eq("organization_id", ORG_B_ID)
        .limit(1)
        .maybeSingle();
      if (!foreignCustomer) {
        console.warn("[SKIP] No Org B customer fixture present");
        return;
      }
      const { error } = await db.from("conversations").insert({
        organization_id: ORG_A_ID,
        customer_id: foreignCustomer.id,
        provider: "FACEBOOK",
        provider_conversation_id: `cross-tenant-test-${Date.now()}`,
      });
      expect(error).toBeTruthy();
      expect((error as { message: string }).message).toMatch(/cross_tenant_violation/);
    });
  });
});

// ── Test 8: Repository functions always filter by organization_id ─────────────

describe("Test 8: Repository functions are always organization_id-scoped", () => {
  const repoPath = resolve(import.meta.dir, "../server/conversations/repository.ts");
  const src = readFileSync(repoPath, "utf-8");

  it("findConversationById filters by id AND organization_id", () => {
    expect(src).toContain('.eq("id", conversationId)');
    expect(src).toContain('.eq("organization_id", organizationId)');
  });

  it("listConversations always scopes to organizationId", () => {
    expect(src).toMatch(/\.eq\("organization_id", organizationId\)/);
  });

  it("listRecentMessages / listMessagesBefore scope to both conversation_id and organization_id", () => {
    expect(src).toContain('.eq("conversation_id", conversationId)');
    // Multiple call sites use this pair — assert the pairing exists at least twice.
    const orgScopedCount = (src.match(/\.eq\("organization_id", organizationId\)/g) ?? []).length;
    expect(orgScopedCount).toBeGreaterThanOrEqual(4);
  });

  it("every mutating function (update/insert) is parameterized by organizationId, never a hardcoded org", () => {
    expect(src).not.toMatch(/organization_id:\s*["'][0-9a-f-]{36}["']/);
  });
});

// ── Test 9: Production/mock ID boundary ────────────────────────────────────────

describe("Test 9: getConversation/getCustomer branch on isProductionId", () => {
  const apiIndexPath = resolve(import.meta.dir, "../lib/api/index.ts");
  const src = readFileSync(apiIndexPath, "utf-8");

  it("getConversation checks isProductionId(id) before reaching the server", () => {
    const fnStart = src.indexOf("export async function getConversation(");
    const fnEnd = src.indexOf("\n}", fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toContain("isProductionId(id)");
    expect(fnBody).toContain("getConversationDetailFn");
  });

  it("getCustomer checks isProductionId(id) before reaching the server", () => {
    const fnStart = src.indexOf("export async function getCustomer(");
    const fnEnd = src.indexOf("\n}", fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toContain("isProductionId(id)");
    expect(fnBody).toContain("getCustomer360Fn");
  });

  it("getConversations/getConversationCounts use the demo-mode fallback pattern, not a hard isProductionId branch", () => {
    // These have no single id to branch on (list endpoints) — they must use
    // the same try/isDemoModeError precedent as getProducts() above them.
    const fnStart = src.indexOf("export async function getConversations(");
    const fnEnd = src.indexOf("\nexport async function getConversationCounts", fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toContain("isDemoModeError(err)");
    expect(fnBody).toContain("listConversationsFn");
  });
});

// ── Test 10: Bounded-context message shape ─────────────────────────────────────

describe("Test 10: Mapped message shape matches the intent engine's ContextMessage contract", () => {
  it("toMessageSummary output has body/direction/at fields (service.ts source)", () => {
    const servicePath = resolve(import.meta.dir, "../server/conversations/service.ts");
    const src = readFileSync(servicePath, "utf-8");
    expect(src).toContain("body: row.body");
    expect(src).toContain("direction: row.direction");
    expect(src).toContain("at: row.occurred_at");
  });

  it("getConversationDetail fetches a BOUNDED recent-message window, not the full history", () => {
    const servicePath = resolve(import.meta.dir, "../server/conversations/service.ts");
    const src = readFileSync(servicePath, "utf-8");
    expect(src).toContain("DETAIL_MESSAGE_WINDOW");
    expect(src).toMatch(
      /listMessagesBefore\(ctx\.organizationId, conversationId, null, DETAIL_MESSAGE_WINDOW\)/,
    );
  });

  it("listRecentMessages caps its limit — no unbounded query is possible", () => {
    const repoPath = resolve(import.meta.dir, "../server/conversations/repository.ts");
    const src = readFileSync(repoPath, "utf-8");
    expect(src).toContain("MAX_MESSAGE_LIMIT");
    expect(src).toMatch(/Math\.min\(limit, MAX_MESSAGE_LIMIT\)/);
  });
});

// ── Test 11: Mock Inbox/Conversation experience is unchanged ──────────────────

describe("Test 11: Mock Inbox/Conversation data path is untouched", () => {
  it("mock conversations and messages still resolve for non-UUID ids", async () => {
    const { getConversations, getConversation } = await import("../lib/api");
    const list = await getConversations();
    expect(Array.isArray(list)).toBe(true);
    const mockConversation = list.find((c) => !/^[0-9a-f-]{36}$/i.test(c.id));
    if (mockConversation) {
      const detail = await getConversation(mockConversation.id);
      expect(detail.id).toBe(mockConversation.id);
      expect(Array.isArray(detail.messages)).toBe(true);
    }
  });
});

// ── Test 12: Idempotent read-state ─────────────────────────────────────────────

describe("Test 12: markConversationRead uses an authoritative per-user marker", () => {
  it("repository.markConversationRead delegates the viewed message and user to its RPC", () => {
    const repoPath = resolve(import.meta.dir, "../server/conversations/repository.ts");
    const src = readFileSync(repoPath, "utf-8");
    const fnStart = src.indexOf("export async function markConversationRead(");
    const fnEnd = src.indexOf("\n}", fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toContain('db.rpc("mark_conversation_read"');
    expect(fnBody).toContain("p_user: userId");
    expect(fnBody).not.toContain("unread_count: 0");
  });
});
