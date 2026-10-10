/**
 * The initiating-principal contract (CORRECTIONS.md, CORRECTION-004), pinned at
 * every layer of every protected mutation:
 *
 *   order creation         createOrderFn → createOrder
 *                          (POS checkout, Orders → New Order, Inbox → Prepare Order)
 *   lifecycle transitions  transitionOrderLifecycleFn → transitionLifecycleStatus
 *                          (Confirm / Cancel: Order detail, Inbox draft, POS sale)
 *   payment recording      recordPaymentFn → recordPayment
 *                          (Record payment: Order detail, POS sale)
 *
 * The server derives who is acting only when it HANDLES a request. Each of these
 * carries the member + organization it was STARTED as, and the server refuses —
 * before the permission, any limit, read or write — when its own derivation
 * differs. Behaviour, against the database: pos-checkout-replay-mounted,
 * order-entry-principal-mounted and order-mutation-principal-mounted. This file
 * stops the wiring coming apart silently: a validator that drops the field, a
 * handler that stops forwarding it, a service that checks it after a write or
 * reads it for anything else, an adapter that stops sending it, or a call site
 * that never passes one.
 *
 * Mutations NOT covered by this contract (payment verify/refund/reverse/correct,
 * evidence, fulfillment, parcel recovery, shipping edits, other domains) are
 * listed in CORRECTION-004 as not yet protected.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SANCTIONED_INBOX_CALL_ARG,
  SANCTIONED_NEW_ORDER_CALL_ARG,
  SANCTIONED_POS_ATTEMPT_PRINCIPAL,
} from "./helpers/refuse-only-principal";

const read = (file: string) => readFileSync(resolve(file), "utf8").replace(/\r\n/g, "\n");

/** `source` from `start` to the first `end` after it — both must exist. */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

const count = (source: string, needle: string) => source.split(needle).length - 1;

// ═══════════════════════════════════════════════════════════════════════════
// The one check
// ═══════════════════════════════════════════════════════════════════════════

describe("the refuse-only check", () => {
  const helper = read("src/server/auth/expected-principal.ts");
  const fn = between(helper, "export function assertExpectedPrincipal(", "\n}\n");

  it("refuses on any difference in member or organization, as 409 principal_changed — and can do nothing else", () => {
    expect(fn).toContain("if (!expected) return;");
    expect(fn).toMatch(
      /if \(\s*expected\.userId === actual\.userId &&\s*expected\.organizationId === actual\.organizationId\s*\)/,
    );
    // Read exactly twice — both sides of that one equality — and never returned.
    expect(fn.match(/expected\.(userId|organizationId)/g)).toHaveLength(2);
    expect(fn).not.toMatch(/return\s+expected/);
    expect(fn).toContain("409");
    expect(fn).toContain('"principal_changed"');
    // A void assertion: it returns nothing a caller could use as an identity.
    expect(fn).toMatch(/\): void \{/);
  });

  it("lives in one place: no service keeps its own copy", () => {
    for (const file of ["src/server/orders/service.ts", "src/server/payments/service.ts"]) {
      const source = read(file);
      expect(source).toContain('from "@/server/auth/expected-principal"');
      expect(source).not.toMatch(/function assertExpectedPrincipal/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Services: checked first, read once, never an actor
// ═══════════════════════════════════════════════════════════════════════════

describe("each protected service checks it before anything else and records only ctx", () => {
  const orders = read("src/server/orders/service.ts");
  const payments = read("src/server/payments/service.ts");
  const cases = [
    {
      name: "createOrder",
      body: between(orders, "export async function createOrder(", "\n}\n"),
      check: "assertExpectedPrincipal(ctx, input.expectedPrincipal);",
      later: [
        'ctx.require("orders.create")',
        "enforceOrderCreateLimit(",
        "repo.findCustomerForOrg(",
        "repo.createOrder(",
        "bestEffortAudit(",
      ],
      writesAs: /repo\.createOrder\(ctx\.organizationId, ctx\.userId,/,
      reads: /input\.expectedPrincipal/g,
    },
    {
      name: "transitionLifecycleStatus",
      body: between(orders, "export async function transitionLifecycleStatus(", "\n}\n"),
      check: "assertExpectedPrincipal(ctx, expectedPrincipal);",
      later: [
        "ctx.require(permission)",
        "loadTransitionTarget(",
        "recoverParcelAtomically(",
        "repo.transitionStatus(",
        "bestEffortAudit(",
      ],
      writesAs:
        /repo\.transitionStatus\(\s*ctx\.organizationId,\s*orderId,\s*"lifecycle",\s*from,\s*to,\s*ctx\.userId,/,
      // The parameter declaration and the check — nothing else.
      reads: /\bexpectedPrincipal\b/g,
    },
    {
      name: "recordPayment",
      body: between(payments, "export async function recordPayment(", "\n}\n"),
      check: "assertExpectedPrincipal(ctx, input.expectedPrincipal);",
      later: [
        "PAYMENT_METHODS.includes(",
        "ctx.require(",
        "enforcePaymentMutationLimit(",
        "repo.findOrderForOrg(",
        "repo.recordPayment(",
        "bestEffortAudit(",
      ],
      writesAs: /repo\.recordPayment\(ctx\.organizationId, ctx\.userId,/,
      reads: /input\.expectedPrincipal/g,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: the check is its first statement — before the permission, any limit, read or write`, () => {
      const open = c.body.indexOf("> {\n");
      expect(open).toBeGreaterThan(0);
      const firstStatement = c.body
        .slice(open + 4)
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith("//") && !/^\/?\*/.test(line));
      expect(firstStatement).toBe(c.check);
      const at = c.body.indexOf(c.check);
      for (const step of c.later) {
        expect(c.body.indexOf(step)).toBeGreaterThan(at);
      }
    });

    it(`${c.name}: it is read only by that check, and every write is attributed to ctx`, () => {
      const expectedReads = c.name === "transitionLifecycleStatus" ? 2 : 1;
      expect(c.body.match(c.reads) ?? []).toHaveLength(expectedReads);
      expect(c.body).not.toMatch(/expected(Principal)?\.(userId|organizationId)/);
      expect(c.body).toMatch(c.writesAs);
    });
  }

  it("each service file reads the field nowhere else", () => {
    expect(count(orders, "input.expectedPrincipal")).toBe(1);
    expect(count(payments, "input.expectedPrincipal")).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Server functions: accepted through one schema, forwarded, never derived from
// ═══════════════════════════════════════════════════════════════════════════

describe("each protected server function accepts it through its file's one schema and forwards it", () => {
  const files: [string, string[]][] = [
    ["src/api/orders.ts", ["createOrderFn", "transitionOrderLifecycleFn"]],
    ["src/api/payments.ts", ["recordPaymentFn"]],
  ];
  for (const [file, fns] of files) {
    const source = read(file);
    it(`${file}: one schema, defined once, used only by the protected validators`, () => {
      expect(count(source, "const expectedPrincipalSchema = z")).toBe(1);
      expect(source).toMatch(
        /const expectedPrincipalSchema = z\s*\.object\(\{ userId: z\.string\(\)\.uuid\(\), organizationId: z\.string\(\)\.uuid\(\) \}\)\s*\.optional\(\);/,
      );
      expect(count(source, "expectedPrincipal: expectedPrincipalSchema,")).toBe(fns.length);
    });
    for (const name of fns) {
      it(`${name}: accepts it, derives the acting principal itself, forwards it to the service`, () => {
        const block = between(source, `export const ${name} = createServerFn`, "\n  });\n");
        expect(block).toContain("expectedPrincipal: expectedPrincipalSchema,");
        const derive = block.indexOf("const authCtx = await resolveAuthContext();");
        expect(derive).toBeGreaterThan(0);
        expect(block.indexOf("data.expectedPrincipal")).toBeGreaterThan(derive);
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Client adapters: required, captured before the lazy import, sent
// ═══════════════════════════════════════════════════════════════════════════

describe("each client adapter sends the principal it was given", () => {
  const api = read("src/lib/api/index.ts");

  it("confirmRealOrder / cancelRealOrder: a REQUIRED principal, sent as expectedPrincipal", () => {
    for (const name of ["confirmRealOrder", "cancelRealOrder"]) {
      const fn = between(api, `export async function ${name}(`, "\n}\n");
      expect(fn).toContain("principal: { userId: string; organizationId: string },");
      expect(fn).not.toContain("principal?:");
      expect(fn).toContain("expectedPrincipal: principal");
    }
  });

  it("recordRealPayment: a REQUIRED principal, taken before the lazy import and sent", () => {
    const input = between(api, "export interface RecordRealPaymentInput", "\n}\n");
    expect(input).toContain("principal: { userId: string; organizationId: string };");
    expect(input).not.toContain("principal?:");
    const fn = between(api, "export async function recordRealPayment(", "\n}\n");
    expect(fn.indexOf("const { principal } = input;")).toBeGreaterThan(0);
    expect(fn.indexOf("const { principal } = input;")).toBeLessThan(
      fn.indexOf('await import("@/api/payments")'),
    );
    expect(fn).toContain("expectedPrincipal: principal,");
  });

  it("createRealOrder: sends it as expectedPrincipal, outside the replay fingerprint", () => {
    // Outside the fingerprint: the key holder is already scoped to one principal.
    expect(api).toMatch(/const \{ idempotency, principal, \.\.\.request \} = input;/);
    const fn = between(api, "export async function createRealOrder(", "\n}\n");
    expect(fn).toMatch(/\.\.\.\(principal \? \{ expectedPrincipal: principal \} : \{\}\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Call sites: the attempt's own principal, captured when the merchant acted
// ═══════════════════════════════════════════════════════════════════════════

describe("every call site passes the principal its attempt was started as", () => {
  it("POS: one principal per checkout attempt — the token's — for its create AND its confirm; the till's for a payment", () => {
    const pos = read("src/components/pos/PosCheckoutSheet.tsx");
    const completeReal = between(pos, "async function completeReal", "const realConfirmed");
    expect(count(completeReal, SANCTIONED_POS_ATTEMPT_PRINCIPAL)).toBe(1);
    const create = between(completeReal, "await createRealOrder({", "});");
    expect(create).toMatch(/\n\s*principal,\n/);
    expect(completeReal).toContain("await confirmRealOrder(orderId, principal);");
    // The payment's principal travels in the mutation's variables, fixed at submit.
    expect(pos).toMatch(
      /recordPaymentMutation\.mutate\(\{[\s\S]*?orderId: realDetail\.order\.id,[\s\S]*?principal: \{ userId, organizationId \},[\s\S]*?\}\)/,
    );
    expect(between(pos, "const recordPaymentMutation", "onMutate:")).toContain(
      "principal: submit.principal,",
    );
  });

  it("Orders → New Order: the attempt token's principal", () => {
    const sheet = read("src/components/orders/CreateRealOrderSheet.tsx");
    expect(between(sheet, "await createRealOrder({", "});")).toContain(
      SANCTIONED_NEW_ORDER_CALL_ARG,
    );
  });

  it("Inbox → Prepare Order: the replay scope's principal — for its create, confirm and discard", () => {
    const sheet = read("src/components/inbox/PrepareOrderSheet.tsx");
    expect(sheet).toMatch(/const \{ userId, organizationId, conversationId \} = replayScope;/);
    expect(between(sheet, "await createRealOrder({", "});")).toMatch(
      /idempotency: claim,[\s\S]*principal: \{ userId, organizationId \},\s*$/,
    );
    expect(count(sheet, SANCTIONED_INBOX_CALL_ARG)).toBe(1);
    expect(sheet).toContain(
      "await confirmRealOrder(step.detail.order.id, { userId, organizationId });",
    );
    expect(between(sheet, "await cancelRealOrder(", ");")).toMatch(
      /step\.detail\.order\.id,[\s\S]*\{ userId, organizationId \},/,
    );
    // …and that scope is the only one the route mounts this sheet for.
    const route = read("src/routes/app.inbox.$id.tsx");
    expect(route).toMatch(/key=\{`prepare:\$\{orderScope\}`\}/);
    expect(route).toMatch(
      /const orderScope = `\$\{userId\}\\u0000\$\{routeOrganizationId\}\\u0000\$\{id\}`;/,
    );
    expect(route).toMatch(
      /replayScope=\{\{ userId, organizationId: routeOrganizationId, conversationId: id \}\}/,
    );
  });

  it("Order detail: the route's principal, handed to each mutation as a variable at the tap", () => {
    const route = read("src/routes/app.orders.$id.tsx");
    expect(count(route, "const principal = { userId, organizationId: routeOrganizationId };")).toBe(
      1,
    );
    expect(route).toContain("onClick={() => confirmMutation.mutate(principal)}");
    expect(route).toContain(
      "onConfirm={(reason) => cancelMutation.mutate({ reason, startedAs: principal })}",
    );
    expect(route).toContain(
      "onConfirm={(submit) => recordPaymentMutation.mutate({ ...submit, startedAs: principal })}",
    );
    // The mutation functions send the variable — never a principal re-read later.
    expect(route).toContain(
      "mutationFn: (startedAs: typeof principal) => confirmRealOrder(id, startedAs),",
    );
    expect(route).toContain("cancelRealOrder(id, startedAs, reason || undefined),");
    expect(between(route, "const recordPaymentMutation = useMutation({", "onSuccess:")).toContain(
      "principal: submit.startedAs,",
    );
  });
});

describe("no call site anywhere in the app omits it", () => {
  const ADAPTERS = ["createRealOrder", "confirmRealOrder", "cancelRealOrder", "recordRealPayment"];
  /** Every .ts/.tsx under src/, except tests and the adapters' own definitions. */
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "tests" ? [] : sources(path);
      return /\.(ts|tsx)$/.test(name) && path.replace(/\\/g, "/") !== "src/lib/api/index.ts"
        ? [path]
        : [];
    });
  }
  /** The argument text of the call that opens at `start` (its "("), balanced. */
  function argumentsAt(source: string, start: number): string {
    let depth = 0;
    for (let i = start; i < source.length; i++) {
      if (source[i] === "(") depth += 1;
      if (source[i] === ")" && --depth === 0) return source.slice(start + 1, i);
    }
    throw new Error("unbalanced call");
  }

  it("every call of a protected adapter passes a principal", () => {
    const calls: string[] = [];
    for (const file of sources("src")) {
      const source = read(file);
      for (const name of ADAPTERS) {
        const pattern = new RegExp(`(?<![\\w.])${name}\\(`, "g");
        for (const match of source.matchAll(pattern)) {
          const at = match.index!;
          // A comment's mention (e.g. "createRealOrder()'s input") is not a call.
          const line = source.slice(source.lastIndexOf("\n", at) + 1, at);
          if (/^\s*(\*|\/\/)/.test(line)) continue;
          const args = argumentsAt(source, at + name.length);
          if (args.trim() === "") continue; // a mention like createRealOrder() in prose
          calls.push(`${file}: ${name}`);
          expect(
            /\bprincipal\b|\bstartedAs\b|\{ userId(?:: [\w.]+)?, organizationId(?:: [\w.]+)? \}/.test(
              args,
            ),
            `${file}: ${name}(…) passes no principal`,
          ).toBe(true);
        }
      }
    }
    // Every known entry point was actually seen (the scan is not vacuous).
    for (const site of [
      "src/components/pos/PosCheckoutSheet.tsx: createRealOrder",
      "src/components/pos/PosCheckoutSheet.tsx: confirmRealOrder",
      "src/components/pos/PosCheckoutSheet.tsx: recordRealPayment",
      "src/components/orders/CreateRealOrderSheet.tsx: createRealOrder",
      "src/components/inbox/PrepareOrderSheet.tsx: createRealOrder",
      "src/components/inbox/PrepareOrderSheet.tsx: confirmRealOrder",
      "src/components/inbox/PrepareOrderSheet.tsx: cancelRealOrder",
      "src/routes/app.orders.$id.tsx: confirmRealOrder",
      "src/routes/app.orders.$id.tsx: cancelRealOrder",
      "src/routes/app.orders.$id.tsx: recordRealPayment",
    ]) {
      expect(calls.map((c) => c.replace(/\\/g, "/"))).toContain(site);
    }
  });
});
