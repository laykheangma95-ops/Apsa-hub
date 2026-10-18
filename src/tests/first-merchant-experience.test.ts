/**
 * First-time merchant experience — Phase A.
 *
 *   A. Business currency is an explicit onboarding choice (USD or KHR), sent
 *      through the existing create_organization_for_founder contract, and an
 *      unsupported value is refused by the client validator and the server
 *      schema alike.
 *   B. Add Product prices only in the confirmed business currency, because
 *      the order RPC refuses a product priced in any other currency. The
 *      pure rules are pinned here; the mounted sheet is driven end to end in
 *      product-business-currency-mounted.runtime.ts.
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
  StaleBusinessCurrencyError,
  businessCurrencyQueryKey,
  isBusinessCurrency,
  moneyBindingIsLive,
  reconcileMoneyBinding,
  resolveBusinessCurrencyState,
  verifyBusinessCurrency,
  type BusinessCurrencyState,
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
  const A = "aaaaaaaa-0000-4000-8000-00000000000a";
  const B = "bbbbbbbb-0000-4000-8000-00000000000b";
  const USER = "cccccccc-0000-4000-8000-00000000000c";
  const principalA = { userId: USER, organizationId: A };
  const ready = (organizationId: string, currency: "USD" | "KHR"): BusinessCurrencyState => ({
    status: "ready",
    organizationId,
    currency,
  });
  const idle = { isError: false, error: null, data: undefined };

  it("only treats the two supported codes as a business currency", () => {
    expect(isBusinessCurrency("KHR")).toBe(true);
    expect(isBusinessCurrency("EUR")).toBe(false);
    expect(isBusinessCurrency(undefined)).toBe(false);
  });

  it("accepts a response only for the organization it was asked for", () => {
    expect(verifyBusinessCurrency({ organizationId: A, currency: "KHR" }, A)).toEqual({
      organizationId: A,
      currency: "KHR",
    });
    expect(() => verifyBusinessCurrency({ organizationId: B, currency: "USD" }, A)).toThrow(
      StaleBusinessCurrencyError,
    );
    expect(() => verifyBusinessCurrency({ organizationId: A, currency: "EUR" }, A)).toThrow();
    expect(() => verifyBusinessCurrency({ organizationId: A, currency: null }, A)).toThrow();
  });

  it("keys the cache by user and organization under the purged settings root", () => {
    expect(businessCurrencyQueryKey(USER, A)).toEqual(["settings", USER, A, "business-currency"]);
    expect(businessCurrencyQueryKey(USER, A)).not.toEqual(businessCurrencyQueryKey(USER, B));
  });

  it("never resolves an unknown currency to USD", () => {
    const pending = resolveBusinessCurrencyState({
      principal: principalA,
      canCreate: true,
      query: idle,
    });
    expect(pending).toEqual({ status: "loading" });
    expect(resolveBusinessCurrencyState({ principal: null, canCreate: true, query: idle })).toEqual(
      { status: "loading" },
    );
    expect(
      resolveBusinessCurrencyState({
        principal: principalA,
        canCreate: true,
        query: { isError: true, error: new Error("fetch failed"), data: undefined },
      }),
    ).toEqual({ status: "error" });
  });

  it("maps refusals to a permission state, and a missing capability to denied", () => {
    expect(
      resolveBusinessCurrencyState({
        principal: principalA,
        canCreate: true,
        query: {
          isError: true,
          error: new Error("Missing permission: products.create"),
          data: undefined,
        },
      }),
    ).toEqual({ status: "denied" });
    expect(
      resolveBusinessCurrencyState({ principal: principalA, canCreate: false, query: idle }),
    ).toEqual({ status: "denied" });
  });

  it("refuses cached data for a different organization than the principal", () => {
    expect(
      resolveBusinessCurrencyState({
        principal: principalA,
        canCreate: true,
        query: { isError: false, error: null, data: { organizationId: B, currency: "USD" } },
      }),
    ).toEqual({ status: "error" });
  });

  it("binds once, keeps the binding through a refetch, and clears amounts on any change", () => {
    const first = reconcileMoneyBinding(null, ready(A, "KHR"), false);
    expect(first).toEqual({ binding: { organizationId: A, currency: "KHR" }, clearAmounts: false });

    const binding = first.binding!;
    expect(reconcileMoneyBinding(binding, ready(A, "KHR"), true).binding).toBe(binding);
    // A pending refetch or an error leaves typed amounts alone (submit is blocked meanwhile).
    expect(reconcileMoneyBinding(binding, { status: "loading" }, true)).toEqual({
      binding,
      clearAmounts: false,
    });
    expect(reconcileMoneyBinding(binding, ready(A, "USD"), true)).toEqual({
      binding: { organizationId: A, currency: "USD" },
      clearAmounts: true,
    });
    expect(reconcileMoneyBinding(binding, ready(B, "KHR"), true).clearAmounts).toBe(true);
    // Nothing typed: re-bind silently.
    expect(reconcileMoneyBinding(binding, ready(B, "USD"), false).clearAmounts).toBe(false);
  });

  it("is live only while the state agrees with the binding", () => {
    const binding = { organizationId: A, currency: "KHR" as const };
    expect(moneyBindingIsLive(binding, ready(A, "KHR"))).toBe(true);
    expect(moneyBindingIsLive(binding, ready(A, "USD"))).toBe(false);
    expect(moneyBindingIsLive(binding, ready(B, "KHR"))).toBe(false);
    expect(moneyBindingIsLive(binding, { status: "loading" })).toBe(false);
    expect(moneyBindingIsLive(null, ready(A, "KHR"))).toBe(false);
  });

  it("the order RPC is the rule this mirrors", () => {
    const migration = fs.readFileSync(
      path.join(ROOT, "supabase/migrations/047_order_shipping_snapshot.sql"),
      "utf8",
    );
    expect(migration).toContain("IF v_variant.price_currency <> v_currency THEN");
  });

  it("the Add Product sheet has no USD fallback and offers only the bound currency", () => {
    const sheet = read("src/components/products/CreateProductSheet.tsx");
    expect(sheet).not.toMatch(/useState<Currency(?: \| null)?>\("USD"\)/);
    expect(sheet).not.toContain("initialPriceCurrency");
    expect(sheet).toContain("currencies={[live.currency]}");
    expect(sheet).toContain("disabled={saving || !live}");
    expect(sheet).toContain("await lookup.confirm(bound)");
    // The product contract is unchanged: both currency fields still go to the server.
    expect(sheet).toContain("priceCurrency: currency,");
    expect(sheet).toContain("costCurrency: costAmount === null ? null : currency,");
  });

  it("the currency read is gated on products.create and echoes its organization", () => {
    const service = read("src/server/org/get-business-currency.ts");
    expect(service).toContain('ctx.require("products.create");');
    expect(service).toContain('.eq("id", ctx.organizationId)');
    expect(service).toContain("return { organizationId: ctx.organizationId, currency };");
    const hook = read("src/hooks/use-business-currency.ts");
    expect(hook).toContain('capabilities.can("products.create")');
    expect(hook).toContain("verifyBusinessCurrency(await getBusinessCurrencyFn(), organizationId)");
    expect(hook).not.toContain("organization.read");
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
    "catalog.variant.businessCurrency.loading",
    "catalog.variant.businessCurrency.error",
    "catalog.variant.businessCurrency.denied",
    "catalog.variant.businessCurrency.locked",
    "catalog.variant.businessCurrency.changed",
    "catalog.variant.businessCurrency.confirmFailed",
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

  it("the currency-bearing messages interpolate the currency in both languages", () => {
    for (const locale of [en, km]) {
      for (const key of ["locked", "changed"]) {
        expect(String(lookup(locale, `catalog.variant.businessCurrency.${key}`))).toContain(
          "{{currency}}",
        );
      }
    }
  });
});
