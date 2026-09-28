/**
 * The Customer directory pages by offset, so its ORDER BY must be total.
 * With `created_at DESC` alone, customers sharing a timestamp come back in
 * whatever order the database picks per query, and an offset boundary can
 * repeat one customer and skip another.
 *
 * The fake below shuffles rows differently on every query before applying the
 * requested ORDER BY, exactly like a planner free to return ties in any order.
 */
import { describe, expect, it } from "bun:test";

const ORG = "org-1";
const SAME_INSTANT = "2026-05-01T08:00:00.000Z";

interface Row {
  id: string;
  organization_id: string;
  created_at: string;
  status: string;
}

const ROWS: Row[] = Array.from({ length: 12 }, (_, i) => ({
  id: `cus-${String(i).padStart(2, "0")}`,
  organization_id: ORG,
  // Ten share one instant (a bulk import); two are older.
  created_at: i < 10 ? SAME_INSTANT : `2026-04-0${i - 9}T00:00:00.000Z`,
  status: "active",
}));

let queryNo = 0;

function fakeDb(recordedOrders: Array<Array<[string, boolean]>>) {
  return {
    from: () => {
      const orders: Array<[keyof Row, boolean]> = [];
      recordedOrders.push(orders as Array<[string, boolean]>);
      const filters: Array<(r: Row) => boolean> = [];
      let window: [number, number] | null = null;
      let limit: number | null = null;
      const seed = ++queryNo;
      const run = () => {
        // A different arbitrary tie order per query.
        let rows = ROWS.filter((r) => filters.every((f) => f(r)))
          .map((r, i) => ({ r, k: (i * 7919 + seed * 104729) % 97 }))
          .sort((a, b) => a.k - b.k)
          .map(({ r }) => r);
        rows = [...rows].sort((a, b) => {
          for (const [col, asc] of orders) {
            if (a[col] === b[col]) continue;
            return (a[col] < b[col] ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        });
        if (window) rows = rows.slice(window[0], window[1] + 1);
        else if (limit !== null) rows = rows.slice(0, limit);
        return { data: rows, error: null };
      };
      const builder = {
        select: () => builder,
        eq: (col: keyof Row, value: string) => {
          filters.push((r) => r[col] === value);
          return builder;
        },
        order: (col: keyof Row, opts?: { ascending?: boolean }) => {
          orders.push([col, opts?.ascending ?? true]);
          return builder;
        },
        limit: (n: number) => {
          limit = n;
          return builder;
        },
        range: (from: number, to: number) => {
          window = [from, to];
          return builder;
        },
        then: (resolve: (v: ReturnType<typeof run>) => unknown) =>
          Promise.resolve(run()).then(resolve),
      };
      return builder;
    },
  };
}

describe("customer directory ordering is total and page-stable", () => {
  it("orders by created_at DESC, then id DESC", async () => {
    const { listCustomers, setCustomerRepositoryDbForTests } =
      await import("../server/customers/repository");
    const recorded: Array<Array<[string, boolean]>> = [];
    const restore = setCustomerRepositoryDbForTests(fakeDb(recorded));
    try {
      await listCustomers(ORG, { limit: 5, offset: 0 });
    } finally {
      restore();
    }
    expect(recorded[0]).toEqual([
      ["created_at", false],
      ["id", false],
    ]);
  });

  it("walking every page by offset returns each customer exactly once, in id order within ties", async () => {
    const { listCustomers, setCustomerRepositoryDbForTests } =
      await import("../server/customers/repository");
    const restore = setCustomerRepositoryDbForTests(fakeDb([]));
    const seen: string[] = [];
    try {
      for (let offset = 0; offset < ROWS.length; offset += 5) {
        // Each page is its own query, with its own arbitrary tie order.
        const page = await listCustomers(ORG, { limit: 5, offset });
        seen.push(...page.map((r) => r.id));
      }
    } finally {
      restore();
    }
    expect(seen).toHaveLength(ROWS.length);
    expect(new Set(seen).size).toBe(ROWS.length);
    expect(seen.slice(0, 10)).toEqual(
      ROWS.slice(0, 10)
        .map((r) => r.id)
        .sort()
        .reverse(),
    );
  });
});
