/**
 * Add Product × business currency — MOUNTED regression suite (PR #130 P2s).
 *
 * Mounts the real <CreateProductSheet> in happy-dom and drives it the way a
 * merchant does, against a simulated server whose active organization,
 * currency and response timing the test controls.
 *
 *   P2 #1  Unsafe USD fallback. A pending, failed or refused currency lookup
 *          used to fall back to USD, so a KHR business saved USD products the
 *          order RPC refuses (`currency_mismatch`). Now: no amount field and no
 *          submit until the currency is known; a retryable error; a permission
 *          state; and only the business currency can be chosen.
 *   P2 #2  Silent money reinterpretation. An amount typed under one currency
 *          was re-read in another when a late response arrived ($5,000.00 →
 *          5,000៛). Now: amounts are bound to organization + currency, cleared
 *          (and announced) when either changes, stale responses for another
 *          organization are rejected, and the create re-confirms the binding
 *          with the server first.
 *
 * Replaced, and only these: the getBusinessCurrencyFn transport (@/api/org),
 * the /app principal hook, and createCatalogProduct (captured, not sent).
 *
 * Runs in its own process (product-business-currency-mounted.test.ts): it
 * installs DOM globals and module mocks.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ── Simulated server ─────────────────────────────────────────────────────────

const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const USER = "cccccccc-0000-4000-8000-00000000000c";

/** The organization the SERVER resolves from the session right now. */
let serverOrg = ORG_A;
let currencies: Record<string, string> = { [ORG_A]: "KHR", [ORG_B]: "USD" };
let serverMode: "answer" | "hold" | "fail" | "deny" = "answer";
let calls = 0;
/** Held requests, each answered for the org the server saw AT REQUEST TIME. */
const held: { org: string; release: () => void }[] = [];

function answerFor(org: string) {
  return { organizationId: org, currency: currencies[org] };
}

mock.module("@/api/org", () => ({
  getBusinessCurrencyFn: () => {
    calls += 1;
    const org = serverOrg;
    if (serverMode === "fail") return Promise.reject(new Error("fetch failed"));
    if (serverMode === "deny")
      return Promise.reject(new Error("Missing permission: products.create"));
    if (serverMode === "hold") {
      return new Promise((resolve) => held.push({ org, release: () => resolve(answerFor(org)) }));
    }
    return Promise.resolve(answerFor(org));
  },
  getOrganizationProfileFn: async () => {
    throw new Error("Add Product must not depend on the settings profile read");
  },
  createOrganizationFn: async () => ({ ok: false, code: "internal_error", message: "unused" }),
}));

// The server read itself (getBusinessCurrency) runs over this table stub.
let orgRows: Record<string, unknown> = {};
const orgReads: string[] = [];
mock.module("@/lib/supabase/server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        eq: (_column: string, id: string) => ({
          single: async () => {
            orgReads.push(`${table}:${id}`);
            return id in orgRows
              ? { data: { default_currency: orgRows[id] }, error: null }
              : { data: null, error: { message: "not found" } };
          },
        }),
      }),
    }),
  },
}));

let principal: { userId: string; organizationId: string } | null = {
  userId: USER,
  organizationId: ORG_A,
};
mock.module("@/hooks/use-app-principal", () => ({ useAppPrincipal: () => principal }));

const sent: any[] = [];
/** "hold" parks each create until the test resolves or rejects it. */
let createMode: "answer" | "hold" = "answer";
const heldCreates: { resolve: () => void; reject: (e: Error) => void }[] = [];
const realCatalog = await import("@/lib/catalog");
mock.module("@/lib/catalog", () => ({
  ...realCatalog,
  createCatalogProduct: async (input: any) => {
    sent.push(input);
    const product = { id: crypto.randomUUID(), ...input, variants: [] };
    if (createMode === "hold") {
      return new Promise((resolve, reject) =>
        heldCreates.push({ resolve: () => resolve(product), reject }),
      );
    }
    return product;
  },
}));

// ── DOM ──────────────────────────────────────────────────────────────────────

GlobalRegistrator.register({ url: "http://localhost/app/products" });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const reducedMotion = (query: string) => ({
  matches: /prefers-reduced-motion:\s*reduce/.test(query),
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
});
(window as any).matchMedia = reducedMotion;
(globalThis as any).matchMedia = reducedMotion;
(window as any).HTMLElement.prototype.scrollIntoView = function () {};
const { MotionGlobalConfig } = await import("motion/react");
MotionGlobalConfig.skipAnimations = true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CapabilityFixtureProvider } = await import("@/hooks/use-capabilities");
const i18n = (await import("@/lib/i18n")).default;
const en = (await import("@/locales/en.json")).default as any;
const { CreateProductSheet } = await import("@/components/products/CreateProductSheet");
const { businessCurrencyQueryKey } = await import("@/lib/business-currency");

const T = en.catalog.variant.businessCurrency;
const ADD = en.catalog.list.addProduct;
const RETRY = en.common.retry;

// ── Harness ──────────────────────────────────────────────────────────────────

let open = true;
let permissions: string[] = ["products.create", "products.update_cost"];
let canSetCost = true;
let categoriesProp: any[] = [];
let created = 0;
let client: InstanceType<typeof QueryClient>;
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
const crashes: unknown[] = [];

function tree() {
  return React.createElement(
    QueryClientProvider,
    { client },
    React.createElement(
      CapabilityFixtureProvider,
      { permissions: permissions as any },
      React.createElement(CreateProductSheet, {
        open,
        onOpenChange: (next: boolean) => {
          open = next;
        },
        categories: categoriesProp,
        canSetCost,
        onCreated: () => {
          created += 1;
        },
      }),
    ),
  );
}

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function rerender() {
  await act(async () => root!.render(tree()));
  await settle();
}

async function mount({ fresh = true } = {}) {
  if (fresh) client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container, { onUncaughtError: (e: unknown) => crashes.push(e) });
  await rerender();
}

async function unmount() {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  serverOrg = ORG_A;
  currencies = { [ORG_A]: "KHR", [ORG_B]: "USD" };
  serverMode = "answer";
  calls = 0;
  held.length = 0;
  principal = { userId: USER, organizationId: ORG_A };
  open = true;
  permissions = ["products.create", "products.update_cost"];
  canSetCost = true;
  categoriesProp = [];
  sent.length = 0;
  createMode = "answer";
  heldCreates.length = 0;
  created = 0;
});

afterEach(async () => {
  await unmount();
  client?.clear();
  expect(crashes).toEqual([]);
  crashes.length = 0;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// ── Page helpers ─────────────────────────────────────────────────────────────

const text = () => document.body.textContent ?? "";
const price = () => document.getElementById("product-price") as HTMLInputElement | null;
const cost = () => document.getElementById("product-cost") as HTMLInputElement | null;

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as
    HTMLButtonElement | undefined;
}

/** The currency chips offered beside an amount field. */
function currencyChoices(input: HTMLInputElement | null): string[] {
  const group = input?.parentElement?.querySelector("[role=group]");
  return [...(group?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim() ?? "");
}

async function type(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error(`no input; page: ${text().slice(0, 300)}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

async function fillName() {
  await type(document.getElementById("product-name-km") as HTMLInputElement, "កាហ្វេ");
}

async function submit() {
  const b = button(ADD);
  if (!b) throw new Error("no submit button");
  await act(async () => b.click());
  await settle();
}

async function releaseAll() {
  const pending = held.splice(0);
  await act(async () => {
    for (const h of pending) h.release();
  });
  await settle();
}

async function switchOrganization(org: string) {
  serverOrg = org;
  principal = { userId: USER, organizationId: org };
  await rerender();
}

async function closeWithEscape() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await settle();
}

/** Click submit without waiting for anything held to resolve. */
async function clickSubmit() {
  const b = button(ADD);
  if (!b) throw new Error("no submit button");
  await act(async () => b.click());
  await settle();
}

const nameKm = () => document.getElementById("product-name-km") as HTMLInputElement | null;

const changedText = (currency: string) => T.changed.replaceAll("{{currency}}", currency);

// ── USD / KHR ────────────────────────────────────────────────────────────────

describe("prices only in the business currency", () => {
  it("USD business: price and cost are sent as USD minor units", async () => {
    currencies[ORG_A] = "USD";
    await mount();
    expect(currencyChoices(price())).toEqual(["USD"]);
    expect(currencyChoices(cost())).toEqual(["USD"]);
    await fillName();
    await type(price(), "12.50");
    await type(cost(), "3");
    await submit();
    expect(sent).toHaveLength(1);
    expect(sent[0].initialVariant).toMatchObject({
      priceAmount: 1250,
      priceCurrency: "USD",
      costAmount: 300,
      costCurrency: "USD",
    });
  });

  it("KHR business: price and cost are sent as riel, and USD is not offered", async () => {
    await mount();
    expect(currencyChoices(price())).toEqual(["KHR"]);
    expect(text()).toContain(T.locked.replace("{{currency}}", "KHR"));
    await fillName();
    await type(price(), "5000");
    await type(cost(), "2000");
    await submit();
    expect(sent[0].initialVariant).toMatchObject({
      priceAmount: 5000,
      priceCurrency: "KHR",
      costAmount: 2000,
      costCurrency: "KHR",
    });
  });

  it("does not read the settings profile (organization.read is not required)", async () => {
    await mount();
    expect(price()).not.toBeNull();
    expect(calls).toBe(1);
  });
});

// ── P2 #1: unknown is never USD ──────────────────────────────────────────────

describe("pending, failed and refused lookups block pricing", () => {
  it("pending: a loading state, no amount field, submit disabled, nothing sent", async () => {
    serverMode = "hold";
    await mount();
    expect(text()).toContain(T.loading);
    expect(price()).toBeNull();
    expect(cost()).toBeNull();
    expect(button(ADD)!.disabled).toBe(true);
    await fillName();
    await submit();
    expect(sent).toHaveLength(0);
  });

  it("failed: a retryable error, then retry recovers the real currency", async () => {
    serverMode = "fail";
    await mount();
    expect(text()).toContain(T.error);
    expect(price()).toBeNull();
    expect(button(ADD)!.disabled).toBe(true);
    await fillName();
    await submit();
    expect(sent).toHaveLength(0);

    serverMode = "answer";
    const retry = button(RETRY);
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    await settle();
    expect(currencyChoices(price())).toEqual(["KHR"]);
    await type(price(), "4000");
    await submit();
    expect(sent[0].initialVariant).toMatchObject({ priceAmount: 4000, priceCurrency: "KHR" });
  });

  it("unauthorized staff (server refuses): a permission state, no retry, nothing sent", async () => {
    serverMode = "deny";
    await mount();
    expect(text()).toContain(T.denied);
    expect(button(RETRY)).toBeUndefined();
    expect(price()).toBeNull();
    expect(button(ADD)!.disabled).toBe(true);
  });

  it("without products.create the server is never asked and nothing can be priced", async () => {
    permissions = [];
    await mount();
    expect(calls).toBe(0);
    expect(text()).toContain(T.denied);
    expect(price()).toBeNull();
  });

  it("an unresolved principal is loading, never a default currency", async () => {
    principal = null;
    await mount();
    expect(calls).toBe(0);
    expect(text()).toContain(T.loading);
    expect(price()).toBeNull();
  });
});

// ── P2 #2: no silent reinterpretation ────────────────────────────────────────

describe("entered amounts are never reinterpreted", () => {
  it("a later response with a different currency clears the amounts and says so", async () => {
    await mount();
    await fillName();
    await type(price(), "5000");
    await type(cost(), "2000");

    currencies[ORG_A] = "USD";
    await act(async () => {
      await client.invalidateQueries({ queryKey: businessCurrencyQueryKey(USER, ORG_A) });
    });
    await settle();

    expect(price()!.value).toBe("");
    expect(cost()!.value).toBe("");
    expect(currencyChoices(price())).toEqual(["USD"]);
    expect(text()).toContain(changedText("USD"));
    await submit();
    expect(sent).toHaveLength(0);
  });

  it("organization switch A → B → A: amounts cleared each time, each sent in its own currency", async () => {
    await mount();
    await fillName();
    await type(price(), "5000");

    await switchOrganization(ORG_B);
    expect(price()!.value).toBe("");
    expect(currencyChoices(price())).toEqual(["USD"]);
    expect(text()).toContain(changedText("USD"));
    await type(price(), "12.50");

    await switchOrganization(ORG_A);
    expect(price()!.value).toBe("");
    expect(currencyChoices(price())).toEqual(["KHR"]);
    expect(text()).toContain(changedText("KHR"));
    await type(price(), "7000");
    await submit();
    expect(sent).toHaveLength(1);
    expect(sent[0].initialVariant).toMatchObject({ priceAmount: 7000, priceCurrency: "KHR" });
  });

  it("a stale response for the previous organization is not shown under the new one", async () => {
    serverMode = "hold";
    await mount();
    expect(held.map((h) => h.org)).toEqual([ORG_A]);

    await switchOrganization(ORG_B);
    // A's (KHR) reply lands after the switch; B's own request is still out.
    const [first] = held.splice(0, 1);
    await act(async () => first!.release());
    await settle();
    expect(price()).toBeNull();
    expect(text()).toContain(T.loading);

    await releaseAll();
    expect(currencyChoices(price())).toEqual(["USD"]);
  });

  it("a response answered for another organization is rejected as an error", async () => {
    serverOrg = ORG_B; // the session moved to B in another tab
    await mount(); // this tab still renders for A
    expect(price()).toBeNull();
    expect(text()).toContain(T.error);
    expect(text()).not.toContain(T.locked.replace("{{currency}}", "USD"));
  });

  it("submission is blocked when the server's organization changed after the form was bound", async () => {
    await mount();
    await fillName();
    await type(price(), "5000");
    serverOrg = ORG_B; // another tab switched the session
    await submit();
    expect(sent).toHaveLength(0);
    expect(text()).toContain(T.confirmFailed);
  });

  it("submission is blocked when the currency changed after the form was bound", async () => {
    await mount();
    await fillName();
    await type(price(), "5000");
    currencies[ORG_A] = "USD";
    await submit();
    expect(sent).toHaveLength(0);
    expect(text()).toContain(T.confirmFailed);
    // The fresh answer reached the form: the riel amount is gone, not re-read as dollars.
    expect(price()!.value).toBe("");
    expect(currencyChoices(price())).toEqual(["USD"]);
  });

  it("a slow confirmation that resolves after an organization switch does not submit", async () => {
    await mount();
    await fillName();
    await type(price(), "5000");
    serverMode = "hold";
    const b = button(ADD)!;
    await act(async () => b.click());
    await settle();
    expect(held).toHaveLength(1);

    // Switch while the confirmation is still out, then let A's answer arrive.
    serverMode = "answer";
    await switchOrganization(ORG_B);
    await releaseAll();
    expect(sent).toHaveLength(0);
  });
});

// ── Edits, reopen, remount ───────────────────────────────────────────────────

describe("price and cost edits, reopen and remount", () => {
  it("the last edit of each amount is what is sent; an emptied cost is sent as no cost", async () => {
    await mount();
    await fillName();
    await type(price(), "5000");
    await type(price(), "6500");
    await type(cost(), "100");
    await type(cost(), "");
    await submit();
    expect(sent[0].initialVariant).toMatchObject({
      priceAmount: 6500,
      priceCurrency: "KHR",
      costAmount: null,
      costCurrency: null,
    });
  });

  it("an invalid amount for the business currency is refused, not rounded", async () => {
    await mount();
    await fillName();
    await type(price(), "12.50"); // riel has no minor digits
    await submit();
    expect(sent).toHaveLength(0);
    expect(text()).toContain(en.catalog.variant.invalidPrice);
  });

  it("closing and reopening starts clean and re-binds to the current organization", async () => {
    await mount();
    await fillName();
    await type(price(), "5000");
    // Close the way a merchant does — Escape — so the sheet runs its own reset.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(open).toBe(false);
    await rerender();
    await switchOrganization(ORG_B);
    open = true;
    await rerender();
    expect(price()!.value).toBe("");
    expect(currencyChoices(price())).toEqual(["USD"]);
    // A fresh binding is not a "change": no cleared-amount warning.
    expect(text()).not.toContain(changedText("USD"));
  });

  it("remounting with a warm cache is ready at once and still sends the right currency", async () => {
    await mount();
    await unmount();
    const before = calls;
    await mount({ fresh: false });
    expect(currencyChoices(price())).toEqual(["KHR"]);
    await fillName();
    await type(price(), "9000");
    await submit();
    expect(sent[0].initialVariant).toMatchObject({ priceAmount: 9000, priceCurrency: "KHR" });
    // The create re-confirmed with the server rather than trusting the cache.
    expect(calls).toBeGreaterThan(before);
  });
});

// ── The server read ──────────────────────────────────────────────────────────

const { getBusinessCurrency } = await import("@/server/org/get-business-currency");

describe("getBusinessCurrency (server)", () => {
  const ctx = (organizationId: string, granted: string[]) =>
    ({
      organizationId,
      userId: USER,
      require: (key: string) => {
        if (!granted.includes(key)) throw new Error(`Missing permission: ${key}`);
      },
    }) as any;

  beforeEach(() => {
    orgRows = { [ORG_A]: "KHR", [ORG_B]: "USD" };
    orgReads.length = 0;
  });

  it("reads only the caller's own organization and echoes it", async () => {
    expect(await getBusinessCurrency(ctx(ORG_B, ["products.create"]))).toEqual({
      organizationId: ORG_B,
      currency: "USD",
    });
    expect(orgReads).toEqual([`organizations:${ORG_B}`]);
  });

  it("refuses a member without products.create before touching the table", async () => {
    await expect(getBusinessCurrency(ctx(ORG_A, ["products.read"]))).rejects.toThrow(
      "Missing permission: products.create",
    );
    expect(orgReads).toEqual([]);
  });

  it("never coerces an unsupported or missing stored value to a default", async () => {
    orgRows[ORG_A] = "EUR";
    await expect(getBusinessCurrency(ctx(ORG_A, ["products.create"]))).rejects.toThrow();
    delete orgRows[ORG_A];
    await expect(getBusinessCurrency(ctx(ORG_A, ["products.create"]))).rejects.toThrow();
  });
});

// ── Draft and save-attempt lifecycle (PR #130 final P2 #1) ───────────────────
//
// A save attempt belongs to the draft it was started for. Once that draft is
// replaced — organization tenure A → B → A, close/reopen, remount — the old
// attempt's late confirmation, success or failure must not submit the
// discarded draft, reset or close the newer one, or paint its error over it.

describe("obsolete save attempts never touch a newer draft", () => {
  it("A → B → A with a 9,000 KHR replacement: the 5,000 draft is not submitted", async () => {
    await mount();
    await fillName();
    await type(price(), "5000");
    serverMode = "hold";
    await clickSubmit();
    expect(held).toHaveLength(1); // draft A's confirmation is out

    serverMode = "answer";
    await switchOrganization(ORG_B);
    await switchOrganization(ORG_A);
    await type(price(), "9000");

    await releaseAll(); // the obsolete confirmation answers A / KHR
    expect(sent).toHaveLength(0);
    expect(price()!.value).toBe("9000");
    expect(open).toBe(true);

    await submit();
    expect(sent).toHaveLength(1);
    expect(sent[0].initialVariant).toMatchObject({ priceAmount: 9000, priceCurrency: "KHR" });
    expect(sent[0].expected).toEqual({ userId: USER, organizationId: ORG_A, currency: "KHR" });
  });

  it("delayed SUCCESS of an obsolete save leaves the replacement draft open and intact", async () => {
    await mount();
    await fillName();
    await type(price(), "5000");
    createMode = "hold";
    await clickSubmit();
    expect(heldCreates).toHaveLength(1);

    await switchOrganization(ORG_B);
    await switchOrganization(ORG_A);
    await type(price(), "9000");

    await act(async () => heldCreates.shift()!.resolve());
    await settle();
    expect(open).toBe(true);
    expect(price()!.value).toBe("9000");
    expect(nameKm()!.value).toBe("កាហ្វេ");
    expect(button(ADD)!.disabled).toBe(false);
    // The product it made is in this principal's catalog: refresh it, nothing more.
    expect(created).toBe(1);

    createMode = "answer";
    await submit();
    expect(sent).toHaveLength(2);
    expect(sent[1].initialVariant).toMatchObject({ priceAmount: 9000, priceCurrency: "KHR" });
    expect(open).toBe(false);
  });

  it("delayed FAILURE of an obsolete save shows no error over the replacement draft", async () => {
    await mount();
    await fillName();
    await type(price(), "5000");
    createMode = "hold";
    await clickSubmit();

    await switchOrganization(ORG_B);
    await switchOrganization(ORG_A);
    await type(price(), "9000");

    await act(async () => heldCreates.shift()!.reject(new Error("SKU already exists")));
    await settle();
    expect(text()).not.toContain(en.catalog.error.duplicate_sku);
    expect(price()!.value).toBe("9000");
    expect(open).toBe(true);
  });

  it("close and reopen during submission: the old result does not close or reset the new draft", async () => {
    await mount();
    await fillName();
    await type(price(), "5000");
    createMode = "hold";
    await clickSubmit();

    await closeWithEscape();
    expect(open).toBe(false);
    await rerender();
    open = true;
    await rerender();
    expect(price()!.value).toBe("");
    expect(button(ADD)!.disabled).toBe(false); // the new draft is not stuck "saving"
    await fillName();
    await type(price(), "9000");

    await act(async () => heldCreates.shift()!.resolve());
    await settle();
    expect(open).toBe(true);
    expect(price()!.value).toBe("9000");
  });

  it("remount during submission: the unmounted sheet's result does not reach the new one", async () => {
    await mount();
    await fillName();
    await type(price(), "5000");
    createMode = "hold";
    await clickSubmit();

    await unmount();
    await mount({ fresh: false });
    await fillName();
    await type(price(), "9000");

    await act(async () => heldCreates.shift()!.resolve());
    await settle();
    expect(open).toBe(true);
    expect(price()!.value).toBe("9000");
    expect(crashes).toEqual([]);
  });

  it("double click starts exactly one save", async () => {
    await mount();
    await fillName();
    await type(price(), "5000");
    serverMode = "hold";
    const b = button(ADD)!;
    await act(async () => {
      b.click();
      b.click();
    });
    await settle();
    expect(held).toHaveLength(1);
    await releaseAll();
    expect(sent).toHaveLength(1);
  });

  it("a failed save can be retried, and the retry is a single new attempt", async () => {
    await mount();
    await fillName();
    await type(price(), "5000");
    createMode = "hold";
    await clickSubmit();
    expect(button(ADD)).toBeUndefined();
    expect(button(en.catalog.saving)!.disabled).toBe(true); // loading state while out
    await act(async () => heldCreates.shift()!.reject(new Error("fetch failed")));
    await settle();
    expect(text()).toContain(en.catalog.error.generic);
    expect(price()!.value).toBe("5000");

    createMode = "answer";
    await submit();
    expect(sent).toHaveLength(2);
    expect(open).toBe(false);
  });

  it("the server refusing a changed binding is reported as nothing saved", async () => {
    await mount();
    await fillName();
    await type(price(), "5000");
    createMode = "hold";
    await clickSubmit();
    const { CREATE_BINDING_CHANGED_MESSAGE } = await import("@/lib/business-currency");
    await act(async () => heldCreates.shift()!.reject(new Error(CREATE_BINDING_CHANGED_MESSAGE)));
    await settle();
    expect(text()).toContain(T.confirmFailed);
    expect(open).toBe(true);
  });

  it("another user signing in mid-save: the draft is cleared and nothing is submitted", async () => {
    await mount();
    await fillName();
    await type(price(), "5000");
    serverMode = "hold";
    await clickSubmit();

    principal = { userId: "dddddddd-0000-4000-8000-00000000000d", organizationId: ORG_A };
    serverMode = "answer";
    await rerender();
    expect(nameKm()!.value).toBe("");
    await releaseAll();
    expect(sent).toHaveLength(0);
  });
});

// ── Edit lock while saving (PR #130 final P2) ────────────────────────────────
//
// The defect: the payload is read from the form when Save is pressed, but the
// fields stayed editable while the confirmation and the create were out. A
// price changed from 5,000 to 9,000 ៛ mid-save was never sent, and the
// original save's success then reset the form and closed the sheet — the newer
// edit silently lost. Now every field that feeds the payload is locked from
// Save until the attempt settles, and unlocked again after a failure.

/** Every control whose value is part of the create payload. */
function payloadControls(): (HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement)[] {
  const ids = [
    "product-name-km",
    "product-name-en",
    "product-description-km",
    "product-price",
    "product-cost",
    "product-sku",
    "product-barcode",
  ];
  const fields = ids.map((id) => document.getElementById(id) as HTMLInputElement | null);
  if (fields.some((f) => f === null))
    throw new Error(`missing field; page: ${text().slice(0, 300)}`);
  const chips = [
    ...price()!.parentElement!.querySelectorAll("[role=group] button"),
    ...cost()!.parentElement!.querySelectorAll("[role=group] button"),
    ...categoryChips(),
  ] as HTMLButtonElement[];
  return [...(fields as HTMLInputElement[]), ...chips];
}

/** The category chips: "none" plus one per category passed in. */
function categoryChips(): HTMLButtonElement[] {
  const labels = new Set<string>([en.catalog.detail.categoryNone]);
  for (const c of categoriesProp) {
    labels.add(c.nameKm);
    if (c.nameEn) labels.add(c.nameEn);
  }
  return [...document.querySelectorAll("button")].filter((b) =>
    labels.has(b.textContent?.trim() ?? ""),
  ) as HTMLButtonElement[];
}

const allLocked = () => payloadControls().every((c) => c.disabled);
const noneLocked = () => payloadControls().every((c) => !c.disabled);

async function typeTextarea(id: string, value: string) {
  const el = document.getElementById(id) as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

/** Every route a value can take into the draft, attempted at once. */
async function attemptEditsEverywhere() {
  await type(price(), "9000");
  await type(cost(), "7000");
  await type(nameKm(), "តែ");
  await type(document.getElementById("product-name-en") as HTMLInputElement, "Tea");
  await typeTextarea("product-description-km", "ផ្សេង");
  await type(document.getElementById("product-sku") as HTMLInputElement, "SKU-NEW");
  await type(document.getElementById("product-barcode") as HTMLInputElement, "999");
  const category = categoryChips().find(
    (b) => b.textContent?.trim() !== en.catalog.detail.categoryNone,
  );
  if (category) await act(async () => category.click());
  await settle();
}

describe("the draft is locked while it is being saved", () => {
  const CATEGORIES = [
    {
      id: "cat-1",
      organizationId: ORG_A,
      parentId: null,
      nameKm: "ភេសជ្ជៈ",
      nameEn: "Drinks",
      sortOrder: 0,
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ];

  function expectDraftUnchanged() {
    expect(price()!.value).toBe("5000");
    expect(cost()!.value).toBe("1000");
    expect(nameKm()!.value).toBe("កាហ្វេ");
    expect((document.getElementById("product-name-en") as HTMLInputElement).value).toBe("");
    expect((document.getElementById("product-sku") as HTMLInputElement).value).toBe("");
  }

  async function fillDraft() {
    await mount();
    await fillName();
    await type(price(), "5000");
    await type(cost(), "1000");
  }

  it("editing during a delayed currency confirmation: fields locked, no edit lost", async () => {
    await fillDraft();
    expect(noneLocked()).toBe(true);
    serverMode = "hold";
    await clickSubmit();
    expect(held).toHaveLength(1);
    expect(allLocked()).toBe(true);
    expect(button(en.catalog.saving)!.getAttribute("aria-busy")).toBe("true");

    await attemptEditsEverywhere();
    expectDraftUnchanged();

    await releaseAll();
    expect(sent).toHaveLength(1);
    expect(sent[0].nameKm).toBe("កាហ្វេ");
    expect(sent[0].initialVariant).toMatchObject({
      priceAmount: 5000,
      priceCurrency: "KHR",
      costAmount: 1000,
      costCurrency: "KHR",
      sku: null,
    });
    expect(open).toBe(false);
  });

  it("editing during a delayed product creation: fields locked, no edit lost", async () => {
    await fillDraft();
    createMode = "hold";
    await clickSubmit();
    expect(heldCreates).toHaveLength(1);
    expect(allLocked()).toBe(true);

    await attemptEditsEverywhere();
    expectDraftUnchanged();
    expect(sent[0].initialVariant).toMatchObject({ priceAmount: 5000, costAmount: 1000 });

    await act(async () => heldCreates.shift()!.resolve());
    await settle();
    expect(sent).toHaveLength(1);
    expect(open).toBe(false);
  });

  it("a failed save unlocks the draft with what was submitted, and edits then apply", async () => {
    await fillDraft();
    createMode = "hold";
    await clickSubmit();
    await attemptEditsEverywhere();
    await act(async () => heldCreates.shift()!.reject(new Error("fetch failed")));
    await settle();

    expect(text()).toContain(en.catalog.error.generic);
    expect(open).toBe(true);
    expect(noneLocked()).toBe(true);
    expectDraftUnchanged();
    expect(button(ADD)!.disabled).toBe(false);

    await type(price(), "9000");
    expect(price()!.value).toBe("9000");
    createMode = "answer";
    await submit();
    expect(sent).toHaveLength(2);
    expect(sent[1].initialVariant).toMatchObject({ priceAmount: 9000, priceCurrency: "KHR" });
    expect(open).toBe(false);
  });

  it("a refused confirmation unlocks the draft", async () => {
    await fillDraft();
    serverMode = "hold";
    await clickSubmit();
    currencies[ORG_A] = "USD"; // the business changed currency under the save
    await releaseAll();
    expect(sent).toHaveLength(0);
    expect(open).toBe(true);
    expect(text()).toContain(T.confirmFailed);
    expect(button(en.catalog.saving)).toBeUndefined();
  });

  it("the server refusing the principal unlocks the draft and saves nothing", async () => {
    await fillDraft();
    createMode = "hold";
    await clickSubmit();
    expect(allLocked()).toBe(true);
    const { CREATE_BINDING_CHANGED_MESSAGE } = await import("@/lib/business-currency");
    await act(async () => heldCreates.shift()!.reject(new Error(CREATE_BINDING_CHANGED_MESSAGE)));
    await settle();
    expect(text()).toContain(T.confirmFailed);
    expect(open).toBe(true);
    expect(created).toBe(0);
    expect(noneLocked()).toBe(true);
    expectDraftUnchanged();
  });

  it("success closes only the submitted draft", async () => {
    await fillDraft();
    createMode = "hold";
    await clickSubmit();
    await attemptEditsEverywhere();
    // What the merchant sees is what is being saved: no newer edit to lose.
    expectDraftUnchanged();
    await act(async () => heldCreates.shift()!.resolve());
    await settle();
    expect(created).toBe(1);
    expect(open).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0].initialVariant.priceAmount).toBe(5000);
  });

  it("organization A → B → A during saving: the new tenure is editable, the old save cannot close it", async () => {
    await fillDraft();
    createMode = "hold";
    await clickSubmit();
    expect(allLocked()).toBe(true);

    await switchOrganization(ORG_B);
    await switchOrganization(ORG_A);
    expect(noneLocked()).toBe(true); // a new draft is never stuck locked
    await type(price(), "9000");
    expect(price()!.value).toBe("9000");

    await act(async () => heldCreates.shift()!.resolve());
    await settle();
    expect(open).toBe(true);
    expect(price()!.value).toBe("9000");

    createMode = "answer";
    await submit();
    expect(sent.at(-1).initialVariant).toMatchObject({ priceAmount: 9000, priceCurrency: "KHR" });
    expect(sent.at(-1).expected).toEqual({ userId: USER, organizationId: ORG_A, currency: "KHR" });
  });

  it("close and reopen during saving: the reopened draft is editable and stays open", async () => {
    await fillDraft();
    serverMode = "hold";
    await clickSubmit();
    await closeWithEscape();
    expect(open).toBe(false);
    await rerender();
    serverMode = "answer";
    open = true;
    await rerender();
    expect(noneLocked()).toBe(true);
    await fillName();
    await type(price(), "9000");
    await releaseAll();
    expect(sent).toHaveLength(0);
    expect(open).toBe(true);
    expect(price()!.value).toBe("9000");
  });

  it("duplicate submission while locked starts no second save", async () => {
    await fillDraft();
    createMode = "hold";
    await clickSubmit();
    const saving = button(en.catalog.saving)!;
    expect(saving.disabled).toBe(true);
    await act(async () => {
      saving.click();
      saving.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(sent).toHaveLength(1);
    await act(async () => heldCreates.shift()!.resolve());
    await settle();
    expect(sent).toHaveLength(1);
    expect(created).toBe(1);
  });

  it("USD business: the locked draft is sent in cents", async () => {
    currencies[ORG_A] = "USD";
    await mount();
    await fillName();
    await type(price(), "12.50");
    await type(cost(), "3");
    createMode = "hold";
    await clickSubmit();
    await type(price(), "99.99");
    expect(price()!.value).toBe("12.50");
    await act(async () => heldCreates.shift()!.resolve());
    await settle();
    expect(sent[0].initialVariant).toMatchObject({
      priceAmount: 1250,
      priceCurrency: "USD",
      costAmount: 300,
      costCurrency: "USD",
    });
    expect(sent[0].expected).toEqual({ userId: USER, organizationId: ORG_A, currency: "USD" });
  });

  it("category choice is locked too", async () => {
    // Categories are part of the payload; mount with one to cover the chips.
    categoriesProp = CATEGORIES;
    await fillDraft();
    createMode = "hold";
    await clickSubmit();
    const chips = categoryChips();
    expect(chips.length).toBe(2);
    expect(chips.every((c) => c.disabled)).toBe(true);
    await attemptEditsEverywhere();
    await act(async () => heldCreates.shift()!.resolve());
    await settle();
    expect(sent[0].categoryId).toBeNull();
  });
});
