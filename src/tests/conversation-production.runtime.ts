import { beforeAll, afterAll, describe, it, expect, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { conversationPostgrest } from "./helpers/conversation-postgrest";
import type { AuthorizationContext } from "../server/auth/authorization";

const db = new PGlite();
const transport = conversationPostgrest(db);
mock.module("../lib/supabase/server", () => ({ supabaseAdmin: transport }));
const orgA = "aaaaaaaa-0000-4000-8000-000000000001";
const orgB = "bbbbbbbb-0000-4000-8000-000000000001";
const userA = "aaaaaaaa-0000-4000-8000-000000000002";
const userA2 = "aaaaaaaa-0000-4000-8000-000000000003";
const userB = "bbbbbbbb-0000-4000-8000-000000000002";
const customerA = "aaaaaaaa-0000-4000-8000-000000000004";
const customerB = "bbbbbbbb-0000-4000-8000-000000000004";
let conversationA: string;
let conversationB: string;
async function row(sql: string, args: unknown[] = []) {
  // Dynamic SQL fixture rows have different column sets.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await db.query<Record<string, any>>(sql, args)).rows[0]!;
}
async function ensure(
  org: string,
  reference: string,
  identity: string | null = null,
  provider = "FACEBOOK",
) {
  return row("select * from ensure_provider_conversation($1, $2::conversation_provider, $3, $4)", [
    org,
    provider,
    reference,
    identity,
  ]);
}
async function ingest(
  org: string,
  conv: string,
  ref: string,
  body = "សួស្តី",
  time = "2026-09-01T12:00:00Z",
) {
  return row("select * from ingest_conversation_message($1,$2,$3,'inbound','customer',$4,$5)", [
    org,
    conv,
    ref,
    body,
    time,
  ]);
}
async function unread(user: string, conv = conversationA, org = orgA) {
  return (
    await row("select unread_count from conversation_inbox_rows($1,$2) where id=$3", [
      org,
      user,
      conv,
    ])
  ).unread_count;
}
function context(
  org = orgA,
  user = userA,
  permissions = ["messages.read", "messages.reply", "messages.assign", "messages.reassign_self"],
) {
  return {
    organizationId: org,
    userId: user,
    can: (key: string) => permissions.includes(key),
    require: (key: string) => {
      if (!permissions.includes(key)) throw new Error("permission_denied");
    },
  } as AuthorizationContext;
}
beforeAll(async () => {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;`);
  // Execute actual main migrations, excluding reserved Payment files. No hosted DB.
  for (const name of readdirSync("supabase/migrations")
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()) {
    if (/^02[89]_/.test(name) || name.startsWith("030_")) continue; // Main 030 has an ambiguous overloaded-function COMMENT.
    if (name.startsWith("034_")) {
      // Existing history must migrate even after its assigned/sending staff left.
      await db.exec(`
        insert into auth.users(id,email) values('dddddddd-0000-4000-8000-000000000001','departed@test.invalid');
        insert into organizations(id,legal_name,display_name,slug,created_by)
          values('dddddddd-0000-4000-8000-000000000002','History','History','history','dddddddd-0000-4000-8000-000000000001');
        insert into memberships(organization_id,user_id,role_id,status)
          select 'dddddddd-0000-4000-8000-000000000002','dddddddd-0000-4000-8000-000000000001',id,'active'
          from roles where system_role='MANAGER' and organization_id is null;
        insert into conversations(id,organization_id,provider,provider_conversation_id,assigned_user_id)
          values('dddddddd-0000-4000-8000-000000000003','dddddddd-0000-4000-8000-000000000002','FACEBOOK','history','dddddddd-0000-4000-8000-000000000001');
        insert into messages(organization_id,conversation_id,direction,sender_type,sender_user_id,body)
          values('dddddddd-0000-4000-8000-000000000002','dddddddd-0000-4000-8000-000000000003','outbound','staff','dddddddd-0000-4000-8000-000000000001','historical reply');
        update memberships set status='removed' where user_id='dddddddd-0000-4000-8000-000000000001';
      `);
    }
    try {
      await db.exec(readFileSync(`supabase/migrations/${name}`, "utf8"));
    } catch (error) {
      throw new Error(`Migration ${name}: ${String(error)}`);
    }
  }
  await db.query(
    "insert into auth.users(id,email) values($1,'a@test.invalid'),($2,'a2@test.invalid'),($3,'b@test.invalid')",
    [userA, userA2, userB],
  );
  await db.query(
    "insert into organizations(id,legal_name,display_name,slug,created_by) values($1,'A','A','org-a',$3),($2,'B','B','org-b',$4)",
    [orgA, orgB, userA, userB],
  );
  await db.query(
    `insert into memberships(organization_id,user_id,role_id,status)
    select $1,u.id,r.id,'active' from auth.users u cross join roles r
    where u.id in ($2,$3) and r.system_role='OWNER' and r.organization_id is null`,
    [orgA, userA, userA2],
  );
  await db.query(
    `insert into memberships(organization_id,user_id,role_id,status)
    select $1,$2,r.id,'active' from roles r where r.system_role='OWNER' and r.organization_id is null`,
    [orgB, userB],
  );
  await db.query(
    "insert into customers(id,organization_id,display_name) values($1,$3,'Customer A'),($2,$4,'Customer B')",
    [customerA, customerB, orgA, orgB],
  );
  await db.query(
    "insert into customer_identities(organization_id,customer_id,provider,provider_user_id) values($1,$2,'FACEBOOK','identity-a'),($3,$4,'FACEBOOK','identity-b')",
    [orgA, customerA, orgB, customerB],
  );
  conversationA = (await ensure(orgA, "thread-a", "identity-a")).id;
  conversationB = (await ensure(orgB, "thread-b", "identity-b")).id;
}, 120000);
afterAll(async () => {
  await db.close();
});

describe("provider identity resolution", () => {
  it("reuses same-tenant CustomerIdentity and preserves retry identity", async () => {
    const retry = await ensure(orgA, "thread-a", "identity-a");
    expect(retry.id).toBe(conversationA);
    expect(retry.customer_id).toBe(customerA);
  });
  it("foreign provider identity never guesses a Customer", async () => {
    expect((await ensure(orgA, "foreign-identity", "identity-b")).customer_id).toBeNull();
  });
  it("foreign provider conversation reference resolves only inside this tenant", async () => {
    const local = await ensure(orgA, "thread-b", "identity-a");
    expect(local.id).not.toBe(conversationB);
    expect(local.organization_id).toBe(orgA);
  });
  it("late identity resolution is reflected without copying content", async () => {
    const conv = await ensure(orgA, "late-identity", "identity-later");
    expect(conv.customer_id).toBeNull();
    await db.query(
      "insert into customer_identities(organization_id,customer_id,provider,provider_user_id) values($1,$2,'FACEBOOK','identity-later')",
      [orgA, customerA],
    );
    expect(
      (
        await row("select customer_id from conversation_inbox_rows($1,$2) where id=$3", [
          orgA,
          userA,
          conv.id,
        ])
      ).customer_id,
    ).toBe(customerA);
  });
  it("a group with unresolved participants stays unlinked", async () => {
    await ensure(orgA, "ambiguous", "identity-a");
    expect((await ensure(orgA, "ambiguous", "unresolved")).customer_id).toBeNull();
  });
  it("provider vocabulary accepts future channels without any integration", async () => {
    for (const provider of ["WHATSAPP", "TIKTOK", "APSA_CONSUMER"])
      expect((await ensure(orgA, provider, null, provider)).provider).toBe(provider);
  });
});

describe("read markers and retry-safe message ingestion", () => {
  it("retry produces one message, one increment and the original ID", async () => {
    const first = await ingest(orgA, conversationA, "message-1");
    const retry = await ingest(orgA, conversationA, "message-1");
    expect(retry.id).toBe(first.id);
    expect(await unread(userA)).toBe(1);
    await expect(ingest(orgA, conversationA, "message-1", "changed")).rejects.toThrow(
      "stale_state",
    );
  });
  it("each staff member owns their read position; delayed messages remain unread", async () => {
    const first = await ingest(orgA, conversationA, "message-1");
    await db.query("select mark_conversation_read($1,$2,$3,$4)", [
      orgA,
      userA,
      conversationA,
      first.id,
    ]);
    expect(await unread(userA)).toBe(0);
    expect(await unread(userA2)).toBe(1);
    const late = await ingest(orgA, conversationA, "late", "late content", "2025-01-01T00:00:00Z");
    expect(await unread(userA)).toBe(1);
    expect(
      (await row("select last_message_preview from conversations where id=$1", [conversationA]))
        .last_message_preview,
    ).toBe("សួស្តី");
    await db.query("select mark_conversation_read($1,$2,$3,$4)", [
      orgA,
      userA,
      conversationA,
      late.id,
    ]);
    await db.query("select mark_conversation_read($1,$2,$3,$4)", [
      orgA,
      userA,
      conversationA,
      first.id,
    ]);
    expect(await unread(userA)).toBe(0);
  });
  it("marking a snapshot cannot clear a newer arrival", async () => {
    const seen = await ingest(orgA, conversationA, "seen");
    await ingest(orgA, conversationA, "new-arrival");
    await db.query("select mark_conversation_read($1,$2,$3,$4)", [
      orgA,
      userA,
      conversationA,
      seen.id,
    ]);
    expect(await unread(userA)).toBe(1);
  });
  it("different conversations may reuse the same provider message reference", async () => {
    const other = await ingest(orgB, conversationB, "message-1");
    expect(other.organization_id).toBe(orgB);
  });
});

describe("database tenant and permission barriers", () => {
  it("backfills departed-staff history and prevents reparenting a conversation across tenants", async () => {
    expect(
      (
        await row(
          "select sequence from messages where conversation_id='dddddddd-0000-4000-8000-000000000003'",
        )
      ).sequence,
    ).toBe(1);
    await expect(
      db.query("update conversations set organization_id=$1 where id=$2", [orgB, conversationA]),
    ).rejects.toThrow();
  });
  it("foreign conversation UUID is inaccessible", async () => {
    expect(
      (
        await db.query("select * from conversation_inbox_rows($1,$2) where id=$3", [
          orgA,
          userA,
          conversationB,
        ])
      ).rows,
    ).toHaveLength(0);
    await expect(ingest(orgA, conversationB, "forbidden")).rejects.toThrow(
      "conversation_not_found",
    );
  });
  it("foreign message UUID cannot advance a read marker", async () => {
    const foreign = await ingest(orgB, conversationB, "foreign-read");
    await expect(
      db.query("select mark_conversation_read($1,$2,$3,$4)", [
        orgA,
        userA,
        conversationA,
        foreign.id,
      ]),
    ).rejects.toThrow("message_not_found");
  });
  it("foreign staff cannot read or be assigned", async () => {
    const seen = await ingest(orgA, conversationA, "seen");
    await expect(
      db.query("select mark_conversation_read($1,$2,$3,$4)", [orgA, userB, conversationA, seen.id]),
    ).rejects.toThrow("permission_denied");
    await expect(
      db.query("update conversations set assigned_user_id=$1 where id=$2", [userB, conversationA]),
    ).rejects.toThrow("cross_tenant_violation");
    await db.query("update conversations set assigned_user_id=$1 where id=$2", [
      userA2,
      conversationA,
    ]);
    expect(
      (await row("select assigned_user_id from conversations where id=$1", [conversationA]))
        .assigned_user_id,
    ).toBe(userA2);
  });
  it("foreign Customer UUID and participant conversation UUID fail at the database", async () => {
    await expect(
      db.query("update conversations set customer_id=$1 where id=$2", [customerB, conversationA]),
    ).rejects.toThrow("cross_tenant_violation");
    await expect(
      db.query(
        "insert into conversation_participants(organization_id,conversation_id,provider_identity_id) values($1,$2,'forged')",
        [orgA, conversationB],
      ),
    ).rejects.toThrow();
  });
  it("browser roles cannot read content, set unread counts or call privileged RPCs", async () => {
    await db.exec("set role authenticated");
    try {
      await expect(db.query("select * from conversations")).rejects.toThrow("permission denied");
      await expect(db.query("select * from messages")).rejects.toThrow("permission denied");
      await expect(db.query("update conversations set unread_count=0")).rejects.toThrow(
        "permission denied",
      );
      await expect(
        db.query("select * from conversation_inbox_rows($1,$2)", [orgA, userA]),
      ).rejects.toThrow("permission denied");
      await expect(
        db.query("select mark_conversation_read($1,$2,$3,$4)", [
          orgA,
          userA,
          conversationA,
          conversationA,
        ]),
      ).rejects.toThrow("permission denied");
    } finally {
      await db.exec("reset role");
    }
  });
  it("counts are complete and unread is per user", async () => {
    const countsA = (await row("select conversation_counts($1,$2) as counts", [orgA, userA]))
      .counts;
    const countsB = (await row("select conversation_counts($1,$2) as counts", [orgB, userB]))
      .counts;
    expect(countsA.all).toBeGreaterThan(countsB.all);
    expect(countsA.unread).toBe(1);
  });
});

describe("real repository and service through local SQL", () => {
  it("lists bounded ordered pages, metadata and resolved customer summaries", async () => {
    const service = await import("../server/conversations/service");
    const ctx = context();
    const first = await service.listConversations(ctx, { limit: 2 });
    expect(first.conversations).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.listConversations(ctx, { limit: 2, cursor: first.nextCursor! });
    expect(
      second.conversations.some((item) =>
        first.conversations.some((prior) => prior.id === item.id),
      ),
    ).toBe(false);
    const detail = await service.getConversationDetail(ctx, conversationA);
    expect(detail.customerId).toBe(customerA);
    expect(detail.customerName).toBe("Customer A");
    expect(detail.provider).toBe("FACEBOOK");
    expect(detail.providerConversationId).toBe("thread-a");
    expect(detail.messages.length).toBeGreaterThan(0);
    expect("phone" in detail).toBe(false);
  });
  it("rejects malformed and foreign tenant cursors instead of restarting", async () => {
    const service = await import("../server/conversations/service");
    await expect(service.listConversations(context(), { cursor: "garbage" })).rejects.toThrow(
      "invalid_cursor",
    );
    const foreign = await row("select last_message_at from conversations where id=$1", [
      conversationB,
    ]);
    const foreignCursor = Buffer.from(
      `${new Date(foreign.last_message_at).toISOString()}|${conversationB}`,
    ).toString("base64url");
    await expect(service.listConversations(context(), { cursor: foreignCursor })).rejects.toThrow(
      "invalid_cursor",
    );
    const message = await ingest(orgB, conversationB, "foreign-cursor");
    await expect(
      service.listConversationMessages(context(), conversationA, { beforeId: message.id }),
    ).rejects.toThrow("invalid_cursor");
  });
  it("pages messages with equal timestamps without duplication", async () => {
    const service = await import("../server/conversations/service");
    const first = await service.listConversationMessages(context(), conversationA, { limit: 2 });
    const second = await service.listConversationMessages(context(), conversationA, {
      limit: 2,
      beforeId: first.nextBeforeId!,
    });
    expect(first.messages).toHaveLength(2);
    expect(
      second.messages.some((message) => first.messages.some((prior) => prior.id === message.id)),
    ).toBe(false);
  });
  it("search cannot infer sensitive phone or another tenant's customer", async () => {
    const service = await import("../server/conversations/service");
    await db.query("update customers set primary_phone='099887766' where id=$1", [customerA]);
    expect(
      (await service.listConversations(context(), { query: "099887766" })).conversations,
    ).toHaveLength(0);
    expect(
      (await service.listConversations(context(), { query: "Customer B" })).conversations,
    ).toHaveLength(0);
    expect(
      (await service.listConversations(context(), { query: '"),organization_id.neq.null' }))
        .conversations,
    ).toHaveLength(0);
    expect(
      (await service.listConversations(context(), { query: "Customer A" })).conversations.length,
    ).toBeGreaterThan(0);
  });
  it("foreign detail and every permission gate fail before disclosure", async () => {
    const service = await import("../server/conversations/service");
    await expect(service.getConversationDetail(context(), conversationB)).rejects.toThrow(
      "conversation_not_found",
    );
    const denied = context(orgA, userA, []);
    const before = transport.requests.length;
    await expect(service.listConversations(denied)).rejects.toThrow("permission_denied");
    await expect(service.getConversationDetail(denied, conversationA)).rejects.toThrow(
      "permission_denied",
    );
    await expect(service.markConversationRead(denied, conversationA)).rejects.toThrow(
      "permission_denied",
    );
    await expect(service.assignConversation(denied, conversationA, userA2)).rejects.toThrow(
      "permission_denied",
    );
    await expect(service.updateConversationStatus(denied, conversationA, "closed")).rejects.toThrow(
      "permission_denied",
    );
    expect(transport.requests.length).toBe(before);
  });
  it("assignment checks org membership and permission to unassign somebody else", async () => {
    const service = await import("../server/conversations/service");
    await expect(service.assignConversation(context(), conversationA, userB)).rejects.toThrow(
      "invalid_assignment",
    );
    const selfOnly = context(orgA, userA, ["messages.reassign_self", "messages.read"]);
    await expect(service.assignConversation(selfOnly, conversationA, null)).rejects.toThrow(
      "permission_denied",
    );
    expect(
      (await service.assignConversation(context(), conversationA, userA)).assignedStaffId,
    ).toBe(userA);
    expect(
      (await service.assignConversation(selfOnly, conversationA, null)).assignedStaffId,
    ).toBeUndefined();
  });
  it("mark-read through the service leaves the other staff member's count intact", async () => {
    const service = await import("../server/conversations/service");
    const detail = await service.getConversationDetail(context(), conversationA);
    const other = await unread(userA2);
    expect(
      (await service.markConversationRead(context(), conversationA, detail.readThroughMessageId!))
        .unreadCount,
    ).toBe(0);
    expect(await unread(userA2)).toBe(other);
  });
  it("safe errors hide raw database failures", async () => {
    const { databaseError } = await import("../server/conversations/errors");
    expect(databaseError({ message: "secret SQL connection internal detail" }).message).toBe(
      "conversation_unavailable",
    );
  });
  it("a delayed message outside the first page can be marked read when loaded", async () => {
    const service = await import("../server/conversations/service");
    const thread = await ensure(orgA, "deep-history", "identity-a");
    for (let i = 0; i < 51; i++) await ingest(orgA, thread.id, `history-${i}`);
    const late = await ingest(
      orgA,
      thread.id,
      "late-history",
      "old provider timestamp",
      "2020-01-01T00:00:00Z",
    );
    const detail = await service.getConversationDetail(context(), thread.id);
    await service.markConversationRead(context(), thread.id, detail.readThroughMessageId!);
    expect(await unread(userA, thread.id)).toBe(1);
    const older = await service.listConversationMessages(context(), thread.id, {
      beforeId: detail.nextBeforeId!,
    });
    expect(older.readThroughMessageId).toBe(late.id);
    await service.markConversationRead(context(), thread.id, older.readThroughMessageId!);
    expect(await unread(userA, thread.id)).toBe(0);
  });
});

describe("existing Order handoff and migration prerequisite", () => {
  it("service_role can execute the Conversation foundation under actual database privileges", async () => {
    await db.exec("set role service_role");
    try {
      const thread = await ensure(orgA, "service-role-thread", "identity-a");
      const message = await ingest(orgA, thread.id, "service-role-message");
      await db.query("select mark_conversation_read($1,$2,$3,$4)", [
        orgA,
        userA,
        thread.id,
        message.id,
      ]);
      expect(await unread(userA, thread.id)).toBe(0);
    } finally {
      await db.exec("reset role");
    }
  });
  it("records the clean-main 030 failure, then tests its unchanged function body in isolation", async () => {
    const migration = readFileSync("supabase/migrations/030_order_conversation_source.sql", "utf8");
    await expect(db.exec(migration)).rejects.toThrow(
      'function name "public.create_order_v1" is not unique',
    );
    // Diagnostic fixture only: remove the ambiguous metadata COMMENT, not any
    // executable Order logic. Deployment remains blocked on main's 030 repair.
    await db.exec(
      migration.slice(0, migration.lastIndexOf("COMMENT ON FUNCTION public.create_order_v1")),
    );
    const privilege = await row(`select has_function_privilege('authenticated',
      'public.create_order_v1(uuid,uuid,text,jsonb,uuid,uuid,bigint,text)', 'EXECUTE') as exposed`);
    // A second existing prerequisite: this overload defaults to PUBLIC execute.
    // No application permission gate can secure that direct RPC exposure.
    expect(privilege.exposed).toBe(true);
  });
  it("real Conversation and Customer reach Smart Actions, Draft and existing Confirm", async () => {
    const service = await import("../server/conversations/service");
    const { buildSmartActionSuggestion } = await import("../lib/conversation/smart-actions");
    const { products } = await import("../lib/mock/products");
    const product = await row(
      "insert into products(organization_id,name_km,name_en) values($1,'អាវ','T-shirt') returning id",
      [orgA],
    );
    const variant = await row(
      "insert into product_variants(organization_id,product_id,name,price_amount) values($1,$2,'Black M',1000) returning id",
      [orgA, product.id],
    );
    const catalog = [
      { ...products.find((item) => item.id === "prd-3")!, id: product.id, variantId: variant.id },
    ];
    const conversation = await ensure(orgA, "order-handoff", "identity-a");
    await ingest(orgA, conversation.id, "purchase", "យក black size M", new Date().toISOString());
    const detail = await service.getConversationDetail(context(), conversation.id);
    expect(
      buildSmartActionSuggestion({
        messages: detail.messages,
        hasCustomer: Boolean(detail.customerId),
        products: catalog,
      }).primary,
    ).toBe("prepare_order");
    await db.query(
      "insert into inventory_movements(organization_id,product_id,variant_id,quantity_delta,movement_type) values($1,$2,$3,10,'initial')",
      [orgA, product.id, variant.id],
    );
    const created = await row(
      "select create_order_v1($1,$2,'FACEBOOK',$3::jsonb,$4,null,0,$5) as result",
      [
        orgA,
        userA,
        JSON.stringify([{ variant_id: variant.id, quantity: 2 }]),
        detail.customerId,
        detail.id,
      ],
    );
    expect(created.result.status).toBe("success");
    const order = await row("select * from orders where id=$1", [created.result.order_id]);
    expect(order.customer_id).toBe(customerA);
    expect(order.source_conversation_ref).toBe(detail.id);
    expect(order.lifecycle_status).toBe("draft");
    expect(order.payment_status).toBe("unpaid");
    expect(
      (
        await row(
          "select sum(quantity_delta)::int as stock from inventory_movements where variant_id=$1",
          [variant.id],
        )
      ).stock,
    ).toBe(10);
    expect(
      (await row("select count(*)::int as n from deliveries where order_id=$1", [order.id])).n,
    ).toBe(0);
    const confirmed = await row(
      "select transition_order_status_v1($1,$2,'lifecycle','draft','confirmed',$3) as result",
      [orgA, order.id, userA],
    );
    expect(confirmed.result.status).toBe("success");
    expect(
      (
        await row(
          "select sum(quantity_delta)::int as stock from inventory_movements where variant_id=$1",
          [variant.id],
        )
      ).stock,
    ).toBe(8);
    expect(
      (await row("select payment_status from orders where id=$1", [order.id])).payment_status,
    ).toBe("unpaid");
  });
});
