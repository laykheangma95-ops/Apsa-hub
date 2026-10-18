/**
 * First-time merchant experience — Phase A.
 *
 *   A. Business currency is an explicit onboarding choice (USD or KHR), sent
 *      through the existing create_organization_for_founder contract, and an
 *      unsupported value is refused by the client validator and the server
 *      schema alike.
 *   B. The first product starts in the business currency, because the order
 *      RPC refuses a product priced in any other currency.
 *   C. Empty Products / POS / Orders screens point at the next real step,
 *      gated on the permission that step needs.
 *   D. Every new string exists in Khmer and English.
 *
 * Run: bun test src/tests/first-merchant-experience.test.ts
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import en from "../locales/en.json";
import km from "../locales/km.json";
import {
  BUSINESS_CURRENCIES,
  initialPriceCurrency,
  isBusinessCurrency,
  priceCurrencyMismatch,
} from "../lib/business-currency";
import { validateOnboardingForm } from "../lib/onboarding-form";
import { CreateOrganizationInputSchema } from "../lib/org-schema";

const ROOT = process.cwd();
const read = (relative: string) =>
  fs
    .readFileSync(path.join(ROOT, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const VALID = { name: "Angkor Coffee", slug: "angkor-coffee", currency: "KHR" };

// ── A. Business currency at onboarding ───────────────────────────────────────

describe("onboarding business currency", () => {
  it("offers exactly the currencies the organizations CHECK constraint allows", () => {
    expect([...BUSINESS_CURRENCIES]).toEqual(["USD", "KHR"]);
    const migration = fs.readFileSync(
      path.join(ROOT, "supabase/migrations/002_organizations.sql"),
      "utf8",
    );
    expect(migration).toContain("CHECK (default_currency IN ('USD', 'KHR'))");
  });

  it("refuses to submit until a currency is chosen — no silent default", () => {
    const result = validateOnboardingForm({ ...VALID, currency: "" });
    expect(result).toEqual({ ok: false, errors: { currency: "currencyRequired" } });
  });

  it("refuses an unsupported or mis-cased currency", () => {
    for (const currency of ["EUR", "usd", "khr", " KHR", "THB"]) {
      const result = validateOnboardingForm({ ...VALID, currency });
      expect(result.ok).toBe(false);
    }
  });

  it("passes the chosen currency through unchanged", () => {
    for (const currency of ["USD", "KHR"] as const) {
      const result = validateOnboardingForm({ ...VALID, currency });
      expect(result).toEqual({
        ok: true,
        input: {
          legalName: "Angkor Coffee",
          displayName: "Angkor Coffee",
          slug: "angkor-coffee",
          currency,
        },
      });
    }
  });

  it("reports every missing field at once and trims name and slug", () => {
    expect(validateOnboardingForm({ name: "  ", slug: "", currency: "" })).toEqual({
      ok: false,
      errors: { name: "nameRequired", slug: "slugRequired", currency: "currencyRequired" },
    });
    expect(validateOnboardingForm({ name: "A", slug: "-bad-", currency: "USD" })).toEqual({
      ok: false,
      errors: { slug: "slugFormat" },
    });
    const trimmed = validateOnboardingForm({ ...VALID, name: "  Angkor  ", slug: " angkor " });
    expect(trimmed.ok && trimmed.input.displayName).toBe("Angkor");
    expect(trimmed.ok && trimmed.input.slug).toBe("angkor");
  });

  it("the server schema independently refuses a currency outside USD/KHR", () => {
    const base = { legalName: "A", displayName: "A", slug: "angkor-coffee" };
    expect(CreateOrganizationInputSchema.safeParse({ ...base, currency: "EUR" }).success).toBe(
      false,
    );
    expect(CreateOrganizationInputSchema.parse({ ...base, currency: "KHR" }).currency).toBe("KHR");
  });

  it("the onboarding screen starts unselected and submits the validated input", () => {
    const route = read("src/routes/onboarding.tsx");
    expect(route).toContain('const [currency, setCurrency] = useState("");');
    expect(route).toContain("validateOnboardingForm({ name, slug, currency })");
    expect(route).toContain("createOrganizationFn({ data: validation.input })");
    expect(route).toContain("BUSINESS_CURRENCIES.map");
    // A real radio group: keyboard-navigable and announced as one required choice.
    expect(route).toContain("<RadioGroup");
    expect(route).toContain("aria-required");
    expect(route).toContain("<fieldset");
    expect(route).toContain("<legend");
  });

  it("onboarding respects the device safe areas", () => {
    const route = read("src/routes/onboarding.tsx");
    expect(route).toContain("safe-top safe-bottom");
  });

  it("the currency stays read-only after onboarding — no edit path exists", () => {
    const schema = read("src/lib/org-schema.ts");
    const update = schema.slice(schema.indexOf("UpdateOrganizationProfileInputSchema"));
    expect(update).toContain(".strict()");
    expect(update).not.toMatch(/currency/i);
  });
});

// ── B. First product in the business currency ────────────────────────────────

describe("first product currency", () => {
  it("starts a new price in the business currency once it is known", () => {
    expect(initialPriceCurrency("KHR")).toBe("KHR");
    expect(initialPriceCurrency("USD")).toBe("USD");
    // Unknown (no organization.read, pending, failed): previous behaviour.
    expect(initialPriceCurrency(null)).toBe("USD");
  });

  it("flags a price that the order RPC would refuse, and only then", () => {
    expect(priceCurrencyMismatch("USD", "KHR")).toBe(true);
    expect(priceCurrencyMismatch("KHR", "USD")).toBe(true);
    expect(priceCurrencyMismatch("KHR", "KHR")).toBe(false);
    expect(priceCurrencyMismatch("USD", null)).toBe(false);
  });

  it("only treats the two supported codes as a business currency", () => {
    expect(isBusinessCurrency("KHR")).toBe(true);
    expect(isBusinessCurrency("EUR")).toBe(false);
    expect(isBusinessCurrency(undefined)).toBe(false);
  });

  it("the order RPC is the rule this mirrors", () => {
    const migration = fs.readFileSync(
      path.join(ROOT, "supabase/migrations/047_order_shipping_snapshot.sql"),
      "utf8",
    );
    expect(migration).toContain("IF v_variant.price_currency <> v_currency THEN");
  });

  it("the Add Product sheet derives its currency from the business, not a fixed USD", () => {
    const sheet = read("src/components/products/CreateProductSheet.tsx");
    expect(sheet).toContain("useBusinessCurrency(open)");
    expect(sheet).toContain("initialPriceCurrency(businessCurrency)");
    expect(sheet).not.toContain('useState<Currency>("USD")');
    expect(sheet).toContain("catalog.variant.businessCurrencyMismatch");
    // The product contract is unchanged: both currency fields still go to the server.
    expect(sheet).toContain("priceCurrency,");
    expect(sheet).toContain("costCurrency: costAmount === null ? null : costCurrency");
  });

  it("the business currency read is gated on organization.read and fails closed to null", () => {
    const hook = read("src/hooks/use-business-currency.ts");
    expect(hook).toContain('capabilities.can("organization.read")');
    expect(hook).toContain("ORGANIZATION_PROFILE_QUERY_KEY");
    expect(hook).toContain("if (!canReadOrganization) return null;");
  });
});

// ── C. Empty screens lead to the next real step ──────────────────────────────

describe("first-use empty states", () => {
  it("an empty Products screen offers Add Product only to a member who can create one", () => {
    const route = read("src/routes/app.products.tsx");
    expect(route).toContain('t("catalog.list.firstProduct.title")');
    const firstProduct = route.slice(route.indexOf('t("catalog.list.firstProduct.title")') - 400);
    expect(firstProduct).toContain("canCreateProduct ? (");
    expect(firstProduct).toContain('status === "ACTIVE"');
    expect(firstProduct).toContain("categoryId === null");
    expect(firstProduct).toContain("onClick={() => setCreateOpen(true)}");
  });

  it("an empty POS links to Products only with products.create, and says who can add otherwise", () => {
    const route = read("src/routes/app.pos.tsx");
    expect(route).toContain('capabilities.can("products.create") ? (');
    expect(route).toContain('<Link to="/app/products">{t("pos.empty.addProduct")}</Link>');
    expect(route).toContain('body={t("pos.empty.bodyNoAccess")}');
  });

  it("an empty Orders list offers POS only with orders.create", () => {
    const route = read("src/routes/app.orders.tsx");
    expect(route).toContain("canCreateOrder ? (");
    expect(route).toContain('<Link to="/app/pos">{t("orderList.empty.openPos")}</Link>');
  });

  it("no mascot is added to the operational empty states", () => {
    for (const file of [
      "src/routes/app.products.tsx",
      "src/routes/app.pos.tsx",
      "src/routes/app.orders.tsx",
    ]) {
      expect(read(file)).not.toMatch(/<Apsi\b/);
    }
  });
});

// ── D. Khmer and English copy ────────────────────────────────────────────────

describe("first-use copy exists in both locales", () => {
  const KEYS = [
    "onboarding.currencyLabel",
    "onboarding.currencyHint",
    "onboarding.currency.USD.label",
    "onboarding.currency.USD.example",
    "onboarding.currency.KHR.label",
    "onboarding.currency.KHR.example",
    "onboarding.errors.currencyRequired",
    "catalog.list.firstProduct.title",
    "catalog.list.firstProduct.body",
    "catalog.list.firstProduct.action",
    "catalog.variant.businessCurrencyMismatch",
    "pos.empty.body",
    "pos.empty.bodyNoAccess",
    "pos.empty.addProduct",
    "orderList.empty.body",
    "orderList.empty.openPos",
  ];

  const lookup = (locale: unknown, key: string): unknown =>
    key
      .split(".")
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
        locale,
      );

  it("every key is a non-empty string in English and Khmer", () => {
    for (const key of KEYS) {
      for (const [name, locale] of [
        ["en", en],
        ["km", km],
      ] as const) {
        const value = lookup(locale, key);
        expect({ name, key, ok: typeof value === "string" && value.trim() !== "" }).toEqual({
          name,
          key,
          ok: true,
        });
      }
    }
  });

  it("the Khmer copy is actually Khmer, not English left in place", () => {
    for (const key of KEYS.filter((k) => !k.endsWith(".example"))) {
      expect({ key, khmer: /[ក-៿]/.test(String(lookup(km, key))) }).toEqual({
        key,
        khmer: true,
      });
    }
  });

  it("the mismatch message interpolates the currency in both languages", () => {
    for (const locale of [en, km]) {
      expect(String(lookup(locale, "catalog.variant.businessCurrencyMismatch"))).toContain(
        "{{currency}}",
      );
    }
  });
});
