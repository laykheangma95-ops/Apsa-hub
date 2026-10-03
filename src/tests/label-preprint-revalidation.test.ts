/**
 * PR #110 P2 repairs — nothing prints from cache, for BOTH labels.
 *
 * P2 #1  Shipping label: the pre-print refresh must be a brand-new request.
 *        queryClient.fetchQuery returns an already in-flight (background)
 *        request's promise, so a response from before a payment / shipment
 *        change could be verified and printed. fetchAuthoritative cancels the
 *        exact label query and reads again.
 * P2 #2  Internal APSA Parcel label: revalidated against the server before
 *        printing (fresh read, permission, order lifecycle, identity guard),
 *        failing closed.
 *
 * Behavioural: a real QueryClient and the shipped guard functions.
 *
 * Run: bun test src/tests/label-preprint-revalidation.test.ts
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { PARCEL_CODE_PREFIX } from "../lib/barcode/parcel-code";
import { fulfillmentKeys } from "../lib/fulfillment-query";
import type { InternalParcelLabelInput } from "../lib/labels/internal-parcel-label";
import { runInternalPrePrint } from "../lib/labels/internal-print-guard";
import type { ParcelLabelInput } from "../lib/labels/parcel-label";
import {
  createPrintGuard,
  fetchAuthoritative,
  printIdentity,
  verifyFreshLabels,
} from "../lib/labels/shipping-print-guard";

const USER = "user-a";
const ORG = "org-a";
const ORDER = "11111111-1111-4111-8111-111111111111";
const PARCEL = `${PARCEL_CODE_PREFIX}${"A".repeat(22)}`;
const OTHER_PARCEL = `${PARCEL_CODE_PREFIX}${"B".repeat(22)}`;

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** A promise resolved by hand: a request that is still "in flight". */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ── P2 #1 — shipping label ────────────────────────────────────────────────────

function shipping(overrides: Partial<ParcelLabelInput> = {}): ParcelLabelInput {
  return {
    merchant: { businessName: "Shop", phone: null, logoUrl: null },
    customer: { name: "Dara", phone: "012345678", address: "St 1", addressConfirmed: true },
    order: { id: ORDER, orderNumber: "ORD-1", currency: "USD", itemCount: 1, items: [] },
    reprint: false,
    payment: {
      state: "cod",
      collect: { amount: 1500, currency: "USD" },
      partial: false,
      checkReason: null,
      paid: false,
    },
    delivery: {
      id: "shipment-a",
      providerName: "VET Express",
      trackingNumber: "VET-42",
      status: "pending",
      serviceName: null,
    },
    parcelCode: PARCEL,
    ...overrides,
  } as ParcelLabelInput;
}

describe("P2 #1 — shipping label pre-print refresh is a brand-new authoritative fetch", () => {
  const key = fulfillmentKeys.parcelLabels(USER, ORG, [ORDER]);

  /**
   * The dialog's pre-print sequence (ParcelLabelDialog.handleBeforePrint),
   * minus the capability re-authorization: fresh read → identity guard →
   * verification.
   */
  async function prePrint(
    queryClient: QueryClient,
    displayed: ParcelLabelInput[],
    read: () => Promise<ParcelLabelInput[]>,
    live: () => boolean,
  ): Promise<"print" | "retired" | "changed" | "invalid" | "refreshFailed"> {
    let fresh: ParcelLabelInput[];
    try {
      fresh = await fetchAuthoritative(queryClient, key, read);
    } catch {
      return "refreshFailed";
    }
    if (!live()) return "retired";
    queryClient.setQueryData(key, fresh);
    const verdict = verifyFreshLabels(displayed, fresh);
    return verdict.kind === "ok" ? "print" : verdict.kind;
  }

  it("the defect: fetchQuery reuses a delayed in-flight request", async () => {
    const queryClient = client();
    const background = deferred<ParcelLabelInput[]>();
    let calls = 0;
    void queryClient
      .fetchQuery({ queryKey: key, queryFn: () => (calls++, background.promise) })
      .catch(() => undefined);
    await tick();
    const reused = queryClient.fetchQuery({
      queryKey: key,
      queryFn: () => (calls++, Promise.resolve([shipping()])),
      staleTime: 0,
    });
    background.resolve([shipping({ parcelCode: OTHER_PARCEL })]);
    // The "fresh" fetch never ran: it received the earlier request's answer.
    expect((await reused)[0]!.parcelCode).toBe(OTHER_PARCEL);
    expect(calls).toBe(1);
  });

  it("delayed background request: never reused, and its late response is discarded", async () => {
    const queryClient = client();
    const displayed = [shipping()];
    queryClient.setQueryData(key, displayed);

    // A background refetch started BEFORE the payment changed, still in flight.
    const background = deferred<ParcelLabelInput[]>();
    let backgroundCalls = 0;
    void queryClient
      .fetchQuery({
        queryKey: key,
        queryFn: () => (backgroundCalls++, background.promise),
        staleTime: 0,
      })
      .catch(() => undefined);
    await tick();
    expect(queryClient.getQueryState(key)?.fetchStatus).toBe("fetching");

    // The server now says PAID. The pre-print read must see that.
    const paid = shipping({
      payment: { state: "paid", collect: null, partial: false, checkReason: null, paid: true },
    } as Partial<ParcelLabelInput>);
    let freshCalls = 0;
    const live = createPrintGuard();
    live.setContext(printIdentity(USER, ORG, [ORDER]), true);
    const result = await prePrint(
      queryClient,
      displayed,
      () => (freshCalls++, Promise.resolve([paid])),
      live.begin(),
    );

    expect(backgroundCalls).toBe(1);
    expect(freshCalls).toBe(1); // a brand-new request was made
    expect(result).toBe("changed"); // the COD label is NOT printed

    // The old request finally answers with the stale COD label: discarded.
    background.resolve([shipping()]);
    await tick();
    expect(queryClient.getQueryData<ParcelLabelInput[]>(key)![0]!.payment.state).toBe("paid");
  });

  it("payment change (COD → paid, and a COD amount change) → not printed", async () => {
    for (const payment of [
      { state: "paid", collect: null, partial: false, checkReason: null, paid: true },
      {
        state: "cod",
        collect: { amount: 1999, currency: "USD" },
        partial: false,
        checkReason: null,
        paid: false,
      },
    ]) {
      const queryClient = client();
      const displayed = [shipping()];
      queryClient.setQueryData(key, displayed);
      const guard = createPrintGuard();
      guard.setContext(printIdentity(USER, ORG, [ORDER]), true);
      const fresh = [shipping({ payment } as Partial<ParcelLabelInput>)];
      expect(
        await prePrint(queryClient, displayed, () => Promise.resolve(fresh), guard.begin()),
      ).toBe("changed");
    }
  });

  it("shipment replacement (new shipment id, even same carrier + tracking) → not printed", async () => {
    const queryClient = client();
    const displayed = [shipping()];
    queryClient.setQueryData(key, displayed);
    const guard = createPrintGuard();
    guard.setContext(printIdentity(USER, ORG, [ORDER]), true);
    const replaced = [shipping({ delivery: { ...displayed[0]!.delivery!, id: "shipment-b" } })];
    expect(
      await prePrint(queryClient, displayed, () => Promise.resolve(replaced), guard.begin()),
    ).toBe("changed");
  });

  it("tracking barcode and parcel identity are validated on the fresh data", async () => {
    const guard = createPrintGuard();
    guard.setContext(printIdentity(USER, ORG, [ORDER]), true);

    const noTracking = [shipping({ delivery: { ...shipping().delivery!, trackingNumber: null } })];
    expect(
      await prePrint(client(), noTracking, () => Promise.resolve(noTracking), guard.begin()),
    ).toBe("invalid");

    const noParcel = [shipping({ parcelCode: null })];
    expect(await prePrint(client(), noParcel, () => Promise.resolve(noParcel), guard.begin())).toBe(
      "invalid",
    );

    const otherParcel = [shipping({ parcelCode: OTHER_PARCEL })];
    expect(
      await prePrint(client(), [shipping()], () => Promise.resolve(otherParcel), guard.begin()),
    ).toBe("changed");
  });

  it("identity switch during the fresh read → retired, and nothing is written to the cache", async () => {
    for (const next of [
      printIdentity("user-b", ORG, [ORDER]),
      printIdentity(USER, "org-b", [ORDER]),
      printIdentity(USER, ORG, ["another-order"]),
    ]) {
      const queryClient = client();
      const displayed = [shipping()];
      queryClient.setQueryData(key, displayed);
      const guard = createPrintGuard();
      guard.setContext(printIdentity(USER, ORG, [ORDER]), true);
      const pending = deferred<ParcelLabelInput[]>();
      const attempt = prePrint(queryClient, displayed, () => pending.promise, guard.begin());
      await tick();
      guard.setContext(next, true);
      pending.resolve([shipping({ parcelCode: OTHER_PARCEL })]);
      expect(await attempt).toBe("retired");
      expect(queryClient.getQueryData<ParcelLabelInput[]>(key)![0]!.parcelCode).toBe(PARCEL);
    }
  });

  it("a failed fresh read fails closed", async () => {
    const queryClient = client();
    const displayed = [shipping()];
    queryClient.setQueryData(key, displayed);
    const guard = createPrintGuard();
    guard.setContext(printIdentity(USER, ORG, [ORDER]), true);
    expect(
      await prePrint(
        queryClient,
        displayed,
        () => Promise.reject(new Error("offline")),
        guard.begin(),
      ),
    ).toBe("refreshFailed");
  });

  it("the dialog uses the brand-new fetch, re-runs the identity guard, then verifies", () => {
    const dialog = fs.readFileSync(
      path.resolve(import.meta.dir, "../components/labels/ParcelLabelDialog.tsx"),
      "utf8",
    );
    const hook = dialog.slice(dialog.indexOf("async function handleBeforePrint"));
    expect(hook).not.toContain("fetchQuery");
    const fetchAt = hook.indexOf("await fetchAuthoritative(queryClient, labelsKey, fetchLabels)");
    const guardAt = hook.indexOf("if (!live()) return null;");
    const verifyAt = hook.indexOf("verifyFreshLabels(displayed, fresh)");
    expect(fetchAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(fetchAt);
    expect(verifyAt).toBeGreaterThan(guardAt);
  });
});

// ── P2 #2 — internal APSA Parcel label ────────────────────────────────────────

function internal(overrides: Partial<InternalParcelLabelInput> = {}): InternalParcelLabelInput {
  return {
    merchant: { businessName: "Shop" },
    order: { id: ORDER, orderNumber: "ORD-1", itemCount: 2 },
    parcelCode: PARCEL,
    ...overrides,
  };
}

describe("P2 #2 — internal parcel label is revalidated before printing", () => {
  const key = fulfillmentKeys.internalLabels(USER, ORG, [ORDER]);

  function setup() {
    const queryClient = client();
    const displayed = [internal()];
    queryClient.setQueryData(key, displayed);
    const guard = createPrintGuard();
    guard.setContext(printIdentity(USER, ORG, [ORDER]), true);
    return { queryClient, displayed, guard };
  }

  it("fresh, unchanged, authorized and live → prints, from a new server read", async () => {
    const { queryClient, displayed, guard } = setup();
    let reads = 0;
    let reauthorized = 0;
    let verified: InternalParcelLabelInput[] | null = null;
    const result = await runInternalPrePrint({
      displayed,
      queryClient,
      queryKey: key,
      read: () => (reads++, Promise.resolve([internal()])),
      live: guard.begin(),
      reauthorize: () => (reauthorized++, Promise.resolve(true)),
      onVerified: (fresh) => {
        verified = fresh;
      },
    });
    expect(result).toBe("ok");
    expect(reads).toBe(1);
    expect(reauthorized).toBe(1);
    expect(verified).toEqual([internal()]);
  });

  it("never reuses an in-flight background request", async () => {
    const { queryClient, displayed, guard } = setup();
    const background = deferred<InternalParcelLabelInput[]>();
    void queryClient
      .fetchQuery({ queryKey: key, queryFn: () => background.promise, staleTime: 0 })
      .catch(() => undefined);
    await tick();
    let reads = 0;
    const result = await runInternalPrePrint({
      displayed,
      queryClient,
      queryKey: key,
      read: () => (reads++, Promise.reject(new Error("order cancelled"))),
      live: guard.begin(),
      reauthorize: () => Promise.resolve(true),
    });
    expect(reads).toBe(1);
    expect(result).toBe("refreshFailed");
    background.resolve([internal()]);
  });

  it("permission revoked: the server refuses the read → denied, not printed", async () => {
    const { queryClient, displayed, guard } = setup();
    const result = await runInternalPrePrint({
      displayed,
      queryClient,
      queryKey: key,
      read: () => Promise.reject(new Error("Forbidden")),
      live: guard.begin(),
      reauthorize: () => Promise.resolve(false),
    });
    expect(result).toBe("denied");
  });

  it("permission revoked between the read and the print → denied, not printed", async () => {
    const { queryClient, displayed, guard } = setup();
    let verifiedOnDenial = false;
    const result = await runInternalPrePrint({
      displayed,
      queryClient,
      queryKey: key,
      read: () => Promise.resolve([internal()]),
      live: guard.begin(),
      reauthorize: () => Promise.resolve(false),
      onVerified: () => {
        verifiedOnDenial = true;
      },
    });
    expect(result).toBe("denied");
    expect(verifiedOnDenial).toBe(false);
    // A re-authorization that itself throws is a denial too.
    const again = await runInternalPrePrint({
      displayed,
      queryClient,
      queryKey: key,
      read: () => Promise.resolve([internal()]),
      live: guard.begin(),
      reauthorize: () => Promise.reject(new Error("network")),
    });
    expect(again).toBe("denied");
  });

  it("order cancelled: the server's lifecycle check refuses the fresh read → not printed", async () => {
    const { queryClient, displayed, guard } = setup();
    const result = await runInternalPrePrint({
      displayed,
      queryClient,
      queryKey: key,
      // getInternalParcelLabelData answers 409 for a cancelled order.
      read: () =>
        Promise.reject(new Error("An APSA parcel label is only available for a confirmed order")),
      live: guard.begin(),
      reauthorize: () => Promise.resolve(true),
    });
    expect(result).toBe("refreshFailed");
  });

  it("the server enforces permission and lifecycle on every internal-label read", () => {
    const service = fs.readFileSync(
      path.resolve(import.meta.dir, "../server/fulfillment/service.ts"),
      "utf8",
    );
    const read = service.slice(service.indexOf("export async function getInternalParcelLabelData"));
    expect(read).toContain('ctx.require("orders.read");');
    expect(read).toContain('ctx.require("fulfillment.print_label");');
    expect(read).toContain(
      'order.lifecycle_status !== "confirmed" && order.lifecycle_status !== "completed"',
    );
  });

  it("refresh failure → refreshFailed, not printed", async () => {
    const { queryClient, displayed, guard } = setup();
    const result = await runInternalPrePrint({
      displayed,
      queryClient,
      queryKey: key,
      read: () => Promise.reject(new Error("offline")),
      live: guard.begin(),
      reauthorize: () => Promise.resolve(true),
    });
    expect(result).toBe("refreshFailed");
  });

  it("identity switch (user, organization, order, close, unmount) → retired at every await", async () => {
    const switches: Array<(g: ReturnType<typeof createPrintGuard>) => void> = [
      (g) => g.setContext(printIdentity("user-b", ORG, [ORDER]), true),
      (g) => g.setContext(printIdentity(USER, "org-b", [ORDER]), true),
      (g) => g.setContext(printIdentity(USER, ORG, ["another-order"]), true),
      (g) => g.setContext(printIdentity(USER, ORG, [ORDER]), false),
      (g) => g.retire(),
    ];
    for (const change of switches) {
      // During the fresh read.
      {
        const { queryClient, displayed, guard } = setup();
        const pending = deferred<InternalParcelLabelInput[]>();
        const attempt = runInternalPrePrint({
          displayed,
          queryClient,
          queryKey: key,
          read: () => pending.promise,
          live: guard.begin(),
          reauthorize: () => Promise.resolve(true),
        });
        await tick();
        change(guard);
        pending.resolve([internal({ parcelCode: OTHER_PARCEL })]);
        expect(await attempt).toBe("retired");
        // The other principal's / order's data never reaches this cache entry.
        expect(queryClient.getQueryData<InternalParcelLabelInput[]>(key)![0]!.parcelCode).toBe(
          PARCEL,
        );
      }
      // During the re-authorization.
      {
        const { queryClient, displayed, guard } = setup();
        const auth = deferred<boolean>();
        const attempt = runInternalPrePrint({
          displayed,
          queryClient,
          queryKey: key,
          read: () => Promise.resolve([internal()]),
          live: guard.begin(),
          reauthorize: () => auth.promise,
        });
        await tick();
        await tick();
        change(guard);
        auth.resolve(true);
        expect(await attempt).toBe("retired");
      }
      // During a failed read's re-authorization.
      {
        const { queryClient, displayed, guard } = setup();
        const auth = deferred<boolean>();
        const attempt = runInternalPrePrint({
          displayed,
          queryClient,
          queryKey: key,
          read: () => Promise.reject(new Error("offline")),
          live: guard.begin(),
          reauthorize: () => auth.promise,
        });
        await tick();
        await tick();
        change(guard);
        auth.resolve(true);
        expect(await attempt).toBe("retired");
      }
    }
  });

  it("a different parcel or order from the server → changed, shown for review, not printed", async () => {
    const { queryClient, displayed, guard } = setup();
    let reauthorized = 0;
    const result = await runInternalPrePrint({
      displayed,
      queryClient,
      queryKey: key,
      read: () => Promise.resolve([internal({ parcelCode: OTHER_PARCEL })]),
      live: guard.begin(),
      reauthorize: () => (reauthorized++, Promise.resolve(true)),
    });
    expect(result).toBe("changed");
    expect(reauthorized).toBe(0);
    expect(queryClient.getQueryData<InternalParcelLabelInput[]>(key)![0]!.parcelCode).toBe(
      OTHER_PARCEL,
    );
  });

  it("a label without a valid parcel code never prints and never reaches the server", async () => {
    const { queryClient, guard } = setup();
    let reads = 0;
    for (const displayed of [
      [],
      [internal({ parcelCode: null })],
      [internal({ parcelCode: "X" })],
    ]) {
      expect(
        await runInternalPrePrint({
          displayed,
          queryClient,
          queryKey: key,
          read: () => (reads++, Promise.resolve([internal()])),
          live: guard.begin(),
          reauthorize: () => Promise.resolve(true),
        }),
      ).toBe("invalid");
    }
    expect(reads).toBe(0);
  });

  it("the dialog gates printing on the pre-print check and fails closed", () => {
    const dialog = fs.readFileSync(
      path.resolve(import.meta.dir, "../components/labels/InternalParcelLabelDialog.tsx"),
      "utf8",
    );
    expect(dialog).toContain("onBeforePrint={handleBeforePrint}");
    expect(dialog).toContain("await runInternalPrePrint({");
    expect(dialog).toContain(
      "printGuard.setContext(printIdentity(userId, organizationId, orderIds), open)",
    );
    expect(dialog).toContain('"fulfillment.print_label"');
    expect(dialog).toContain("queryClient.removeQueries({ queryKey: labelsKey, exact: true });");
    // Exactly one path yields pages to print — the verified fresh labels; every
    // other path returns null (refuse).
    const hook = dialog.slice(dialog.indexOf("async function handleBeforePrint"));
    const body = hook.slice(0, hook.indexOf("\n  }\n"));
    expect(body).toContain('if (result === "ok") {');
    expect(body).toContain("verified = fresh;");
    expect((body.match(/return null;/g) ?? []).length).toBe(3);
    expect(body).not.toMatch(/return (true|false);/);
  });

  it("the new notices exist in Khmer and English", () => {
    for (const lang of ["en", "km"]) {
      const j = JSON.parse(
        fs.readFileSync(path.resolve(import.meta.dir, `../locales/${lang}.json`), "utf8"),
      );
      for (const k of ["changed", "refreshFailed"]) {
        expect(typeof j.labels.internal.printNotice[k]).toBe("string");
      }
    }
  });
});
