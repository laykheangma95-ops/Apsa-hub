/**
 * The Apsi service console: what it promises, what it refuses to promise, and
 * the structural regressions that would quietly undo either.
 *
 * Apsi is APSA's business service console, not a chatbot. Its job is to help a
 * staff member answer the customer in front of them, which means three things
 * have to stay true: a structured identifier goes straight to the domain that
 * owns it (never through inference), a lookup the member has no access to is
 * never issued at all, and a capability APSA does not have a backend contract
 * for is stated plainly rather than faked.
 *
 * Behavioural coverage of the FIND layer lives in apsi-console.runtime.ts,
 * spawned below, because it replaces the whole `@/lib/api` boundary and must
 * not leak into the shared module cache.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  APSI_QUERY_MAX_LENGTH,
  apsiEmptyScope,
  classifyApsiQuery,
  looksLikePersonName,
  looksLikePhoneNumber,
  normalizeApsiQuery,
} from "@/lib/apsi/input";
import {
  APSI_PROBE_PERMISSIONS,
  apsiResultRoute,
  planApsiLookup,
  type ApsiResult,
} from "@/lib/apsi/lookup";
import { looksLikeOrderCode, normalizeOrderCode } from "@/lib/order-code";
import { apsiSurfaceForPath, orderApsiActionIds } from "@/lib/apsi/context";
import { getBusinessNavConfig } from "@/design-system/mobile-nav-config";
import { APSI_QUERY_ROOT, apsiKeys } from "@/lib/apsi-query";
import { UI_PERMISSION_KEYS, type UiPermissionKey } from "@/lib/capabilities";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Source with comments removed.
 *
 * The probes below assert on what the code DOES. Several of them also name the
 * defect they guard (`getOrders`, `["mobile-nav","recent-orders"]`) in the
 * comment that explains why it is gone, and matching that prose would make the
 * probe pass or fail on documentation rather than behaviour.
 */
const readCode = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const BOTTOM_NAV = "src/design-system/BottomNav.tsx";
const NAV_CONFIG = "src/design-system/mobile-nav-config.ts";
const CONSOLE = "src/components/apsi/ApsiConsoleSheet.tsx";
const LOOKUP = "src/lib/apsi/lookup.ts";
const INPUT = "src/lib/apsi/input.ts";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";

function grantsFor(keys: readonly UiPermissionKey[]) {
  const set = new Set<string>(keys);
  return { can: (key: UiPermissionKey) => set.has(key) };
}

// ── Deterministic classification ──────────────────────────────────────────────

describe("Apsi routes a structured identifier deterministically", () => {
  it("sends a UUID to the id lookups of every domain that uses one", () => {
    const plan = classifyApsiQuery(ORDER_ID);

    expect(plan.probes.map((p) => p.kind)).toEqual([
      "order-by-id",
      "payment-by-id",
      "delivery-by-id",
      "customer-by-id",
    ]);
    // An id is unambiguous, so no free-text search is attached to it.
    expect(plan.probes.some((p) => p.kind === "delivery-search")).toBe(false);
  });

  it("treats a single token as a possible exact SKU or barcode", () => {
    const plan = classifyApsiQuery("SKU-COKE-330");
    expect(plan.probes.map((p) => p.kind)).toEqual([
      "product-by-barcode",
      "product-by-sku",
      "delivery-search",
    ]);
  });

  /*
   * "coca cola" is a product NAME, and APSA has no server-side product name
   * search. Sending it to the exact-match SKU lookup would turn a real "we
   * cannot search that" into a confident, wrong "no such product".
   */
  it("never sends a multi-word phrase to an exact-match identifier lookup", () => {
    const plan = classifyApsiQuery("coca cola 330ml");
    expect(plan.probes.map((p) => p.kind)).toEqual(["delivery-search"]);
  });

  it("normalizes Khmer digits and stray whitespace before deciding anything", () => {
    expect(normalizeApsiQuery("  ០១២ ៣៤៥  ៦៧៨ ")).toBe("012 345 678");
    expect(classifyApsiQuery("   ").empty).toBe(true);
    expect(classifyApsiQuery("").probes).toEqual([]);
  });

  it("caps the query at the length the underlying validators accept", () => {
    const plan = classifyApsiQuery("A".repeat(500));
    expect(plan.normalized).toHaveLength(APSI_QUERY_MAX_LENGTH);
  });
});

// ── Honesty about what it cannot do ───────────────────────────────────────────

describe("Apsi routes each shape to the domain that owns it", () => {
  /*
   * The order code was the headline gap. Apsi could only reach an order code
   * through the DELIVERY list's free-text search, so an order with no delivery
   * row was unfindable by the reference printed on its own receipt — and the
   * console reported that as "nothing matched", which a staff member repeats
   * to a customer as "we have no record of your order".
   */
  it("sends an order code to Orders, and to nothing else", () => {
    for (const input of ["APSA-2026-000123", "apsa-2026-000123", " APSA-2026-000123 "]) {
      const plan = classifyApsiQuery(input);
      expect({ input, kinds: plan.probes.map((p) => p.kind) }).toEqual({
        input,
        kinds: ["order-by-code"],
      });
      // Normalized once, so all three spellings are one lookup.
      expect((plan.probes[0] as { value: string }).value).toBe("APSA-2026-000123");
    }
  });

  it("never reaches an order code through the Delivery search again", () => {
    const plan = classifyApsiQuery("APSA-2026-000123");
    expect(plan.probes.some((p) => p.kind === "delivery-search")).toBe(false);
    expect(plan.probes.some((p) => p.kind === "product-by-sku")).toBe(false);
  });

  it("sends a phone number to Customers, and to nothing else", () => {
    for (const input of ["012 345 678", "+855 12 345 678", "០១២៣៤៥៦៧៨"]) {
      const plan = classifyApsiQuery(input);
      expect({ input, kinds: plan.probes.map((p) => p.kind) }).toEqual({
        input,
        kinds: ["customer-by-phone"],
      });
    }
  });

  it("sends a name to Customers, alongside the Delivery search that also records names", () => {
    const kinds = classifyApsiQuery("Sokha").probes.map((p) => p.kind);
    expect(kinds).toContain("customer-by-name");
    // A courier name is also just letters, so Delivery still sees it. Two
    // targeted probes, not a broadcast across every backend.
    expect(kinds).toContain("delivery-search");
    expect(looksLikePersonName("Sokha")).toBe(true);
    expect(looksLikePersonName("APSA-1042")).toBe(false);
  });

  it("does not mistake an order code or tracking number for a phone number", () => {
    expect(looksLikePhoneNumber("APSA-1042")).toBe(false);
    expect(looksLikePhoneNumber("JT-9001")).toBe(false);
    expect(looksLikePhoneNumber("012345678")).toBe(true);
    // Too few digits to be a phone number — that fragment would match most of
    // a tenant, which is a cheaper existence oracle than a precise match.
    expect(looksLikePhoneNumber("0123")).toBe(false);
  });

  it("recognises an order code without inferring a year that was never typed", () => {
    expect(looksLikeOrderCode(normalizeOrderCode("apsa-2026-000123"))).toBe(true);
    expect(looksLikeOrderCode(normalizeOrderCode("APSA-1042"))).toBe(true);
    expect(looksLikeOrderCode("SKU-COKE-330")).toBe(false);
    expect(looksLikeOrderCode("JT-9001")).toBe(false);
    // "APSA-123" is looked up verbatim; the code is never padded or rewritten
    // into a guess at which year's order the merchant meant.
    expect(normalizeOrderCode(" apsa-123 ")).toBe("APSA-123");
  });

  it("still sends a tracking number to Delivery and a barcode to Catalog", () => {
    expect(classifyApsiQuery("JT-9001").probes.map((p) => p.kind)).toEqual([
      "product-by-barcode",
      "product-by-sku",
      "delivery-search",
    ]);
    expect(classifyApsiQuery("8850007123456").probes.map((p) => p.kind)).toEqual([
      "product-by-barcode",
      "product-by-sku",
      "delivery-search",
    ]);
  });
});

// ── Scope honesty ─────────────────────────────────────────────────────────────

/*
 * The two sentences a merchant reads when Apsi finds nothing are the whole
 * product promise, and both were once wrong: the scope line was unpinned, and
 * the empty-result line claimed the record was absent from APSA entirely.
 *
 * Apsi searches deliveries (free text), products (exact SKU / barcode) and
 * pasted ids. It cannot search orders by code, or customers by name or phone.
 * So neither string may make a whole-system claim — an order with no delivery
 * row exists and is simply out of reach, and telling a merchant otherwise is
 * how they tell a customer their order does not exist.
 *
 * Asserted semantically rather than by full-string match: the wording is free
 * to change, the promise is not.
 */
describe("Apsi never claims to have searched all of APSA", () => {
  const en = JSON.parse(read("src/locales/en.json")).apsi;
  const km = JSON.parse(read("src/locales/km.json")).apsi;

  /** "nothing/everything in APSA", in either language, is the claim to catch. */
  const UNIVERSAL_EN = /\b(nothing|everything|anything|no record|nowhere)\b[^.]*\bAPSA\b/i;
  const UNIVERSAL_KM = /(គ្មានអ្វី|ទាំងអស់|អ្វីៗ)[^។]*APSA/;

  it("states the real search scope rather than universal coverage", () => {
    expect(en.searchScope).not.toMatch(UNIVERSAL_EN);
    expect(km.searchScope).not.toMatch(UNIVERSAL_KM);
    // It names each domain that is actually reached, so "not found" can be
    // read in context — and the phone permission, so an unavailable search
    // does not read as an absent customer.
    expect(en.searchScope).toMatch(/order code/i);
    expect(en.searchScope).toMatch(/customer/i);
    expect(en.searchScope).toMatch(/deliver/i);
    expect(en.searchScope).toMatch(/sku/i);
    expect(en.searchScope).toMatch(/customers\.view_sensitive/);
    expect(km.searchScope).toMatch(/ការបញ្ជាទិញ/);
    expect(km.searchScope).toMatch(/អតិថិជន/);
    expect(km.searchScope).toMatch(/ដឹកជញ្ជូន/);
    expect(km.searchScope).toMatch(/SKU/);
    expect(km.searchScope).toMatch(/customers\.view_sensitive/);
  });

  /*
   * The not-found line is now SCOPED TO THE DOMAIN THAT ANSWERED, which is the
   * whole point of routing an order code to Orders. One sentence covering
   * every shape could only ever be the broadest one, and the broadest one is a
   * claim about APSA that a single-domain probe never earned.
   */
  it("scopes each empty-result line to the domain that was actually searched", () => {
    for (const copy of [en.empty, km.empty]) {
      for (const value of Object.values(copy) as string[]) {
        expect(value).not.toMatch(UNIVERSAL_EN);
        expect(value).not.toMatch(UNIVERSAL_KM);
      }
    }

    // An order code goes to Orders alone, so the line may only speak of orders.
    expect(en.empty.orderCode).toMatch(/order/i);
    expect(en.empty.orderCode).not.toMatch(/deliver|sku|barcode|customer/i);
    expect(km.empty.orderCode).toMatch(/ការបញ្ជាទិញ/);
    expect(km.empty.orderCode).not.toMatch(/ដឹកជញ្ជូន|SKU|បាកូដ/);

    // A phone number goes to Customers alone.
    expect(en.empty.customerPhone).toMatch(/customer/i);
    expect(en.empty.customerPhone).not.toMatch(/deliver|sku|barcode|order/i);
    expect(km.empty.customerPhone).toMatch(/អតិថិជន/);
    expect(km.empty.customerPhone).not.toMatch(/ដឹកជញ្ជូន|SKU|បាកូដ/);

    // The broader shapes still echo the query and name what was tried.
    for (const copy of [
      en.empty.customerName,
      km.empty.customerName,
      en.empty.search,
      km.empty.search,
    ]) {
      expect(copy).toContain("{{query}}");
    }

    /*
     * The name line may not claim a search that did not run. A multi-word name
     * ("Sokha Chan") is not a single token, so the exact SKU and barcode
     * probes are never issued for it — naming them would be a claim about
     * Products built from a request that was never made, which is the same
     * defect as an APSA-wide claim, only smaller.
     */
    const nameProbes = classifyApsiQuery("Sokha Chan").probes.map((p) => p.kind);
    expect(nameProbes).toEqual(["customer-by-name", "delivery-search"]);
    expect(en.empty.customerName).not.toMatch(/sku|barcode/i);
    expect(km.empty.customerName).not.toMatch(/SKU|បាកូដ/);
    // It still names both domains that DID run.
    expect(en.empty.customerName).toMatch(/customer/i);
    expect(en.empty.customerName).toMatch(/deliver/i);
  });

  it("picks the empty-result line from the probes the query actually produced", () => {
    expect(apsiEmptyScope(classifyApsiQuery("APSA-2026-000123"))).toBe("orderCode");
    expect(apsiEmptyScope(classifyApsiQuery("012 345 678"))).toBe("customerPhone");
    expect(apsiEmptyScope(classifyApsiQuery("Sokha"))).toBe("customerName");
    expect(apsiEmptyScope(classifyApsiQuery(ORDER_ID))).toBe("identifier");
    expect(apsiEmptyScope(classifyApsiQuery("JT-9001"))).toBe("search");

    // Every scope it can return has copy in both languages.
    for (const scope of ["orderCode", "customerPhone", "customerName", "identifier", "search"]) {
      expect({ scope, en: typeof en.empty[scope] }).toEqual({ scope, en: "string" });
      expect({ scope, km: typeof km.empty[scope] }).toEqual({ scope, km: "string" });
    }
  });

  /*
   * Behavioural proof that this line cannot appear after a lookup that issued
   * nothing lives in apsi-console.runtime.ts (a recording domain layer, zero
   * requests, `answered: false`). This pins the wiring: the console must gate
   * the sentence on that same flag, and must pick its wording from the plan.
   */
  it("renders the empty-result line only when a domain actually answered", () => {
    const console_ = readCode(CONSOLE);
    const gate = console_.match(/const nothingFound =[\s\S]*?;/)?.[0] ?? "";

    expect(gate).toContain("outcome!.answered");
    expect(gate).toContain("outcome!.results.length === 0");
    expect(gate).toContain("outcome!.failed.length === 0");
    // The flag is only worth anything if the sentence is behind it.
    expect(console_).toContain("{nothingFound ?");
    // …and the sentence is the domain-scoped one, not a single global string.
    expect(console_).toContain("const emptyScopeKey = `apsi.empty.${apsiEmptyScope(plan)}`");
    expect(console_).toContain("t(emptyScopeKey, { query: plan.normalized })");
  });

  /*
   * A page is not the whole answer. A customer search returns five cards out
   * of however many matched, and five names must never read as "these are all
   * the people called that".
   */
  it("says so when a domain reported more matches than it returned", () => {
    const console_ = readCode(CONSOLE);
    expect(console_).toContain("outcome!.incomplete");
    expect(console_).toContain('t("apsi.moreResults")');
    expect(typeof en.moreResults).toBe("string");
    expect(typeof km.moreResults).toBe("string");
  });
});

// ── Permission model ──────────────────────────────────────────────────────────

describe("Apsi reveals nothing the member could not see directly", () => {
  it("maps every probe to permission keys this UI is allowed to consult", () => {
    for (const [kind, keys] of Object.entries(APSI_PROBE_PERMISSIONS)) {
      expect({ kind, keys: keys.length > 0 }).toEqual({ kind, keys: true });
      for (const key of keys) {
        expect({
          kind,
          key,
          declared: (UI_PERMISSION_KEYS as readonly string[]).includes(key),
        }).toEqual({ kind, key, declared: true });
      }
    }
  });

  it("keys each probe to every permission its own server function requires", () => {
    expect(APSI_PROBE_PERMISSIONS).toEqual({
      "order-by-id": ["orders.read"],
      "order-by-code": ["orders.read"],
      "payment-by-id": ["payments.read"],
      "delivery-by-id": ["delivery.read"],
      "customer-by-id": ["customers.read"],
      "customer-by-name": ["customers.read"],
      // BOTH, and the second is the one that matters: which customers come
      // back for a typed phone fragment is itself the disclosure that
      // customers.view_sensitive gates, so the grant is checked before the
      // request exists rather than applied to its result.
      "customer-by-phone": ["customers.read", "customers.view_sensitive"],
      "product-by-barcode": ["products.read"],
      "product-by-sku": ["products.read"],
      "delivery-search": ["delivery.read"],
    });
  });

  /*
   * THE LAUNCH-CRITICAL ONE. A member who can read customers but may not see
   * their PII must not be able to use Apsi as a phone-number existence oracle.
   * Holding one of the two keys is not enough, and the probe is dropped from
   * the plan rather than issued and masked.
   */
  it("withholds the phone search from a member holding customers.read alone", () => {
    const plan = classifyApsiQuery("012 345 678");
    const { runnable, skipped } = planApsiLookup(plan, grantsFor(["customers.read"]));

    expect(runnable).toEqual([]);
    expect(skipped.map((s) => s.permission)).toEqual(["customers.view_sensitive"]);
  });

  it("runs the phone search only when BOTH grants hold", () => {
    const plan = classifyApsiQuery("012 345 678");
    const { runnable } = planApsiLookup(
      plan,
      grantsFor(["customers.read", "customers.view_sensitive"]),
    );
    expect(runnable.map((p) => p.kind)).toEqual(["customer-by-phone"]);
  });

  it("still runs the name search for a member without the sensitive grant", () => {
    // Name is not PII behind that grant — withholding it would be a different
    // defect: a staff member unable to find a customer who is right there.
    const { runnable } = planApsiLookup(classifyApsiQuery("Sokha"), grantsFor(["customers.read"]));
    expect(runnable.map((p) => p.kind)).toContain("customer-by-name");
  });

  it("withholds a probe rather than running it and hiding the answer", () => {
    const plan = classifyApsiQuery(ORDER_ID);
    const { runnable, skipped } = planApsiLookup(plan, grantsFor(["orders.read"]));

    expect(runnable.map((p) => p.kind)).toEqual(["order-by-id"]);
    expect(skipped.map((s) => s.permission).sort()).toEqual([
      "customers.read",
      "delivery.read",
      "payments.read",
    ]);
  });

  it("runs nothing for a member holding no relevant grant", () => {
    const { runnable } = planApsiLookup(classifyApsiQuery(ORDER_ID), grantsFor([]));
    expect(runnable).toEqual([]);
  });

  /*
   * The console renders the phone only behind the server's own
   * `sensitiveVisible` answer, never behind a client-side capability read
   * alone. Both must be present in the source that draws the card.
   */
  it("gates the customer phone on the server's own withholding flag", () => {
    const source = read(CONSOLE);
    expect(source).toContain("result.sensitiveVisible && result.phone");
    expect(source).toContain("apsi.card.customerPhoneWithheld");
  });
});

// ── Cache identity ────────────────────────────────────────────────────────────

describe("Apsi cache identity is partitioned by principal", () => {
  it("keys every console answer by user AND organization", () => {
    const key = apsiKeys.lookup("user-a", "org-a", "APSA-1042", false);

    expect(key).toEqual([APSI_QUERY_ROOT, "user-a", "org-a", "lookup", false, "APSA-1042"]);
    expect(key).not.toEqual(apsiKeys.lookup("user-b", "org-a", "APSA-1042", false));
    expect(key).not.toEqual(apsiKeys.lookup("user-a", "org-b", "APSA-1042", false));
  });

  /*
   * REVOCATION. A phone search run while customers.view_sensitive held must
   * not be served back out of the cache after it is revoked — same tab, same
   * principal, same typed number. Nothing purges this cache on a revocation:
   * capabilities and lookups are two independent queries, so the grant-era
   * answer has to live at an address the post-revocation render never reads.
   */
  it("keys an answer produced under the sensitive grant apart from one without it", () => {
    expect(apsiKeys.lookup("user-a", "org-a", "012345678", true)).not.toEqual(
      apsiKeys.lookup("user-a", "org-a", "012345678", false),
    );
  });
});

// ── Context is a hint only ────────────────────────────────────────────────────

describe("Apsi context reorders shortcuts and nothing else", () => {
  it("derives the surface from the current path", () => {
    expect(apsiSurfaceForPath("/app/inbox/cv-1")).toBe("inbox");
    expect(apsiSurfaceForPath("/app/orders/ord-1")).toBe("sales");
    expect(apsiSurfaceForPath("/app/inventory")).toBe("catalog");
    expect(apsiSurfaceForPath("/app")).toBe("home");
    expect(apsiSurfaceForPath("/app/team")).toBe("other");
  });

  it("leads with the customer tools when opened from a conversation", () => {
    const ids = ["scan-barcode", "track-delivery", "find-customer", "find-order"];
    expect(orderApsiActionIds(ids, "inbox")).toEqual([
      "find-customer",
      "find-order",
      "track-delivery",
      "scan-barcode",
    ]);
  });

  it("keeps every shortcut, and the declared order, when the surface has no priority", () => {
    const ids = ["find-order", "find-customer", "scan-barcode"];
    expect(orderApsiActionIds(ids, "home")).toEqual(ids);
    expect(orderApsiActionIds(ids, "inbox")).toHaveLength(ids.length);
  });

  /*
   * A UX hint must not look like an authorization input. The context modules
   * decide ordering from the pathname and nothing else — no identity, no
   * organization, nothing sent anywhere.
   */
  it("never lets the surface reach a permission decision or a request", () => {
    const source = readCode("src/lib/apsi/context.ts");
    expect(source).not.toMatch(/organizationId|userId|session|fetch|import\(/);
    expect(readCode(LOOKUP)).not.toMatch(/\borganizationId\b/);
  });
});

// ── Adversarial probes ────────────────────────────────────────────────────────

/**
 * Each test below was written by breaking the thing it guards, confirming it
 * failed, and restoring it. They are the regressions most likely to be
 * reintroduced by a well-meaning edit.
 */
// ── Result routing ────────────────────────────────────────────────────────────

/*
 * Where a result card sends the member, tested against the real helper.
 *
 * The rule is narrow and total: the destination is the domain that owns the
 * record, and the id is the one the domain returned — unchanged, never
 * substituted, never derived. A card that routes to a fabricated id sends a
 * merchant to a 404 while telling them the record was found.
 *
 * Previously this was covered only by asserting that the Apsi modules import
 * no fixtures, which is a different property: a literal id written inline in
 * the helper imports nothing and would have passed.
 */
describe("Apsi routes a result to the record the domain returned", () => {
  const order: ApsiResult = {
    kind: "order",
    id: "11111111-1111-4111-8111-111111111111",
    code: "APSA-1042",
    total: { amountMinor: 1980, currency: "USD" },
    lifecycleStatus: "confirmed",
    paymentStatus: "pending_payment",
    fulfillmentStatus: "packing",
  };

  it("sends an Order result to Order detail under its production id", () => {
    expect(apsiResultRoute(order)).toEqual({
      to: "/app/orders/$id",
      id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("gives every result kind the route of the domain that owns it", () => {
    const routes = [
      [order, "/app/orders/$id"],
      [{ ...order, kind: "payment" } as unknown as ApsiResult, "/app/payments/$id"],
      [{ ...order, kind: "delivery" } as unknown as ApsiResult, "/app/deliveries/$id"],
      [{ ...order, kind: "customer" } as unknown as ApsiResult, "/app/customers/$id"],
      [{ ...order, kind: "product" } as unknown as ApsiResult, "/app/products/$id"],
    ] as const;

    for (const [result, to] of routes) {
      expect({ kind: result.kind, ...apsiResultRoute(result) }).toEqual({
        kind: result.kind,
        to,
        id: order.id,
      });
    }
  });

  /*
   * The id is passed through, not chosen. Several unrelated ids rather than
   * one, so a hard-coded literal cannot satisfy the assertion by coincidence.
   */
  it("never substitutes or manufactures an id", () => {
    for (const id of [
      "11111111-1111-4111-8111-111111111111",
      "99999999-9999-4999-8999-999999999999",
      "prod-1",
    ]) {
      expect(apsiResultRoute({ ...order, id }).id).toBe(id);
    }

    // And the helper invents nothing on its own: no literal id in its body.
    const source = readCode(LOOKUP);
    const body = source.slice(source.indexOf("export function apsiResultRoute"));
    expect(body).toContain("id: result.id");
    expect(body).not.toMatch(/id: ["'`]/);
  });
});

describe("adversarial probes", () => {
  it("1. Apsi cannot acquire a red badge", () => {
    const nav = read(BOTTOM_NAV);
    // Only the Inbox tab is ever handed a badge value, and the prop type
    // admits no other tab id.
    expect(nav).toContain('badge={tab.id === "inbox" ? badges.inbox : undefined}');
    expect(nav).toContain('export type BadgeableTabId = Extract<MobileNavTabId, "inbox">');
    expect(nav).toContain("badges?: Partial<Record<BadgeableTabId, number>>");
  });

  it("2. Apsi opens a console and never navigates on tap", () => {
    const ask = getBusinessNavConfig("online-seller").tabs.find((tab) => tab.id === "ask")!;
    expect(ask.kind).toBe("console");
    expect(ask.to).toBeUndefined();

    const nav = read(BOTTOM_NAV);
    expect(nav).toContain("onClick={isAsk ? onOpenAsk : onOpenSales}");
    // The console is a sheet rendered over the current route, not a route.
    expect(nav).toContain("<ApsiConsoleSheet");
  });

  it("3. BottomNav cannot call the fixture getOrders() again", () => {
    const nav = readCode(BOTTOM_NAV);
    expect(nav).not.toMatch(/\bgetOrders\b/);
    expect(nav).not.toMatch(/@\/lib\/mock/);
    expect(nav).toContain("listRealOrders");
    // No demo-mode/fixture fallback branch anywhere in the nav.
    expect(nav).not.toMatch(/isDemoModeError|mockOrders|fixture/i);
  });

  it("4+5. the recent-order key keeps both halves of the principal", () => {
    const nav = readCode(BOTTOM_NAV);
    expect(nav).toContain("ordersKeys.list(principal.userId, principal.organizationId)");
    expect(nav).not.toContain('queryKey: ["mobile-nav", "recent-orders"]');
    // Without a principal there is nothing to partition by, so nothing is read.
    expect(nav).toContain("enabled: open && Boolean(principal) && canReadOrders");
  });

  it("6. a customer phone is never rendered without the server sending one", () => {
    const console_ = read(CONSOLE);
    const lookup = read(LOOKUP);
    expect(console_).toContain("result.sensitiveVisible && result.phone");
    // The lookup layer copies the server's answer; it never rebuilds a phone
    // from anything else.
    expect(lookup).toContain("phone: customer.phone");
    expect(lookup).toContain("sensitiveVisible: customer.sensitiveVisible !== false");
  });

  it("7. Apsi cannot route a fabricated record id", () => {
    const lookup = readCode(LOOKUP);
    // Every id on a result card came out of a domain response in this file.
    expect(lookup).not.toMatch(/@\/lib\/mock/);
    expect(lookup).not.toMatch(/APSA-\d/);
    expect(readCode(INPUT)).not.toMatch(/@\/lib\/mock/);
    expect(readCode(CONSOLE)).not.toMatch(/@\/lib\/mock/);
  });

  it("8. 'More' cannot return as the fifth tab", () => {
    const config = readCode(NAV_CONFIG);
    const en = JSON.parse(read("src/locales/en.json"));
    const km = JSON.parse(read("src/locales/km.json"));

    expect(config).not.toMatch(/id: "more"/);
    expect(config).not.toMatch(/moreGroups|moreActions/);
    expect(en.nav.more).toBeUndefined();
    expect(km.nav.more).toBeUndefined();
    expect(en.nav.moreActions).toBeUndefined();
  });

  it("9. payment facts cannot be fetched without payments.read", () => {
    const { runnable } = planApsiLookup(
      classifyApsiQuery(ORDER_ID),
      grantsFor(["orders.read", "delivery.read", "customers.read", "products.read"]),
    );
    expect(runnable.some((p) => p.kind === "payment-by-id")).toBe(false);
  });
});

// ── Behavioural suite, isolated ───────────────────────────────────────────────

describe("Apsi FIND layer", () => {
  it("runs its isolated runtime checks without mutating the shared module cache", async () => {
    const child = Bun.spawn([process.execPath, "test", "./src/tests/apsi-console.runtime.ts"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();

    expect(exitCode, stderr).toBe(0);
  });
});
