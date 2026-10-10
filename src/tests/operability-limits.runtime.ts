/**
 * Operability limits — behavioural runtime checks through the REAL auth server
 * functions and the REAL order / payment services. Run in a child process by
 * operability-limits.test.ts because mock.module is process-global.
 *
 * Supabase Auth, the cookie layer and the order/payment repositories are
 * replaced by small fakes; the rate limiter itself is real, pinned to its
 * memory store (the SQL store is proven separately against PGlite in
 * operability-sql.runtime.ts). Time is driven with setSystemTime.
 */
import { afterAll, beforeEach, describe, expect, it, mock, setSystemTime } from "bun:test";
import { principalOf } from "./helpers/refuse-only-principal";

function createServerFnMock() {
  return () => ({
    validator(validator: (data: unknown) => unknown) {
      return {
        handler<TArgs extends { data: unknown }, TResult>(
          handler: (args: { data: TArgs["data"] }) => TResult | Promise<TResult>,
        ) {
          return async ({ data }: TArgs) => handler({ data: validator(data) as TArgs["data"] });
        },
      };
    },
    handler<TResult>(handler: () => TResult | Promise<TResult>) {
      return handler;
    },
  });
}

// ── Request / cookies ────────────────────────────────────────────────────────
let clientIp: string | undefined = "203.0.113.10";
const cookies = new Map<string, string>();
mock.module("@tanstack/react-start", () => ({ createServerFn: createServerFnMock() }));
mock.module("@tanstack/react-start/server", () => ({
  getCookie: (name: string) => cookies.get(name),
  setCookie: () => {},
  deleteCookie: () => {},
  getRequestHeader: (name: string) => (name === "cf-connecting-ip" ? clientIp : undefined),
}));

// ── Fake Supabase Auth: only KNOWN has an account ───────────────────────────
const KNOWN = "owner@example.com";
const UNKNOWN = "nobody@example.com";
const providerCalls: Array<{ op: string; email: string }> = [];
mock.module("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: async ({ email }: { email: string }) => {
        providerCalls.push({ op: "signIn", email });
        // Wrong password for the known account and "no such user" look the same
        // to GoTrue callers: 400 invalid_credentials.
        return {
          data: { session: null, user: null },
          error: { status: 400, code: "invalid_credentials", message: "Invalid login credentials" },
        };
      },
      resetPasswordForEmail: async (email: string) => {
        providerCalls.push({ op: "reset", email });
        return { data: {}, error: null };
      },
      signUp: async ({ email }: { email: string }) => {
        providerCalls.push({ op: "signUp", email });
        return { data: { session: null, user: null }, error: null };
      },
      verifyOtp: async ({ email }: { email?: string }) => {
        providerCalls.push({ op: "verifyOtp", email: email ?? "" });
        return { data: { session: null }, error: { status: 400, message: "Token has expired" } };
      },
      setSession: async ({ refresh_token }: { refresh_token: string }) => {
        providerCalls.push({ op: "setSession", email: refresh_token });
        return { data: {}, error: null };
      },
      // Reaching the password update is what the recovery test observes.
      updateUser: async () => ({ data: {}, error: { code: "same_password", status: 422 } }),
      signOut: async () => ({ error: null }),
    },
  }),
}));

// Every service-role call (audit_logs inserts included) is recorded.
const adminCalls: string[] = [];
mock.module("@/lib/supabase/server", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createRefreshClient: () => ({}),
  supabaseAdmin: {
    from: (table: string) => {
      adminCalls.push(`from:${table}`);
      return { insert: async () => ({ error: null }) };
    },
    rpc: async (fn: string) => {
      adminCalls.push(`rpc:${fn}`);
      return { data: null, error: { code: "PGRST202", message: "not in this fake" } };
    },
  },
}));

// ── Fake order / payment repositories ───────────────────────────────────────
let orderRpcCalls = 0;
const existingOrderKeys = new Set<string>();
mock.module("@/server/orders/repository", () => ({
  orderExistsForIdempotencyKey: async (org: string, user: string, key: string) =>
    existingOrderKeys.has(`${org}|${user}|${key}`),
  findVariantForOrg: async () => ({ product_id: "00000000-0000-4000-8000-00000000000a" }),
  findCustomerForOrg: async () => ({ id: "c" }),
  findLocationForOrg: async () => ({ id: "l" }),
  // Reaching the RPC is what this test observes; the conflict answer keeps the
  // service from needing a read-back fake.
  createOrder: async () => {
    orderRpcCalls++;
    return { status: "idempotency_conflict" };
  },
}));

// Every payment repository export is counted: reads, RPC mutations, events.
let paymentRepoCalls = 0;
const paymentRepoCallNames: string[] = [];
const PAYMENT_REPO_EXPORTS = [
  ...(await Bun.file("src/server/payments/repository.ts").text()).matchAll(
    /^export (?:async )?function (\w+)/gm,
  ),
].map((m) => m[1]!);
mock.module("@/server/payments/repository", () =>
  Object.fromEntries(
    PAYMENT_REPO_EXPORTS.map((name) => [
      name,
      async () => {
        paymentRepoCalls++;
        paymentRepoCallNames.push(name);
        return null;
      },
    ]),
  ),
);

// ── Log capture ─────────────────────────────────────────────────────────────
const { setLogSink } = await import("@/server/observability/logger");
const logLines: string[] = [];
setLogSink((_level, line) => logLines.push(line));
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => logLines.push(args.map(String).join(" "));

process.env["VITE_SUPABASE_URL"] = "https://apsa.test.supabase.co";
process.env["VITE_SUPABASE_ANON_KEY"] = "anon-test-key";
process.env["VITE_APP_URL"] = "https://app.apsa.test/";
// The deployment pins its proxy header explicitly; without it NO header is trusted.
process.env["RATE_LIMIT_CLIENT_IP_HEADER"] = "cf-connecting-ip";

const auth = await import("@/api/auth");
const { setPrimaryRateLimitStore, resetRateLimitFallbackStore } =
  await import("@/server/rate-limit/limiter");
const { MemoryRateLimitStore, PostgresRateLimitStore } = await import("@/server/rate-limit/store");
const { RateLimitUnavailableError } = await import("@/server/rate-limit/errors");
const { COOKIE_RECOVERY_ACCESS_TOKEN, COOKIE_RECOVERY_REFRESH_TOKEN } = auth;
const { RATE_LIMITS } = await import("@/server/rate-limit/policies");
const { RateLimitedError } = await import("@/server/rate-limit/errors");
const { AuthorizationContext } = await import("@/server/auth/authorization");
const orders = await import("@/server/orders/service");
const payments = await import("@/server/payments/service");

let now = Date.UTC(2026, 8, 28, 9, 0, 0);
function advance(seconds: number) {
  now += seconds * 1000;
  setSystemTime(new Date(now));
}

beforeEach(() => {
  setPrimaryRateLimitStore(new MemoryRateLimitStore());
  resetRateLimitFallbackStore();
  providerCalls.length = 0;
  orderRpcCalls = 0;
  paymentRepoCalls = 0;
  paymentRepoCallNames.length = 0;
  adminCalls.length = 0;
  cookies.clear();
  existingOrderKeys.clear();
  clientIp = "203.0.113.10";
  advance(24 * 3600); // every test starts in fresh windows
});

afterAll(() => {
  setSystemTime();
  console.error = originalConsoleError;
});

// ── Auth ────────────────────────────────────────────────────────────────────

const signIn = (email: string) =>
  auth.signInFn({ data: { email, password: "wrong-password-1" } } as never);

describe("sign-in limits", () => {
  it("are neutral: a known and an unknown address hit the limit identically", async () => {
    const known: unknown[] = [];
    const unknown: unknown[] = [];
    for (let i = 0; i < RATE_LIMITS.signInIdentity.limit + 1; i++) {
      known.push(await signIn(KNOWN));
      unknown.push(await signIn(UNKNOWN));
    }
    expect(known).toEqual(unknown);
    expect(known.at(-2)).toEqual({ ok: false, code: "invalid_credentials" });
    expect(known.at(-1)).toEqual({ ok: false, code: "rate_limited" });
    // The refused attempt never reached Supabase.
    expect(providerCalls.filter((c) => c.email === KNOWN)).toHaveLength(
      RATE_LIMITS.signInIdentity.limit,
    );
  });

  it("key on the normalized address: case and spacing do not buy fresh attempts", async () => {
    for (let i = 0; i < RATE_LIMITS.signInIdentity.limit; i++) {
      await signIn(i % 2 ? KNOWN.toUpperCase() : ` ${KNOWN} `.trim());
    }
    expect(await signIn("Owner@Example.com")).toEqual({ ok: false, code: "rate_limited" });
    // Another address from the same IP is unaffected.
    expect(await signIn("second@example.com")).toEqual({ ok: false, code: "invalid_credentials" });
  });

  it("release after the window — exactly at the boundary, not before", async () => {
    for (let i = 0; i <= RATE_LIMITS.signInIdentity.limit; i++) await signIn(KNOWN);
    advance(RATE_LIMITS.signInIdentity.windowSeconds - 1);
    expect(await signIn(KNOWN)).toEqual({ ok: false, code: "rate_limited" });
    advance(1);
    expect(await signIn(KNOWN)).toEqual({ ok: false, code: "invalid_credentials" });
  });

  it("bound one IP spraying many addresses; another IP is unaffected", async () => {
    for (let i = 0; i < RATE_LIMITS.signInIp.limit; i++) {
      expect(await signIn(`user${i}@example.com`)).toEqual({
        ok: false,
        code: "invalid_credentials",
      });
    }
    expect(await signIn("fresh@example.com")).toEqual({ ok: false, code: "rate_limited" });
    clientIp = "203.0.113.11";
    expect(await signIn("fresh@example.com")).toEqual({ ok: false, code: "invalid_credentials" });
  });

  it("IPv6 clients cannot escape by rotating within their /64", async () => {
    for (let i = 0; i < RATE_LIMITS.signInIp.limit; i++) {
      clientIp = `2001:db8:1:2::${(i + 1).toString(16)}`;
      await signIn(`v6user${i}@example.com`);
    }
    clientIp = "2001:db8:1:2:ffff::9";
    expect(await signIn("v6fresh@example.com")).toEqual({ ok: false, code: "rate_limited" });
  });

  it("with no determinable client IP, only the identity bucket applies (no shared pool)", async () => {
    clientIp = undefined;
    for (let i = 0; i < RATE_LIMITS.signInIp.limit + 5; i++) {
      expect(await signIn(`noip${i}@example.com`)).toEqual({
        ok: false,
        code: "invalid_credentials",
      });
    }
  });
});

describe("password-reset limits keep the anti-enumeration answer", () => {
  const reset = (email: string) => auth.requestPasswordResetFn({ data: { email } } as never);

  it("cooldown: the second request inside 60 s is answered identically but not sent", async () => {
    for (const email of [KNOWN, UNKNOWN]) {
      expect(await reset(email)).toEqual({ ok: true });
      expect(await reset(email)).toEqual({ ok: true });
    }
    expect(providerCalls.filter((c) => c.op === "reset")).toHaveLength(2);
  });

  it("hourly cap: the 6th request in an hour is neutral and not sent — for either address", async () => {
    const answers: Record<string, unknown[]> = { [KNOWN]: [], [UNKNOWN]: [] };
    for (let i = 0; i < RATE_LIMITS.authEmailHourly.limit + 1; i++) {
      for (const email of [KNOWN, UNKNOWN]) answers[email]!.push(await reset(email));
      advance(61);
    }
    expect(answers[KNOWN]).toEqual(answers[UNKNOWN]);
    expect(new Set(answers[KNOWN]!.map((a) => JSON.stringify(a)))).toEqual(
      new Set([JSON.stringify({ ok: true })]),
    );
    const sent = providerCalls.filter((c) => c.op === "reset");
    expect(sent.filter((c) => c.email === KNOWN)).toHaveLength(RATE_LIMITS.authEmailHourly.limit);
    expect(sent.filter((c) => c.email === UNKNOWN)).toHaveLength(RATE_LIMITS.authEmailHourly.limit);
  });
});

describe("OTP / recovery-link verification limits", () => {
  it("a guessed 6-digit code is bounded per address", async () => {
    const verify = (token: string) =>
      auth.verifyEmailFn({ data: { email: KNOWN, token, type: "signup" } } as never);
    for (let i = 0; i < RATE_LIMITS.otpVerifyIdentity.limit; i++) {
      expect(await verify(String(100000 + i))).toEqual({ ok: false, code: "invalid_token" });
    }
    expect(await verify("999999")).toEqual({ ok: false, code: "rate_limited" });
    expect(providerCalls.filter((c) => c.op === "verifyOtp")).toHaveLength(
      RATE_LIMITS.otpVerifyIdentity.limit,
    );
  });

  it("recovery links are bounded too, and the refusal is not an 'invalid link'", async () => {
    const begin = (email: string, token: string) =>
      auth.beginPasswordRecoveryFn({ data: { email, token } } as never);
    for (let i = 0; i < RATE_LIMITS.otpVerifyIdentity.limit; i++) await begin(KNOWN, `${i}`);
    expect(await begin(KNOWN, "x")).toEqual({ ok: false, code: "rate_limited" });
  });
});

describe("header-independent auth dimensions (no trusted client IP)", () => {
  it("sign-up: repeated attempts for one address are bounded with no IP, identically for a taken or free address", async () => {
    clientIp = undefined;
    const signUp = (email: string) =>
      auth.signUpFn({ data: { email, password: "long-enough-1", displayName: "N" } } as never);
    const known: unknown[] = [];
    const unknown: unknown[] = [];
    for (let i = 0; i < RATE_LIMITS.signUpIdentity.limit + 1; i++) {
      known.push(await signUp(KNOWN));
      unknown.push(await signUp(UNKNOWN));
    }
    expect(known).toEqual(unknown);
    expect(known.at(-1)).toEqual({ ok: false, code: "rate_limited" });
    expect(providerCalls.filter((c) => c.op === "signUp" && c.email === KNOWN)).toHaveLength(
      RATE_LIMITS.signUpIdentity.limit,
    );
  });

  it("token_hash recovery links (no email) are bounded per link token with no IP", async () => {
    clientIp = undefined;
    const begin = (tokenHash: string) =>
      auth.beginPasswordRecoveryFn({ data: { tokenHash } } as never);
    for (let i = 0; i < RATE_LIMITS.otpVerifyToken.limit; i++) {
      expect(await begin("replayed-link-token-hash")).toEqual({ ok: false, code: "invalid_link" });
    }
    expect(await begin("replayed-link-token-hash")).toEqual({ ok: false, code: "rate_limited" });
    // A different link is its own bucket.
    expect(await begin("another-link-token-hash")).toEqual({ ok: false, code: "invalid_link" });
  });

  it("recovery completion is bounded per recovery session with no IP; sessions are isolated", async () => {
    clientIp = undefined;
    const complete = () =>
      auth.completePasswordRecoveryFn({
        data: { password: "long-enough-2", confirmPassword: "long-enough-2" },
      } as never);
    cookies.set(COOKIE_RECOVERY_ACCESS_TOKEN, "recovery-access-a");
    cookies.set(COOKIE_RECOVERY_REFRESH_TOKEN, "recovery-refresh-a");
    for (let i = 0; i < RATE_LIMITS.recoveryCompleteSession.limit; i++) {
      expect(await complete()).toEqual({ ok: false, code: "same_password" });
    }
    expect(await complete()).toEqual({ ok: false, code: "unexpected_error" });
    expect(providerCalls.filter((c) => c.op === "setSession")).toHaveLength(
      RATE_LIMITS.recoveryCompleteSession.limit,
    );
    // Another recovery session is unaffected by the first one's bucket.
    cookies.set(COOKIE_RECOVERY_ACCESS_TOKEN, "recovery-access-b");
    cookies.set(COOKIE_RECOVERY_REFRESH_TOKEN, "recovery-refresh-b");
    expect(await complete()).toEqual({ ok: false, code: "same_password" });
  });
});

describe("sign-up limits", () => {
  it("bound account creation per client IP", async () => {
    const signUp = (i: number) =>
      auth.signUpFn({
        data: { email: `new${i}@example.com`, password: "long-enough-1", displayName: "N" },
      } as never);
    for (let i = 0; i < RATE_LIMITS.signUpIp.limit; i++) {
      expect(await signUp(i)).toEqual({ ok: true, emailVerificationRequired: true });
    }
    expect(await signUp(99)).toEqual({ ok: false, code: "rate_limited" });
  });
});

// ── Orders ──────────────────────────────────────────────────────────────────

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000001";
const VARIANT = "00000000-0000-4000-8000-0000000000b1";
const PERMISSIONS = [
  "orders.create",
  "payments.record",
  "payments.reverse",
  "payments.refund",
  "payments.override_status",
];

function ctxFor(org: string, user: string) {
  return new AuthorizationContext({
    membership: { user_id: user, organization_id: org, role_id: "role" },
    role: { system_role: "OWNER" },
    permissions: new Set(PERMISSIONS),
  } as never);
}

let keySeq = 0;
const newKey = () => `test-key-${String(++keySeq).padStart(12, "0")}`;

async function create(ctx: ReturnType<typeof ctxFor>, key = newKey()) {
  try {
    await orders.createOrder(ctx, {
      expectedPrincipal: principalOf(ctx),
      source: "POS",
      items: [{ variantId: VARIANT, quantity: 1 }],
      idempotencyKey: key,
    });
    return "created";
  } catch (error) {
    if (error instanceof RateLimitedError) return "rate_limited";
    const status = (error as { statusCode?: number }).statusCode;
    return status === 409 ? "reached_rpc" : `error:${String(error)}`;
  }
}

describe("order-creation limits", () => {
  const member = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

  it("below / at / above the member limit", async () => {
    const ctx = ctxFor(ORG_A, member(1));
    const results: string[] = [];
    for (let i = 0; i < RATE_LIMITS.orderCreateMember.limit + 1; i++)
      results.push(await create(ctx));
    expect(results.slice(0, -1).every((r) => r === "reached_rpc")).toBe(true);
    expect(results.at(-1)).toBe("rate_limited");
    expect(orderRpcCalls).toBe(RATE_LIMITS.orderCreateMember.limit);
  });

  it("an idempotent retry of an order the member already created is NEVER blocked", async () => {
    const ctx = ctxFor(ORG_A, member(2));
    const createdKey = newKey();
    existingOrderKeys.add(`${ORG_A}|${member(2)}|${createdKey}`);
    for (let i = 0; i < RATE_LIMITS.orderCreateMember.limit; i++) await create(ctx);
    expect(await create(ctx)).toBe("rate_limited");
    const before = orderRpcCalls;
    // The response for createdKey was lost; the retry must reach create_order_v2
    // (which replays the stored order) even with the bucket full.
    expect(await create(ctx, createdKey)).toBe("reached_rpc");
    expect(await create(ctx, createdKey)).toBe("reached_rpc");
    expect(orderRpcCalls).toBe(before + 2);
  });

  it("another member's key is not a bypass", async () => {
    const ctx = ctxFor(ORG_A, member(3));
    const othersKey = newKey();
    existingOrderKeys.add(`${ORG_A}|${member(4)}|${othersKey}`);
    for (let i = 0; i < RATE_LIMITS.orderCreateMember.limit; i++) await create(ctx);
    expect(await create(ctx, othersKey)).toBe("rate_limited");
  });

  it("members and organizations are separate buckets; the window resets", async () => {
    const full = ctxFor(ORG_A, member(5));
    for (let i = 0; i <= RATE_LIMITS.orderCreateMember.limit; i++) await create(full);
    expect(await create(full)).toBe("rate_limited");
    expect(await create(ctxFor(ORG_A, member(6)))).toBe("reached_rpc");
    expect(await create(ctxFor(ORG_B, member(5)))).toBe("reached_rpc");
    advance(RATE_LIMITS.orderCreateMember.windowSeconds);
    expect(await create(full)).toBe("reached_rpc");
  });

  it("the organization-wide ceiling holds across many members", async () => {
    const perMember = RATE_LIMITS.orderCreateMember.limit;
    const members = RATE_LIMITS.orderCreateOrganization.limit / perMember;
    for (let m = 0; m < members; m++) {
      const ctx = ctxFor(ORG_B, member(100 + m));
      for (let i = 0; i < perMember; i++) await create(ctx);
    }
    expect(await create(ctxFor(ORG_B, member(999)))).toBe("rate_limited");
    expect(await create(ctxFor(ORG_A, member(999)))).toBe("reached_rpc");
  });

  it("an unauthorized caller gets 403, not a 429, and consumes nothing", async () => {
    const noPermission = new AuthorizationContext({
      membership: { user_id: member(7), organization_id: ORG_A, role_id: "role" },
      role: { system_role: "CASHIER" },
      permissions: new Set<string>(),
    } as never);
    await expect(
      orders.createOrder(noPermission, {
        expectedPrincipal: principalOf(noPermission),
        source: "POS",
        items: [{ variantId: VARIANT, quantity: 1 }],
        idempotencyKey: newKey(),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

// ── Payments ────────────────────────────────────────────────────────────────

describe("payment mutation limits", () => {
  const record = (ctx: ReturnType<typeof ctxFor>) =>
    payments
      .recordPayment(ctx, {
        expectedPrincipal: principalOf(ctx),
        orderId: "00000000-0000-4000-8000-0000000000c1",
        method: "cash",
        amountMinor: 100,
      })
      .then(
        () => "ok",
        (e: unknown) => (e instanceof RateLimitedError ? "rate_limited" : "reached_repo"),
      );
  const reverse = (ctx: ReturnType<typeof ctxFor>) =>
    payments
      .reversePayment(
        ctx,
        "00000000-0000-4000-8000-0000000000d1",
        "customer returned goods",
        principalOf(ctx),
      )
      .then(
        () => "ok",
        (e: unknown) => (e instanceof RateLimitedError ? "rate_limited" : "reached_repo"),
      );

  it("record: below / at / above the member limit; other members unaffected", async () => {
    const ctx = ctxFor(ORG_A, "aaaaaaaa-0000-4000-8000-0000000000e1");
    const results: string[] = [];
    for (let i = 0; i <= RATE_LIMITS.paymentMutateMember.limit; i++)
      results.push(await record(ctx));
    expect(results.slice(0, -1).every((r) => r === "reached_repo")).toBe(true);
    expect(results.at(-1)).toBe("rate_limited");
    expect(paymentRepoCalls).toBe(RATE_LIMITS.paymentMutateMember.limit);
    expect(await record(ctxFor(ORG_A, "aaaaaaaa-0000-4000-8000-0000000000e2"))).toBe(
      "reached_repo",
    );
  });

  it("reversals/refunds/corrections have their own tighter bucket", async () => {
    const ctx = ctxFor(ORG_A, "aaaaaaaa-0000-4000-8000-0000000000e3");
    for (let i = 0; i < RATE_LIMITS.paymentReversalMember.limit; i++) {
      expect(await reverse(ctx)).toBe("reached_repo");
    }
    expect(await reverse(ctx)).toBe("rate_limited");
    // Ordinary recording still has headroom.
    expect(await record(ctx)).toBe("reached_repo");
  });
});

// ── Financial mutations: durable limiter unavailable ────────────────────────

describe("financial mutations FAIL CLOSED when the durable limiter is unavailable", () => {
  const unavailableStore = () =>
    new PostgresRateLimitStore(
      {
        rpc: (() =>
          Promise.resolve({
            data: null,
            error: { code: "PGRST202", message: "function consume_rate_limit does not exist" },
          })) as never,
      },
      50,
    );
  const PAYMENT = "00000000-0000-4000-8000-0000000000d9";
  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => "ok",
      (e: unknown) =>
        e instanceof RateLimitUnavailableError
          ? "unavailable"
          : e instanceof RateLimitedError
            ? "rate_limited"
            : "reached_repo",
    );
  const cases: Array<[string, (ctx: ReturnType<typeof ctxFor>) => Promise<unknown>]> = [
    [
      "REFUND",
      (ctx) =>
        payments.refundPayment(ctx, {
          paymentId: PAYMENT,
          amountMinor: 100,
          reason: "customer refund",
          idempotencyKey: "idem-key-refund-000001",
          expectedRefundedMinor: 0,
          expectedPrincipal: principalOf(ctx),
        }),
    ],
    [
      "REVERSAL",
      (ctx) => payments.reversePayment(ctx, PAYMENT, "customer returned goods", principalOf(ctx)),
    ],
    [
      "CORRECTION",
      (ctx) =>
        payments.correctPayment(
          ctx,
          PAYMENT,
          "typo in reference",
          { reference: "ABA-1" },
          principalOf(ctx),
        ),
    ],
  ];

  for (const [label, run] of cases) {
    it(`${label}: refused with a retryable public 503, nothing read, mutated, evented or audited`, async () => {
      setPrimaryRateLimitStore(unavailableStore());
      const ctx = ctxFor(ORG_A, "aaaaaaaa-0000-4000-8000-0000000000f1");
      let thrown: unknown;
      try {
        await run(ctx);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RateLimitUnavailableError);
      expect(thrown).toMatchObject({ statusCode: 503, code: "rate_limit_unavailable" });
      expect(paymentRepoCallNames).toEqual([]);
      expect(adminCalls).toEqual([]);
      // Well past the reversal limit: every attempt still fails closed, so the
      // per-instance memory store was never consulted (it would have allowed 20).
      const results: string[] = [];
      for (let i = 0; i < RATE_LIMITS.paymentReversalMember.limit + 5; i++) {
        results.push(await outcome(run(ctx)));
      }
      expect(new Set(results)).toEqual(new Set(["unavailable"]));
      expect(paymentRepoCalls).toBe(0);
      expect(adminCalls).toEqual([]);
      expect(logLines.join("\n")).toContain("rate_limit.backend_unavailable_fail_closed");
    });
  }

  it("routine recording keeps its documented per-instance fallback in the same outage", async () => {
    setPrimaryRateLimitStore(unavailableStore());
    const ctx = ctxFor(ORG_A, "aaaaaaaa-0000-4000-8000-0000000000f2");
    const result = await outcome(
      payments.recordPayment(ctx, {
        expectedPrincipal: principalOf(ctx),
        orderId: "00000000-0000-4000-8000-0000000000c9",
        method: "cash",
        amountMinor: 100,
      }),
    );
    expect(result).toBe("reached_repo");
  });
});

// ── Logs ────────────────────────────────────────────────────────────────────

describe("limit logs", () => {
  it("never contain an email address, password or IP", () => {
    const joined = logLines.join("\n");
    expect(joined).toContain("rate_limit.exceeded");
    for (const secret of [KNOWN, UNKNOWN, "wrong-password-1", "203.0.113.10", "2001:db8"]) {
      expect({ secret, leaked: joined.includes(secret) }).toEqual({ secret, leaked: false });
    }
  });
});
