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

  it("refund_payment_v2: key and refunded total required; replay bound to member, payment, amount and reason", () => {
    const body = sqlFunction("refund_payment_v2");
    expect(body).toContain("'idempotency_key_required'");
    expect(body).toContain("'expected_refunded_required'");
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
    // The stale check runs only after a replay was ruled out, and before the write.
    expect(body.indexOf("'stale'")).toBeGreaterThan(body.indexOf("'idempotency_conflict'"));
    expect(body.indexOf("'stale'")).toBeLessThan(body.indexOf("public.refund_payment_v1("));
  });

  it("record_payment_v1: a key replays only the original member's original request, and a replay writes nothing", () => {
    const body = sqlFunction("record_payment_v1");
    expect(body.match(/payment_replay_matches_v1\(/g)).toHaveLength(2);
    expect(body).toContain("'idempotency_conflict'");
    const matches = sqlFunction("payment_replay_matches_v1");
    for (const bound of [
      "v_payment.order_id = p_order_id",
      "v_payment.recorded_by IS NOT DISTINCT FROM p_recorded_by",
      "v_payment.method::text = p_method",
      "v_payment.amount_minor = p_amount_minor",
      "v_original_reference IS NOT DISTINCT FROM",
      "v_original_note IS NOT DISTINCT FROM",
    ]) {
      expect(matches).toContain(bound);
    }
    // The pre-check replay returns before any write (sync / insert).
    const replay = body.indexOf("'replayed', true");
    expect(replay).toBeGreaterThan(0);
    expect(replay).toBeLessThan(body.indexOf("record_payment_before_order_v1("));
  });

  it("retires the non-atomic v1 RPCs and asserts the effective EXECUTE authority itself", () => {
    for (const sig of [
      "refund_payment_v1(uuid,uuid,uuid,bigint,text,text)",
      "reverse_payment_v1(uuid,uuid,uuid,text)",
      "correct_payment_v1(uuid,uuid,uuid,text,text,text)",
    ]) {
      expect(MIGRATION).toContain(
        `REVOKE ALL ON FUNCTION public.${sig}\n  FROM PUBLIC, anon, authenticated, service_role;`,
      );
    }
    expect(MIGRATION).toContain("RAISE EXCEPTION '062: % is still executable by %'");
    expect(MIGRATION).toContain("has_function_privilege('service_role', v_fn, 'EXECUTE')");
    // Functions and grants only — no table, column, index, policy or data change.
    expect(MIGRATION).not.toMatch(
      /\b(CREATE|ALTER|DROP) (TABLE|INDEX|POLICY|VIEW|TYPE)\b|\bINSERT INTO public\.(?!audit_logs)|\bUPDATE public\.|\bDELETE FROM\b/,
    );
  });
});

describe("the server reaches only the atomic RPCs and never writes a second mandatory audit", () => {
  const repository = read("src/server/payments/repository.ts");
  const service = read("src/server/payments/service.ts");

  it("the repository calls refund/reverse/correct v2 and maps the in-transaction audit failure to 503", () => {
    for (const rpc of ["refund_payment_v2", "reverse_payment_v2", "correct_payment_v2"]) {
      expect(repository).toContain(`db.rpc("${rpc}"`);
    }
    expect(repository).toContain('includes("apsa_audit_unavailable")');
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

  it("Payment detail: one key per logical refund in a page-lifetime, principal-scoped holder, retired only on success", () => {
    const route = read("src/routes/app.payments.$id.tsx");
    const confirm = between(route, "onConfirm={(amountMinor, reason) => {", "}}");
    expect(confirm).toContain("const expectedRefundedMinor = refundedMinorOf(payment);");
    expect(confirm).toMatch(
      /sharedIdempotencyHolder\(\{\s*userId,\s*organizationId: routeOrganizationId,\s*flow: "payment-refund",\s*subject: id,\s*\}\)\.claim\(\)/,
    );
    // The key covers exactly what makes it the same refund — the total included.
    expect(confirm).toContain("JSON.stringify([amountMinor, reason, expectedRefundedMinor])");
    const mutation = between(route, "const refundMutation = useMutation({", "onError:");
    expect(mutation).toContain("attempt.claim.retire();");
    expect(mutation.indexOf("attempt.claim.retire();")).toBeGreaterThan(
      mutation.indexOf("onSuccess:"),
    );
  });

  it("the refunded total is the ledger's integer sum, never a float", () => {
    const fn = between(read("src/lib/payments.ts"), "export function refundedMinorOf(", "\n}\n");
    expect(fn).toContain(
      "refundEventsOf(detail).reduce((sum, event) => sum + (event.amount?.amount ?? 0), 0)",
    );
  });
});
