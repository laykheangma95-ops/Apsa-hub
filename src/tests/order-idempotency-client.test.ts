import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  createScopedIdempotencyHolders,
  orderRequestFingerprint,
  type IdempotencyScope,
} from "@/lib/idempotency";

it("createRealOrder reuses one key per logical order attempt and parses delivery fees without floats", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/order-idempotency-client.runtime.ts")],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, VITE_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
    },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 70000);

// The key holder is a required input of createRealOrder (typechecked), so this
// only pins that each real entry point keeps ONE holder for its lifetime rather
// than minting one per call — which would silently defeat retry replay.
it("every real order-creation entry point keeps one idempotency holder per flow", () => {
  for (const file of [
    "src/components/pos/PosCheckoutSheet.tsx",
    "src/components/orders/CreateRealOrderSheet.tsx",
    "src/components/inbox/PrepareOrderSheet.tsx",
  ]) {
    const source = readFileSync(resolve(file), "utf8");
    if (file.endsWith("PrepareOrderSheet.tsx")) {
      // The conversation route remounts this sheet on every conversation /
      // member / organization switch, so its ONE holder must outlive it: the
      // page-lifetime registry, scoped to member + organization + conversation
      // (PR #118 review P2 #1; behaviour in inbox-order-money-mounted).
      expect(source).toMatch(/sharedIdempotencyHolder\(\{/);
      expect(source).toMatch(/flow: "inbox-prepare-order"/);
      expect(source).not.toMatch(/useRef\(createIdempotencyKeyHolder\(\)\)/);
    } else if (file.endsWith("CreateRealOrderSheet.tsx")) {
      // Mounted across member/organization switches, so one holder PER member +
      // organization, looked up at each attempt and never replaced on a switch
      // (PR #120 review P2; behaviour in orders-new-order-money-mounted).
      expect(source).toMatch(/const replayHolders = useRef\(createScopedIdempotencyHolders\(\)\)/);
      expect(source).toMatch(/\.holderFor\(\{ userId, organizationId, flow: "orders-new-order"/);
      expect(source).not.toMatch(/idempotencyKeys(?:\.current)? = createIdempotencyKeyHolder\(\)/);
      expect(source).not.toMatch(/createIdempotencyKeyHolder/);
    } else {
      expect(source).toMatch(/const idempotencyKeys = useRef\(createIdempotencyKeyHolder\(\)\)/);
    }
    // Attempts in every flow can overlap (close/reopen while a create is
    // pending), so each attempt sends its own claim on the flow's ONE holder
    // and retires it only after accepting the response (see the mounted
    // ownership tests in pos-money-mounted, inbox-order-money-mounted and
    // orders-new-order-money-mounted). Never the holder itself, which
    // createRealOrder retires on arrival — whichever session that reaches.
    expect(source).toMatch(/const claim = idempotencyKeys(?:\.current)?\.claim\(\);/);
    expect(source).toMatch(/idempotency: claim,/);
    expect(source).toMatch(
      /if \(!isCurrent\(token\)\) return;\s+(?:\/\/[^\n]*\n\s+)*claim\.retire\(\);/,
    );
    expect(source).not.toMatch(/idempotency: idempotencyKeys(?:\.current)?,/);
    expect(source).not.toMatch(/idempotency: createIdempotencyKeyHolder\(\)/);
  }
});

/*
 * One holder per member + organization for a component that stays mounted
 * across identity switches (Orders → New Order; PR #120 review P2). The
 * mounted, database-backed proof is orders-new-order-money-mounted.
 */
describe("scoped holders: an identity switch never discards or shares a replay key", () => {
  const scope = (over: Partial<IdempotencyScope> = {}): IdempotencyScope => ({
    userId: "user-a",
    organizationId: "org-a",
    flow: "orders-new-order",
    subject: "",
    ...over,
  });
  const fpX = orderRequestFingerprint({ items: [{ variantId: "x", quantity: 2 }] });
  const fpY = orderRequestFingerprint({ items: [{ variantId: "y", quantity: 1 }] });

  it("A → B → A: A's unresolved key is the one A's identical retry gets", () => {
    const holders = createScopedIdempotencyHolders();
    const k = holders.holderFor(scope()).claim().keyFor(fpX); // response lost
    holders.holderFor(scope({ organizationId: "org-b" }));
    holders.holderFor(scope({ userId: "user-b" }));
    expect(holders.holderFor(scope()).claim().keyFor(fpX)).toBe(k);
  });

  it("member, organization and flow each partition the key; a different request gets a new one", () => {
    const holders = createScopedIdempotencyHolders();
    const k = holders.holderFor(scope()).claim().keyFor(fpX);
    for (const other of [
      scope({ userId: "user-b" }),
      scope({ organizationId: "org-b" }),
      scope({ flow: "other-flow" }),
    ]) {
      expect(holders.holderFor(other).claim().keyFor(fpX)).not.toBe(k);
    }
    expect(holders.holderFor(scope()).claim().keyFor(fpY)).not.toBe(k);
  });

  it("a superseded claim cannot retire the key; the accepted one does", () => {
    const holders = createScopedIdempotencyHolders();
    const stale = holders.holderFor(scope()).claim();
    const k = stale.keyFor(fpX);
    holders.holderFor(scope({ organizationId: "org-b" }));
    const newer = holders.holderFor(scope()).claim();
    expect(newer.keyFor(fpX)).toBe(k);
    stale.retire(); // late response of an abandoned attempt
    expect(holders.holderFor(scope()).hasUnresolvedKey()).toBe(true);
    newer.retire(); // accepted
    expect(holders.holderFor(scope()).claim().keyFor(fpX)).not.toBe(k);
  });

  it("bounded without eviction: idle holders are dropped, unresolved ones never are", () => {
    const holders = createScopedIdempotencyHolders();
    const unresolved = [0, 1, 2].map((i) => {
      const s = scope({ organizationId: `org-pending-${i}` });
      return { s, key: holders.holderFor(s).claim().keyFor(fpX) };
    });
    for (let i = 0; i < 1000; i++) holders.holderFor(scope({ organizationId: `org-idle-${i}` }));
    // The current scope plus the three with a create still unresolved.
    expect(holders.size()).toBe(4);
    for (const { s, key } of unresolved) {
      expect(holders.holderFor(s).claim().keyFor(fpX)).toBe(key);
    }
  });

  it("an accepted create leaves the set: its scope becomes idle and is compacted away", () => {
    const holders = createScopedIdempotencyHolders();
    const claim = holders.holderFor(scope()).claim();
    claim.keyFor(fpX);
    holders.holderFor(scope({ organizationId: "org-b" }));
    expect(holders.size()).toBe(2);
    claim.retire();
    holders.holderFor(scope({ organizationId: "org-b" }));
    expect(holders.size()).toBe(1);
  });
});
