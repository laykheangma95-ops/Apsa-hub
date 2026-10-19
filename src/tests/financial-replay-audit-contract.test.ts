/**
 * Durable financial replay identity, refund idempotency and mandatory-audit
 * atomicity (CORRECTIONS.md, CORRECTION-005; migration 062), pinned at every
 * layer. Behaviour against the real migrations and the real server functions:
 * financial-mutation-integrity (replay, double refund, audit rollback, EXECUTE
 * authority) and payment-action-principal-mounted (the Payment detail's key
 * across a lost response and a remount). This file stops the wiring coming
 * apart silently:
 *
 *   - a refund request without its key or the refunded total it started from;
 *   - a server path back to a retired, non-atomic v1 RPC;
 *   - a mandatory financial audit written as a second, separate statement;
 *   - a replay that is not bound to the actor and the original request;
 *   - a refund key that is minted per tap instead of per logical refund.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const read = (file: string) => readFileSync(resolve(file), "utf8").replace(/\r\n/g, "\n");

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

const MIGRATION = read("supabase/migrations/062_financial_replay_refund_audit_atomicity.sql");
/** A CREATE FUNCTION body in 062, up to its closing dollar-quote. */
const sqlFunction = (name: string) => between(MIGRATION, `FUNCTION public.${name}(`, "\n$$;");

function serverSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "tests" ? [] : serverSources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("migration 062: one transaction for a financial change and its mandatory audit", () => {
  for (const [fn, action] of [
    ["refund_payment_v2", "payments.refund"],
    ["reverse_payment_v2", "payments.reverse"],
    ["correct_payment_v2", "payments.override"],
  ] as const) {
    it(`${fn}: the ledger write, then its ${action} audit row — inside the same function, re-raising any audit failure`, () => {
      const body = sqlFunction(fn);
      const write = body.search(/public\.(refund|reverse|correct)_payment_v1\(/);
      const audit = body.indexOf("INSERT INTO public.audit_logs(");
      expect(write).toBeGreaterThan(0);
      expect(audit).toBeGreaterThan(write);
      expect(body).toContain(`'${action}'`);
      // A failed audit insert aborts the whole call — never swallowed.
      expect(body).toMatch(
        /EXCEPTION WHEN OTHERS THEN\s+(?:--[^\n]*\n\s*)*RAISE EXCEPTION 'apsa_audit_unavailable'/,
      );
      expect(body).toContain("SECURITY DEFINER");
    });
  }

  it("refund_payment_v2: key, refunded total and acknowledgement of every earlier refund; replay bound to member, payment, amount and reason", () => {
    const body = sqlFunction("refund_payment_v2");
    expect(body).toContain("'idempotency_key_required'");
    expect(body).toContain("'expected_refunded_required'");
    expect(body).toContain("p_acknowledged_refund_ids uuid[]");
    // One key, one logical refund in the organization: serialized before lookup.
    expect(body.indexOf("pg_advisory_xact_lock(")).toBeLessThan(
      body.indexOf("FROM public.payment_events"),
    );
    for (const bound of [
      "v_previous.payment_id <> p_payment_id",
      "v_previous.actor_user_id IS DISTINCT FROM p_actor",
      "v_previous.amount_minor IS DISTINCT FROM p_amount_minor",
      "v_previous.reason IS DISTINCT FROM p_reason",
    ]) {
      expect(body).toContain(bound);
    }
    // A NEW key must acknowledge every refund already on the payment — after
    // the replay was ruled out, before the ledger write. No time window, no
    // "latest refund" ordering: the set itself.
    const conflict = body.indexOf("'idempotency_conflict'");
    const confirm = body.indexOf("'confirmation_required'");
    const write = body.indexOf("public.refund_payment_v1(");
    expect(confirm).toBeGreaterThan(conflict);
    expect(confirm).toBeLessThan(write);
    expect(body).toContain("AND e.id <> ALL (v_acknowledged)");
    expect(body).not.toMatch(/ORDER BY created_at DESC/);
    // The stale total runs after the replay check, and before the write.
    expect(body.lastIndexOf("'stale'")).toBeGreaterThan(conflict);
    expect(body.lastIndexOf("'stale'")).toBeLessThan(write);
  });

  it("the ORIGINAL recording request is identified by an immutable digest on its created event — never by corrections or mutable columns", () => {
    // 043's body, stamping the digest on the append-only created event.
    const recordBody = sqlFunction("record_payment_before_order_v1");
    expect(recordBody).toMatch(
      /'created', p_amount_minor, v_order\.currency,\s*v_initial_state, p_recorded_by, p_note,\s*jsonb_build_object\(\s*'request_reference_digest', public\.payment_request_digest_v1\(/,
    );
    const digest = sqlFunction("payment_request_digest_v1");
    expect(digest).toContain("IMMUTABLE");
    expect(digest).toContain("sha256(");
    for (const part of ["organization_id", "order_id", "recorded_by", "method", "amount_minor"]) {
      expect(digest).toContain(`'${part}', p_${part}`);
    }
    expect(digest).toContain("'reference', NULLIF(trim(p_reference), '')");
    expect(digest).toContain("'note', NULLIF(trim(p_note), '')");

    const matches = sqlFunction("payment_replay_matches_v1");
    expect(matches).toContain("event_type = 'created'");
    expect(matches).toContain("v_created.actor_user_id IS DISTINCT FROM p_recorded_by");
    expect(matches).toContain(
      "v_created.metadata ->> 'request_reference_digest' = public.payment_request_digest_v1(",
    );
    // Never the mutable columns, never the order of correction events.
    expect(matches).not.toMatch(/v_payment\.(reference|note|recorded_by)/);
    expect(matches).not.toContain("'correction'");
    // A payment recorded before the digest existed is never replayed.
    expect(matches).toMatch(
      /NOT \(v_created\.metadata \? 'request_reference_digest'\) THEN\s+RETURN false;/,
    );
  });

  it("record_payment_v2 replays only the original member's original request (nothing written); record_payment_v1 delegates to it", () => {
    const body = sqlFunction("record_payment_v2");
    expect(body.match(/payment_replay_matches_v1\(/g)).toHaveLength(2);
    expect(body).toContain("'idempotency_conflict'");
    const replay = body.indexOf("'replayed', true");
    expect(replay).toBeGreaterThan(0);
    expect(replay).toBeLessThan(body.indexOf("record_payment_before_order_v1("));
    const v1 = sqlFunction("record_payment_v1");
    expect(v1).toMatch(
      /RETURN public\.record_payment_v2\(p_organization_id, p_order_id, p_recorded_by, p_method,\s*p_amount_minor, p_reference, p_idempotency_key, p_note\);/,
    );
    expect(v1).not.toContain("record_payment_before_order_v1(");
  });

  it("closes EVERY legacy and internal financial function by name — every overload, every schema, every grantee — and asserts EFFECTIVE authority", () => {
    for (const name of [
      "refund_payment_v1",
      "reverse_payment_v1",
      "correct_payment_v1",
      "record_payment_before_order_v1",
      "verify_payment_before_order_v1",
      "reverse_payment_before_order_v1",
      "refund_payment_before_order_v1",
      "lock_payment_order",
      "sync_order_payment_state",
      "payment_replay_matches_v1",
      "payment_request_digest_v1",
      "transition_order_before_payment_authority_v1",
    ]) {
      expect(MIGRATION.split(`'${name}'`).length - 1).toBe(2); // the revoke pass and the post-condition
    }
    // By name, in every schema — never a fixed list of signatures.
    expect(MIGRATION).toContain("WHERE p.proname = ANY (c_entry || c_internal)");
    expect(MIGRATION).not.toMatch(
      /WHERE p\.proname = ANY \(c_entry \|\| c_internal\)\s+AND p\.pronamespace/,
    );
    // Membership closure, any edge: SET-only and inherited memberships both count.
    expect(
      MIGRATION.match(/SELECT m\.roleid FROM pg_auth_members m JOIN r ON m\.member = r\.oid/g),
    ).toHaveLength(3);
    for (const condition of [
      "'062: browser-reachable role % can execute %'",
      "'062: server-reachable role % can execute internal %'",
      "'062: unexpected financial entry-point overload(s): %'",
      "'062: % can no longer execute %, which it calls'",
      "'062: browser-reachable role % can CREATE in schema public'",
      "'062: service_role can become the owner of %'",
    ]) {
      expect(MIGRATION).toContain(condition);
    }
    expect(MIGRATION).toContain("REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;");
    // Functions, function grants and schema CREATE only — no table, column,
    // index, policy, view, type or data change.
    expect(MIGRATION).not.toMatch(
      /\b(CREATE|ALTER|DROP) (TABLE|INDEX|POLICY|VIEW|TYPE)\b|\bINSERT INTO public\.(?!audit_logs|payments \(|payment_events \()|\bUPDATE public\.|\bDELETE FROM\b/,
    );
  });
});

describe("the server reaches only the atomic RPCs and never writes a second mandatory audit", () => {
  const repository = read("src/server/payments/repository.ts");
  const service = read("src/server/payments/service.ts");

  it("the repository calls record_payment_v2 and refund/reverse/correct v2 — never their v1 — and maps an in-transaction audit failure to 503", () => {
    for (const rpc of [
      "record_payment_v2",
      "refund_payment_v2",
      "reverse_payment_v2",
      "correct_payment_v2",
    ]) {
      expect(repository).toContain(`db.rpc("${rpc}"`);
    }
    expect(repository).not.toMatch(/db\.rpc\("(record|refund|reverse|correct)_payment_v1"/);
    expect(repository).toContain('includes("apsa_audit_unavailable")');
  });

  it("a release that reaches a database without 062 refuses those writes before any write (schema_upgrade_required)", () => {
    expect(repository).toContain('return code === "PGRST202" || code === "42883";');
    expect(repository).toContain('"schema_upgrade_required"');
    // Every 062 write maps a missing function to the refusal, never a fallback.
    expect(
      repository.match(
        /throw rpcError\("(recordPayment|refundPayment|reversePayment|correctPayment)"/g,
      ),
    ).toHaveLength(4);
  });

  it("no source calls a retired v1 refund / reverse / correct RPC", () => {
    for (const file of serverSources("src")) {
      const source = read(file);
      const call = /rpc\(\s*["'`](refund|reverse|correct)_payment_v1["'`]/.test(source);
      expect({ file, call }).toEqual({ file, call: false });
    }
  });

  it("refundPayment / reversePayment / correctPayment write no audit row of their own", () => {
    for (const name of ["refundPayment", "reversePayment", "correctPayment"]) {
      const body = between(service, `export async function ${name}(`, "\n}\n");
      expect({ name, audit: /auditLog(Required)?\(|bestEffortAudit\(/.test(body) }).toEqual({
        name,
        audit: false,
      });
    }
    expect(service).not.toContain("auditLogRequired");
  });
});

describe("a refund is one logical request, with one key, end to end", () => {
  it("refundPaymentFn REQUIRES the key and the refunded total — an old bundle is refused", () => {
    const fn = between(read("src/api/payments.ts"), "export const refundPaymentFn", "\n  });\n");
    expect(fn).toContain("idempotencyKey: z.string().trim().min(1).max(200),");
    expect(fn).toContain(
      "expectedRefundedMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),",
    );
    expect(fn).not.toMatch(/idempotencyKey: [^\n]*\.(nullish|optional)\(/);
  });

  it("refundRealPayment sends the key and the total it was given", () => {
    const fn = between(
      read("src/lib/api/index.ts"),
      "export async function refundRealPayment(",
      "\n}\n",
    );
    expect(fn).toContain("expectedRefundedMinor: refund.expectedRefundedMinor,");
    expect(fn).toContain("idempotencyKey: refund.idempotencyKey,");
  });

  it("refundPaymentFn requires the acknowledged refunds too, and the service maps confirmation_required to its own 409", () => {
    const fn = between(read("src/api/payments.ts"), "export const refundPaymentFn", "\n  });\n");
    expect(fn).toContain("acknowledgedRefundIds: z.array(z.string().uuid()).max(100),");
    expect(fn).not.toMatch(/acknowledgedRefundIds: [^\n]*\.(nullish|optional)\(/);
    const service = read("src/server/payments/service.ts");
    expect(service).toContain('"refund_confirmation_required"');
    expect(read("src/lib/api/index.ts")).toContain(
      "acknowledgedRefundIds: refund.acknowledgedRefundIds,",
    );
  });

  it("Payment detail: the logical refund's key is DURABLE (src/lib/refund-intent.ts), principal + payment scoped, and a refused new key is reviewed explicitly", () => {
    const route = read("src/routes/app.payments.$id.tsx");
    expect(route).not.toContain("sharedIdempotencyHolder");
    expect(route).toMatch(
      /const refundScope: RefundIntentScope = \{\s*userId,\s*organizationId: routeOrganizationId,\s*paymentId: id,\s*\};/,
    );
    const submit = between(route, "function submitRefund(", "\n  }\n");
    expect(submit).toContain("const pending = beginRefund(refundScope, amountMinor, reason);");
    expect(submit).toContain("idempotencyKey: pending.key,");
    expect(submit).toContain("acknowledgedRefundIds: readRefundIntent(refundScope).acknowledged,");
    expect(submit).toContain("expectedRefundedMinor: refundedMinorOf(current),");
    const mutation = between(
      route,
      "const refundMutation = useMutation({",
      "function submitRefund(",
    );
    // Seen to succeed (made now or replayed): acknowledged, pending cleared.
    expect(mutation).toContain("refundSucceeded(attempt.scope, made?.id ?? null);");
    // Refused for confirmation: nothing written, the refunds are shown, nothing re-sent.
    expect(mutation).toMatch(
      /if \(isRefundConfirmationRequired\(err\)\) \{[\s\S]*setRefundReview\(true\);[\s\S]*return;/,
    );
    // Refunding more needs the merchant's explicit choice after seeing them.
    const beyond = between(route, "onConfirmBeyond={(amountMinor, reason) => {", "}}");
    expect(beyond.indexOf("acknowledgeRefunds(")).toBeLessThan(beyond.indexOf("submitRefund("));
    expect(between(route, "onDecline={() => {", "}}")).toContain(
      "abandonPendingRefund(refundScope);",
    );
    // The recovery notice recognises the screen's OWN committed refund by key.
    expect(route).toContain("refunds.find((event) => event.idempotencyKey === pendingRefund.key)");
  });

  it("the server exposes a refund's key only to the member who made it", () => {
    const service = read("src/server/payments/service.ts");
    expect(service).toMatch(
      /idempotencyKey:\s*row\.event_type === "refund" && row\.actor_user_id === viewerUserId\s*\?\s*\(row\.idempotency_key \?\? null\)\s*:\s*null,/,
    );
    expect(service).toContain("mapEvent(row, canViewReference, knownReferences, ctx.userId)");
  });

  it("the refunded total is the ledger's integer sum, never a float", () => {
    const fn = between(read("src/lib/payments.ts"), "export function refundedMinorOf(", "\n}\n");
    expect(fn).toContain(
      "refundEventsOf(detail).reduce((sum, event) => sum + (event.amount?.amount ?? 0), 0)",
    );
  });
});
