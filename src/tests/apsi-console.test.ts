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
  classifyApsiQuery,
  looksLikePersonName,
  looksLikePhoneNumber,
  normalizeApsiQuery,
} from "@/lib/apsi/input";
import { APSI_PROBE_PERMISSION, planApsiLookup } from "@/lib/apsi/lookup";
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

describe("Apsi says what it cannot do instead of finding nothing", () => {
  it("flags a phone number as an unsupported customer search", () => {
    for (const input of ["012 345 678", "+855 12 345 678", "០១២៣៤៥៦៧៨"]) {
      const plan = classifyApsiQuery(input);
      expect({ input, unsupported: plan.unsupported }).toEqual({
        input,
        unsupported: ["customer-phone-search"],
      });
    }
  });

  it("flags a bare name as an unsupported customer search", () => {
    expect(classifyApsiQuery("Sokha").unsupported).toEqual(["customer-name-search"]);
    expect(looksLikePersonName("Sokha")).toBe(true);
    expect(looksLikePersonName("APSA-1042")).toBe(false);
  });

  it("does not mistake an order code or tracking number for a phone number", () => {
    expect(looksLikePhoneNumber("APSA-1042")).toBe(false);
    expect(looksLikePhoneNumber("JT-9001")).toBe(false);
    expect(looksLikePhoneNumber("012345678")).toBe(true);
  });

  /*
   * A phone number can still be part of a tracking reference, so the delivery
   * search runs anyway. The honest note sits alongside the result, not instead
   * of the attempt.
   */
  it("still runs the delivery search for a phone-shaped input", () => {
    const plan = classifyApsiQuery("012 345 678");
    expect(plan.probes.map((p) => p.kind)).toEqual(["delivery-search"]);
  });
});

// ── Permission model ──────────────────────────────────────────────────────────

describe("Apsi reveals nothing the member could not see directly", () => {
  it("maps every probe to a permission key this UI is allowed to consult", () => {
    for (const [kind, key] of Object.entries(APSI_PROBE_PERMISSION)) {
      expect({ kind, declared: (UI_PERMISSION_KEYS as readonly string[]).includes(key) }).toEqual({
        kind,
        declared: true,
      });
    }
  });

  it("keys each probe to the permission its own server function requires", () => {
    expect(APSI_PROBE_PERMISSION).toEqual({
      "order-by-id": "orders.read",
      "payment-by-id": "payments.read",
      "delivery-by-id": "delivery.read",
      "customer-by-id": "customers.read",
      "product-by-barcode": "products.read",
      "product-by-sku": "products.read",
      "delivery-search": "delivery.read",
    });
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
    const key = apsiKeys.lookup("user-a", "org-a", "APSA-1042");

    expect(key).toEqual([APSI_QUERY_ROOT, "user-a", "org-a", "lookup", "APSA-1042"]);
    expect(key).not.toEqual(apsiKeys.lookup("user-b", "org-a", "APSA-1042"));
    expect(key).not.toEqual(apsiKeys.lookup("user-a", "org-b", "APSA-1042"));
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
