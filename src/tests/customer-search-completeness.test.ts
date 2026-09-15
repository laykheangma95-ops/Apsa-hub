/**
 * An incomplete customer search must never be presented as absence.
 *
 * The Customer service already answers honestly: a bounded phone scan that
 * stops at its safety limit returns `items: []` together with
 * `truncated: true`, and that pair is plumbed through to every surface. The
 * defect this file exists to pin was purely one of PRESENTATION — all three
 * surfaces gated their "there may be more" caveat on having at least one
 * result, while gating the empty state on having none. At zero results the
 * caveat therefore disappeared and the absence claim stood alone:
 *
 *     items: []          ->  "No customer matched this phone number."
 *     truncated: true        "No customer found."
 *                            "No customer matched that search."
 *
 * Every one of those is false for a tenant larger than the scan bound, and it
 * is the sentence a staff member repeats to a real customer as "you are not in
 * our system". A search that stopped early gets its own state instead.
 *
 * The component assertions below are source scans, because this repository has
 * no DOM test environment (see launch-safety-cache-isolation.test.ts, which
 * pins component wiring the same way). They run against code with comments
 * stripped, so the prose explaining a guard can never stand in for the guard.
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  MIN_LOCAL_PHONE_DIGITS,
  looksLikeCustomerPhoneQuery,
  phoneDigitsMatch,
} from "@/lib/customer-search";
import { classifyApsiQuery } from "@/lib/apsi/input";

const ROOT = process.cwd();

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8").replace(/\r\n/g, "\n");
}

/** Code only — a comment describing a guard must never satisfy a scan for it. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const APSI_CONSOLE = "src/components/apsi/ApsiConsoleSheet.tsx";
const POS_SHEET = "src/components/pos/PosCustomerSheet.tsx";
const ORDER_SHEET = "src/components/orders/CreateRealOrderSheet.tsx";
const APSI_LOOKUP = "src/lib/apsi/lookup.ts";

/** The declaration of `name`, up to the end of its statement. */
function declaration(source: string, name: string): string {
  const start = source.indexOf(`const ${name} =`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(";", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Apsi: a bounded search that matched nothing is not a not-found", () => {
  const src = stripComments(readSource(APSI_CONSOLE));

  it("withholds the definitive not-found line when the search was incomplete", () => {
    /*
     * Removing `!outcome!.incomplete` from this declaration restores the
     * defect: a truncated scan with zero matches renders apsi.empty.* again.
     */
    expect(declaration(src, "nothingFound")).toContain("!outcome!.incomplete");
  });

  it("has a distinct bounded state for answered + incomplete + zero results", () => {
    const bounded = declaration(src, "boundedNoMatch");
    expect(bounded).toContain("outcome!.answered");
    expect(bounded).toContain("outcome!.incomplete");
    expect(bounded).toContain("outcome!.results.length === 0");
  });

  it("renders the bounded copy, and renders it instead of the not-found copy", () => {
    expect(src).toContain("boundedNoMatch ?");
    expect(src).toContain('t("apsi.empty.bounded")');

    // Mutually exclusive by construction: nothingFound requires !incomplete
    // and boundedNoMatch requires incomplete, so the two can never co-render.
    expect(declaration(src, "nothingFound")).toContain("!outcome!.incomplete");
    expect(declaration(src, "boundedNoMatch")).toContain("outcome!.incomplete");
  });
});

describe("POS customer picker: incomplete is a caveat, never 'No customer found'", () => {
  const src = stripComments(readSource(POS_SHEET));

  it("withholds the empty notice when the search was incomplete", () => {
    expect(declaration(src, "emptyResult")).toContain("!incomplete");
  });

  it("has a bounded state for zero results from an incomplete search", () => {
    const bounded = declaration(src, "boundedNoMatch");
    expect(bounded).toContain("results.length === 0");
    expect(bounded).toContain("incomplete");
    expect(src).toContain('t("pos.customer.bounded.title")');
    expect(src).toContain('t("pos.customer.bounded.body")');
  });

  it("drives the completeness caveat from the server's answer, not from the list length", () => {
    /*
     * The caveat used to live INSIDE the `results.length > 0` block, so zero
     * results silently dropped it. It is now a sibling of the list, guarded
     * explicitly — which is what makes the zero case reachable at all.
     */
    const listStart = src.indexOf("results.length > 0 ?");
    const listEnd = src.indexOf("</>", listStart);
    expect(listStart).toBeGreaterThan(-1);
    expect(listEnd).toBeGreaterThan(listStart);

    // The caveat is not rendered from inside the results fragment...
    expect(src.slice(listStart, listEnd)).not.toContain("pos.customer.more");
    // ...it is a sibling of it, with its own explicit guard.
    expect(src.indexOf("pos.customer.more")).toBeGreaterThan(listEnd);
    expect(src).toContain("incomplete && results.length > 0 ?");
  });
});

describe("Create Order customer picker: no contradictory empty + incomplete copy", () => {
  const src = stripComments(readSource(ORDER_SHEET));

  it("withholds the empty line when the search was incomplete", () => {
    expect(declaration(src, "searchEmpty")).toContain("!searchIncomplete");
  });

  it("has a bounded state, and the 'more' line no longer fires at zero results", () => {
    const bounded = declaration(src, "searchBounded");
    expect(bounded).toContain("customerList.length === 0");
    expect(bounded).toContain("searchIncomplete");
    expect(src).toContain('t("orderCreate.boundedCustomers")');

    // The two lines that used to appear together are now mutually exclusive.
    expect(src).toContain("searchIncomplete && customerList.length > 0 ?");
  });
});

describe("Every bounded-search string exists in both languages", () => {
  const en = JSON.parse(readSource("src/locales/en.json")) as Record<string, never>;
  const km = JSON.parse(readSource("src/locales/km.json")) as Record<string, never>;

  const get = (bundle: unknown, dotted: string): unknown =>
    dotted
      .split(".")
      .reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], bundle);

  const KEYS = [
    "apsi.empty.bounded",
    "pos.customer.bounded.title",
    "pos.customer.bounded.body",
    "orderCreate.boundedCustomers",
  ];

  for (const key of KEYS) {
    it(`${key} is present and translated`, () => {
      const enValue = get(en, key);
      const kmValue = get(km, key);
      expect(typeof enValue).toBe("string");
      expect(typeof kmValue).toBe("string");
      expect((enValue as string).length).toBeGreaterThan(0);
      expect((kmValue as string).length).toBeGreaterThan(0);
      // Khmer must be Khmer, not the English string copied across.
      expect(kmValue).not.toBe(enValue);
      expect(kmValue as string).toMatch(/[ក-៿]/u);
    });
  }

  it("never claims absence in the bounded copy", () => {
    for (const key of KEYS) {
      const value = get(en, key) as string;
      expect(value.toLowerCase()).not.toContain("no customer matched");
      expect(value.toLowerCase()).not.toContain("no customer found");
    }
  });
});

describe("An 8-digit barcode is not a phone number", () => {
  /*
   * UPC-E is eight digits and its number-system digit is almost always 0, so
   * "01234565" is an ordinary retail barcode. An eight-digit classification
   * floor read it as a Cambodian local number, which routed it to Customer
   * phone search ALONE — the order-code early-return means the Catalog probes
   * were dropped, and a scanned product came back as "no customer matched
   * this phone number".
   */
  it("does not classify a UPC-E / EAN-8 style token as a phone query", () => {
    expect(looksLikeCustomerPhoneQuery("01234565")).toBe(false);
    expect(looksLikeCustomerPhoneQuery("96385074")).toBe(false);
  });

  it("still routes an 8-digit barcode to Catalog", () => {
    const kinds = classifyApsiQuery("01234565").probes.map((p) => p.kind);
    expect(kinds).toContain("product-by-barcode");
    expect(kinds).toContain("product-by-sku");
    expect(kinds).not.toContain("customer-by-phone");
  });

  it("keeps EAN-13 and UPC-A out of the Customer domain too", () => {
    for (const barcode of ["4006381333931", "0123456789012", "012345678905"]) {
      expect(looksLikeCustomerPhoneQuery(barcode)).toBe(false);
      const kinds = classifyApsiQuery(barcode).probes.map((p) => p.kind);
      expect(kinds).toContain("product-by-barcode");
      expect(kinds).not.toContain("customer-by-phone");
    }
  });
});

describe("Supported customer phone numbers still route and match", () => {
  it("accepts every local and international shape the app actually stores", () => {
    for (const phone of [
      "012345678",
      "012 345 678",
      "012-345-678",
      "០១២៣៤៥៦៧៨",
      "0123456789",
      "+855 12 345 678",
    ]) {
      expect({ phone, ok: looksLikeCustomerPhoneQuery(phone) }).toEqual({ phone, ok: true });
    }
  });

  it("routes a phone number to Customers and to no other domain", () => {
    expect(classifyApsiQuery("012 345 678").probes.map((p) => p.kind)).toEqual([
      "customer-by-phone",
    ]);
  });

  it("keeps the local floor at nine digits, matching every stored number", () => {
    expect(MIN_LOCAL_PHONE_DIGITS).toBe(9);
    // Eight digits is below the floor; the ninth digit is what starts a search.
    expect(looksLikeCustomerPhoneQuery("01234567")).toBe(false);
    expect(looksLikeCustomerPhoneQuery("012345678")).toBe(true);
  });

  it("still matches by prefix and never by suffix, unchanged by the new floor", () => {
    expect(phoneDigitsMatch("012345678", "012345678")).toBe(true);
    expect(phoneDigitsMatch("012 345 678", "០១២៣៤៥៦៧៨")).toBe(true);
    // No country-code conversion, in either direction.
    expect(phoneDigitsMatch("+855 12 345 678", "12345678")).toBe(false);
    expect(phoneDigitsMatch("012345678", "345678")).toBe(false);
  });
});

describe("Apsi never hardcodes the sensitive grant at the client boundary", () => {
  const src = stripComments(readSource(APSI_LOOKUP));

  it("reads customers.view_sensitive from the caller's own grants", () => {
    expect(src).toContain('grants.can("customers.view_sensitive")');
    // The literal that made searchRealCustomers' client-side phone guard
    // unreachable must not come back.
    expect(src).not.toContain("searchRealCustomers(probe.value, true");
  });

  it("still requires BOTH keys for the phone probe, not either", () => {
    expect(src).toContain('"customer-by-phone": ["customers.read", "customers.view_sensitive"]');
  });
});
