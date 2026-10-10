/**
 * The initiating-principal contract (CORRECTIONS.md, CORRECTION-004), pinned at
 * every layer of every protected mutation:
 *
 *   order creation           createOrderFn → createOrder
 *                            (POS checkout, Orders → New Order, Inbox → Prepare Order)
 *   lifecycle transitions    transitionOrderLifecycleFn → transitionLifecycleStatus
 *                            (Confirm / Cancel: Order detail, Inbox draft, POS sale)
 *   fulfillment transitions  transitionOrderFulfillmentFn → transitionFulfillmentStatus
 *   parcel recovery          recoverOrderParcelFn → recoverOrderParcel (Order detail)
 *   parcel creation          createParcelFn → createParcelForOrder
 *   shipping destination     updateOrderShippingFn → updateOrderShippingSnapshot
 *                            (parcel label dialog → Confirm shipping address)
 *   payment recording        recordPaymentFn → recordPayment (Order detail, POS)
 *   payment evidence         attachPaymentEvidenceFn → attachEvidence
 *   payment verification     verifyPaymentFn → verifyPayment (Payment detail)
 *   refund                   refundPaymentFn → refundPayment (Payment detail)
 *   reversal                 reversePaymentFn → reversePayment (Payment detail)
 *   correction               correctPaymentFn → correctPayment
 *
 * The server derives who is acting only when it HANDLES a request. Each of these
 * REQUIRES the member + organization it was STARTED as, and the server refuses —
 * before the permission, any limit, read or write — when it is missing,
 * malformed, or different from its own derivation. Behaviour, against the
 * database and the real server functions: financial-mutation-integrity,
 * payment-action-principal-mounted, order-mutation-principal-mounted,
 * order-entry-principal-mounted and pos-checkout-replay-mounted. This file
 * stops the wiring coming apart silently: a validator that makes the field
 * optional again, a handler that stops forwarding it (or forwards it only when
 * present), a service that checks it after a write or reads it for anything
 * else, an adapter that stops requiring or sending it, a call site that never
 * passes one, or a new mutation in these files that skips it.
 *
 * Not covered (CORRECTION-004 lists them): mutations outside these files —
 * deliveries, packing, handoff, inventory, returns, customers, team, products,
 * conversations — and the deprecated transitionOrderPaymentFn, which always
 * refuses and writes nothing.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertExpectedPrincipal } from "@/server/auth/expected-principal";
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
  const A = { userId: "member-a", organizationId: "organization-a" };
  const codeOf = (expected: unknown) => {
    try {
      assertExpectedPrincipal(A, expected as never);
      return "passed";
    } catch (error) {
      return `${(error as { statusCode?: number }).statusCode}:${(error as { code?: string }).code}`;
    }
  };

  it("FAILS CLOSED: a missing or malformed principal is refused as 428 principal_required", () => {
    for (const expected of [
      undefined,
      null,
      {},
      "member-a",
      [A.userId, A.organizationId],
      { userId: A.userId },
      { organizationId: A.organizationId },
      { userId: "", organizationId: A.organizationId },
      { userId: A.userId, organizationId: 7 },
      { ...A, role: "OWNER" },
    ]) {
      expect({ expected, code: codeOf(expected) }).toEqual({
        expected,
        code: "428:principal_required",
      });
    }
    expect(fn).not.toMatch(/if \(!expected\) return/);
  });

  it("refuses any difference in member or organization as 409 principal_changed, and passes only an exact match", () => {
    expect(codeOf({ ...A })).toBe("passed");
    expect(codeOf({ ...A, userId: "member-b" })).toBe("409:principal_changed");
    expect(codeOf({ ...A, organizationId: "organization-b" })).toBe("409:principal_changed");
    expect(codeOf({ userId: "member-b", organizationId: "organization-b" })).toBe(
      "409:principal_changed",
    );
  });

  it("can do nothing else: read only in that comparison, never returned", () => {
    expect(fn.match(/expected\.(userId|organizationId)/g)).toHaveLength(2);
    expect(fn).not.toMatch(/return\s+expected/);
    expect(fn).toMatch(/\): void \{/);
  });

  it("lives in one place: no service keeps its own copy", () => {
    for (const file of [
      "src/server/orders/service.ts",
      "src/server/payments/service.ts",
      "src/server/parcels/service.ts",
    ]) {
      const source = read(file);
      expect(source).toContain('from "@/server/auth/expected-principal"');
      expect(source).not.toMatch(/function assertExpectedPrincipal/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Services: checked first, read once, never an actor
// ═══════════════════════════════════════════════════════════════════════════

interface ServiceCase {
  name: string;
  file: string;
  check: string;
  later: string[];
  writesAs: RegExp;
}

const SERVICE_CASES: ServiceCase[] = [
  {
    name: "createOrder",
    file: "src/server/orders/service.ts",
    check: "assertExpectedPrincipal(ctx, input.expectedPrincipal);",
    later: [
      'ctx.require("orders.create")',
      "enforceOrderCreateLimit(",
      "repo.findCustomerForOrg(",
      "repo.createOrder(",
      "bestEffortAudit(",
    ],
    writesAs: /repo\.createOrder\(ctx\.organizationId, ctx\.userId,/,
  },
  {
    name: "transitionLifecycleStatus",
    file: "src/server/orders/service.ts",
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
  },
  {
    name: "transitionFulfillmentStatus",
    file: "src/server/orders/service.ts",
    check: "assertExpectedPrincipal(ctx, expectedPrincipal);",
    later: [
      "ctx.require(FULFILLMENT_TRANSITION_PERMISSIONS[to])",
      "loadTransitionTarget(",
      "reopenFulfillmentWithRetry(",
      "repo.transitionStatus(",
      "bestEffortAudit(",
    ],
    writesAs:
      /repo\.transitionStatus\(\s*ctx\.organizationId,\s*orderId,\s*"fulfillment",\s*from,\s*to,\s*ctx\.userId,/,
  },
  {
    name: "recoverOrderParcel",
    file: "src/server/orders/service.ts",
    check: "assertExpectedPrincipal(ctx, expectedPrincipal);",
    later: ['ctx.require("orders.confirm")', "recoverParcelAtomically(", "auditParcelRecovered("],
    writesAs: /recoverParcelAtomically\(ctx, orderId\)/,
  },
  {
    name: "updateOrderShippingSnapshot",
    file: "src/server/orders/service.ts",
    check: "assertExpectedPrincipal(ctx, expectedPrincipal);",
    later: [
      'ctx.require("orders.update")',
      "normalizeShippingSnapshot(",
      "repo.updateOrderShipping(",
      "bestEffortAudit(",
    ],
    writesAs: /repo\.updateOrderShipping\(ctx\.organizationId, orderId, ctx\.userId, shipping\)/,
  },
  {
    name: "createParcelForOrder",
    file: "src/server/parcels/service.ts",
    check: "assertExpectedPrincipal(ctx, expectedPrincipal);",
    later: ['ctx.require("fulfillment.create_parcel")', "ordersRepo.recoverOrderParcel("],
    writesAs: /ordersRepo\.recoverOrderParcel\(ctx\.organizationId, orderId, ctx\.userId\)/,
  },
  {
    name: "recordPayment",
    file: "src/server/payments/service.ts",
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
  },
  {
    name: "attachEvidence",
    file: "src/server/payments/service.ts",
    check: "assertExpectedPrincipal(ctx, input.expectedPrincipal);",
    later: [
      'ctx.require("payments.record")',
      "enforcePaymentMutationLimit(",
      "loadTargetForEvidence(",
      "repo.attachEvidence(",
      "bestEffortAudit(",
    ],
    writesAs: /repo\.attachEvidence\(ctx\.organizationId, ctx\.userId,/,
  },
  {
    name: "verifyPayment",
    file: "src/server/payments/service.ts",
    check: "assertExpectedPrincipal(ctx, expectedPrincipal);",
    later: [
      "VERIFICATION_TRANSITION_PERMISSIONS[to]",
      "ctx.require(permission)",
      "enforcePaymentMutationLimit(",
      "loadTransitionTarget(",
      "repo.verifyPayment(",
      "bestEffortAudit(",
    ],
    writesAs: /repo\.verifyPayment\(\s*ctx\.organizationId,\s*paymentId,\s*ctx\.userId,/,
  },
  {
    name: "refundPayment",
    file: "src/server/payments/service.ts",
    check: "assertExpectedPrincipal(ctx, input.expectedPrincipal);",
    later: [
      'ctx.require("payments.refund")',
      "enforcePaymentReversalLimit(",
      "repo.findPaymentById(",
      "repo.refundPayment(",
    ],
    writesAs: /repo\.refundPayment\(\s*ctx\.organizationId,\s*input\.paymentId,\s*ctx\.userId,/,
  },
  {
    name: "reversePayment",
    file: "src/server/payments/service.ts",
    check: "assertExpectedPrincipal(ctx, expectedPrincipal);",
    later: [
      'ctx.require("payments.reverse")',
      "enforcePaymentReversalLimit(",
      "loadTransitionTarget(",
      "repo.reversePayment(",
    ],
    writesAs: /repo\.reversePayment\(\s*ctx\.organizationId,\s*paymentId,\s*ctx\.userId,/,
  },
  {
    name: "correctPayment",
    file: "src/server/payments/service.ts",
    check: "assertExpectedPrincipal(ctx, expectedPrincipal);",
    later: [
      'ctx.require("payments.override_status")',
      "enforcePaymentReversalLimit(",
      "repo.findPaymentById(",
      "repo.correctPayment(",
    ],
    writesAs: /repo\.correctPayment\(\s*ctx\.organizationId,\s*paymentId,\s*ctx\.userId,/,
  },
];

describe("each protected service checks it before anything else and records only ctx", () => {
  for (const c of SERVICE_CASES) {
    const body = between(read(c.file), `export async function ${c.name}(`, "\n}\n");

    it(`${c.name}: a REQUIRED parameter, checked as the first statement — before the permission, any limit, read or write`, () => {
      expect(body).not.toMatch(/expectedPrincipal\?:/);
      const open = body.indexOf("> {\n");
      expect(open).toBeGreaterThan(0);
      const firstStatement = body
        .slice(open + 4)
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith("//") && !/^\/?\*/.test(line));
      expect(firstStatement).toBe(c.check);
      const at = body.indexOf(c.check);
      for (const step of c.later) {
        expect({ step, after: body.indexOf(step) > at }).toEqual({ step, after: true });
      }
    });

    it(`${c.name}: read only by that check, and every write is attributed to ctx`, () => {
      const reads = c.check.includes("input.")
        ? (body.match(/input\.expectedPrincipal/g) ?? [])
        : (body.match(/\bexpectedPrincipal\b/g) ?? []);
      // An input field is read once (the check); a parameter is declared once and read once.
      expect(reads).toHaveLength(c.check.includes("input.") ? 1 : 2);
      expect(body).not.toMatch(/expected(Principal)?\.(userId|organizationId)/);
      expect(body).toMatch(c.writesAs);
    });
  }

  it("each input type declares the field as required", () => {
    const orders = read("src/server/orders/service.ts");
    const payments = read("src/server/payments/service.ts");
    expect(between(orders, "export interface CreateOrderServiceInput", "\n}\n")).toContain(
      "expectedPrincipal: ExpectedPrincipal;",
    );
    expect(between(payments, "export interface RecordPaymentServiceInput", "\n}\n")).toContain(
      "expectedPrincipal: ExpectedPrincipal;",
    );
    expect(between(payments, "export interface AttachEvidenceServiceInput", "\n}\n")).toContain(
      "expectedPrincipal: ExpectedPrincipal;",
    );
    expect(between(payments, "export interface RefundPaymentServiceInput", "\n}\n")).toContain(
      "expectedPrincipal: ExpectedPrincipal;",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Server functions: required through one schema, forwarded unconditionally
// ═══════════════════════════════════════════════════════════════════════════

const PROTECTED_FNS: [string, string[]][] = [
  [
    "src/api/orders.ts",
    [
      "createOrderFn",
      "updateOrderShippingFn",
      "transitionOrderLifecycleFn",
      "recoverOrderParcelFn",
      "transitionOrderFulfillmentFn",
    ],
  ],
  [
    "src/api/payments.ts",
    [
      "recordPaymentFn",
      "attachPaymentEvidenceFn",
      "verifyPaymentFn",
      "reversePaymentFn",
      "refundPaymentFn",
      "correctPaymentFn",
    ],
  ],
  ["src/api/parcels.ts", ["createParcelFn"]],
];
/** POST functions in those files that are deliberately outside the contract. */
const EXEMPT_POST_FNS: Record<string, string> = {
  // Always refuses (409 after the permission check) and writes nothing.
  transitionOrderPaymentFn: "deprecated; never mutates",
};

describe("each protected server function requires it through its file's one schema and forwards it", () => {
  for (const [file, fns] of PROTECTED_FNS) {
    const source = read(file);
    it(`${file}: one strict, REQUIRED schema, used by exactly the protected validators`, () => {
      expect(count(source, "const expectedPrincipalSchema = z")).toBe(1);
      expect(source).toMatch(
        /const expectedPrincipalSchema = z\s*\.object\(\{ userId: z\.string\(\)\.uuid\(\), organizationId: z\.string\(\)\.uuid\(\) \}\)\s*\.strict\(\);/,
      );
      expect(source).not.toMatch(/expectedPrincipalSchema[\s\S]{0,4}\.(optional|nullish)\(/);
      expect(count(source, "expectedPrincipal: expectedPrincipalSchema,")).toBe(fns.length);
      // Forwarded unconditionally — never only "when present".
      expect(source).not.toMatch(/data\.expectedPrincipal\s*\?/);
    });

    it(`${file}: every POST server function is protected or explicitly exempt`, () => {
      const posts = [
        ...source.matchAll(/export const (\w+) = createServerFn\(\{ method: "POST" \}\)/g),
      ].map((m) => m[1]!);
      for (const name of posts) {
        expect({ name, covered: fns.includes(name) || name in EXEMPT_POST_FNS }).toEqual({
          name,
          covered: true,
        });
      }
    });

    for (const name of fns) {
      it(`${name}: requires it, derives the acting principal itself, forwards it to the service`, () => {
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
// Client adapters: required, sent
// ═══════════════════════════════════════════════════════════════════════════

const ADAPTERS = [
  "createRealOrder",
  "confirmRealOrder",
  "cancelRealOrder",
  "recoverRealOrderParcel",
  "updateOrderShipping",
  "recordRealPayment",
  "verifyRealPayment",
  "refundRealPayment",
  "reverseRealPayment",
];

describe("each client adapter requires the principal and sends it", () => {
  const api = read("src/lib/api/index.ts");

  it("the client spells the shape once; adapters name the type, never an optional field", () => {
    expect(read("src/lib/initiating-principal.ts")).toMatch(
      /export interface InitiatingPrincipal \{\n {2}userId: string;\n {2}organizationId: string;\n\}/,
    );
    expect(api).toContain('import type { InitiatingPrincipal } from "@/lib/initiating-principal";');
    expect(api).not.toMatch(/principal\?:/);
    expect(api).not.toMatch(/principal: \{ userId/);
  });

  for (const name of ADAPTERS) {
    it(`${name}: a REQUIRED principal, sent as expectedPrincipal`, () => {
      const fn = between(api, `export async function ${name}(`, "\n}\n");
      if (name === "createRealOrder" || name === "recordRealPayment") {
        const input =
          name === "createRealOrder" ? "CreateRealOrderInput" : "RecordRealPaymentInput";
        expect(between(api, `export interface ${input}`, "\n}\n")).toContain(
          "principal: InitiatingPrincipal;",
        );
      } else {
        expect(fn).toContain("principal: InitiatingPrincipal,");
      }
      expect(fn).toMatch(/expectedPrincipal: principal\b/);
      expect(fn).not.toMatch(/principal \?/);
    });
  }

  it("createRealOrder: outside the replay fingerprint; recordRealPayment: taken before the lazy import", () => {
    expect(api).toMatch(/const \{ idempotency, principal, \.\.\.request \} = input;/);
    const record = between(api, "export async function recordRealPayment(", "\n}\n");
    expect(record.indexOf("const { principal } = input;")).toBeGreaterThan(0);
    expect(record.indexOf("const { principal } = input;")).toBeLessThan(
      record.indexOf('await import("@/api/payments")'),
    );
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
    expect(route).toContain(
      "mutationFn: (startedAs: typeof principal) => confirmRealOrder(id, startedAs),",
    );
    expect(route).toContain("cancelRealOrder(id, startedAs, reason || undefined),");
    expect(between(route, "const recordPaymentMutation = useMutation({", "onSuccess:")).toContain(
      "principal: submit.startedAs,",
    );
  });

  it("Payment detail: the route's principal, handed to verify / refund / reverse as a variable at the tap", () => {
    const route = read("src/routes/app.payments.$id.tsx");
    expect(
      count(route, "const memberPrincipal = { userId, organizationId: routeOrganizationId };"),
    ).toBe(1);
    expect(route).toContain("verifyRealPayment(id, to, startedAs, reason)");
    expect(route).toMatch(/refundRealPayment\(id, attempt\.startedAs, \{/);
    expect(route).toContain("reverseRealPayment(id, startedAs, reason)");
    // Each tap passes the principal it was made as — never one re-read later.
    expect(count(route, "startedAs: memberPrincipal")).toBe(3);
  });

  it("APSA Parcel recovery: captured at the tap, as a mutation variable", () => {
    const action = read("src/components/fulfillment/ParcelRecoveryAction.tsx");
    expect(action).toContain("recoverRealOrderParcel(orderId, startedAs)");
    expect(action).toMatch(
      /recover\.mutate\(\{\s*token: latestRequestRef\.current,\s*startedAs: \{ userId, organizationId \},\s*\}\)/,
    );
  });

  it("Shipping destination: the host's principal, captured when Save is tapped", () => {
    const sheet = read("src/components/orders/ShippingDestinationSheet.tsx");
    const save = between(sheet, "async function save()", "\n  }\n");
    expect(save.indexOf("const startedAs = principal;")).toBeGreaterThan(0);
    expect(save.indexOf("const startedAs = principal;")).toBeLessThan(
      save.indexOf("await updateOrderShipping("),
    );
    expect(save).toContain("await updateOrderShipping(orderId, payload, startedAs);");
    expect(read("src/components/labels/ParcelLabelDialog.tsx")).toContain(
      "principal={{ userId, organizationId }}",
    );
  });
});

describe("no call site anywhere in the app omits it", () => {
  /**
   * Every browser-side .ts/.tsx under src/ — not tests, not the server
   * (src/server, src/api: a repository's own updateOrderShipping is not the
   * adapter), and not the adapters' own definitions.
   */
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      const normalized = path.replace(/\\/g, "/");
      if (statSync(path).isDirectory()) {
        return name === "tests" || normalized === "src/server" || normalized === "src/api"
          ? []
          : sources(path);
      }
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
      "src/routes/app.payments.$id.tsx: verifyRealPayment",
      "src/routes/app.payments.$id.tsx: refundRealPayment",
      "src/routes/app.payments.$id.tsx: reverseRealPayment",
      "src/components/fulfillment/ParcelRecoveryAction.tsx: recoverRealOrderParcel",
      "src/components/orders/ShippingDestinationSheet.tsx: updateOrderShipping",
    ]) {
      expect(calls.map((c) => c.replace(/\\/g, "/"))).toContain(site);
    }
  });
});
