/**
 * The Customer directory pages by offset, so its ORDER BY must be total.
 * With `created_at DESC` alone, customers sharing a timestamp come back in
 * whatever order the database picks per query, and an offset boundary can
 * repeat one customer and skip another.
 *
 * The fake below shuffles rows differently on every query before applying the
 * requested ORDER BY, exactly like a planner free to return ties in any order.
 *
 * Isolated runtime file (spawned by customer-directory-ordering.test.ts):
 * other test files replace "@/server/customers/repository" with mock.module,
 * which mutates the shared module cache for the whole process. Running here,
 * in a child process, guarantees these checks exercise the real repository.
 *
 * Run: bun test src/tests/customer-directory-ordering.runtime.ts
 */
import { describe, expect, it } from "bun:test";
import {
  listCustomers,
  scanCustomersWithPhone,
  searchCustomersByName,
  setCustomerRepositoryDbForTests,
} from "../server/customers/repository";

const ORG = "org-1";
const SAME_INSTANT = "2026-05-01T08:00:00.000Z";

interface Row {
  id: string;
  organization_id: string;
  created_at: string;
  status: string;
  display_name: string;
  primary_phone: string | null;
}

const ROWS: Row[] = Array.from({ length: 12 }, (_, i) => ({
  id: `cus-${String(i).padStart(2, "0")}`,
  organization_id: ORG,
  // Ten share one instant (a bulk import); two are older.
  created_at: i < 10 ? SAME_INSTANT : `2026-04-0${i - 9}T00:00:00.000Z`,
  status: "active",
  // Every customer shares one name, so a name search is all ties.
  display_name: "Sokha",
  primary_phone: `0120000${String(i).padStart(2, "0")}`,
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
            const av = a[col] ?? "";
            const bv = b[col] ?? "";
            if (av === bv) continue;
            return (av < bv ? -1 : 1) * (asc ? 1 : -1);
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
        ilike: (col: keyof Row, pattern: string) => {
          const needle = pattern.replace(/%/g, "").toLowerCase();
          filters.push((r) =>
            String(r[col] ?? "")
              .toLowerCase()
              .includes(needle),
          );
          return builder;
        },
        not: (col: keyof Row, op: string, value: unknown) => {
          if (op !== "is" || value !== null) throw new Error(`fake: unsupported not(${op})`);
          filters.push((r) => r[col] !== null);
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

async function withFakeDb<T>(
  fn: (recorded: Array<Array<[string, boolean]>>) => Promise<T>,
): Promise<T> {
  const recorded: Array<Array<[string, boolean]>> = [];
  const restore = setCustomerRepositoryDbForTests(fakeDb(recorded));
  try {
    return await fn(recorded);
  } finally {
    restore();
  }
}

/** Walks every page by offset; each page is its own query with its own tie order. */
async function walk(page: (offset: number) => Promise<Array<{ id: string }>>): Promise<string[]> {
  const seen: string[] = [];
  for (let offset = 0; offset < ROWS.length; offset += 5) {
    seen.push(...(await page(offset)).map((r) => r.id));
  }
  return seen;
}

const ALL_IDS = ROWS.map((r) => r.id);
const TIED_IDS_DESC = ROWS.slice(0, 10)
  .map((r) => r.id)
  .sort()
  .reverse();

describe("customer directory ordering is total and page-stable", () => {
  it("orders by created_at DESC, then id DESC", async () => {
    const recorded = await withFakeDb(async (recorded) => {
      await listCustomers(ORG, { limit: 5, offset: 0 });
      return recorded;
    });
    expect(recorded[0]).toEqual([
      ["created_at", false],
      ["id", false],
    ]);
  });

  it("walking every page by offset returns each customer exactly once, in id order within ties", async () => {
    const seen = await withFakeDb(() => walk((offset) => listCustomers(ORG, { limit: 5, offset })));
    expect(seen).toHaveLength(ROWS.length);
    expect(new Set(seen).size).toBe(ROWS.length);
    expect(seen.slice(0, 10)).toEqual(TIED_IDS_DESC);
  });
});

describe("customer name search ordering is total and page-stable", () => {
  it("orders by display_name, then id", async () => {
    const recorded = await withFakeDb(async (recorded) => {
      await searchCustomersByName(ORG, { pattern: "%Sokha%", limit: 5, offset: 0 });
      return recorded;
    });
    expect(recorded[0]).toEqual([
      ["display_name", true],
      ["id", true],
    ]);
  });

  it("walking every page of an all-ties name search returns each customer exactly once, in id order", async () => {
    const seen = await withFakeDb(() =>
      walk((offset) => searchCustomersByName(ORG, { pattern: "%Sokha%", limit: 5, offset })),
    );
    expect(seen).toHaveLength(ROWS.length);
    expect(new Set(seen).size).toBe(ROWS.length);
    expect(seen).toEqual([...ALL_IDS].sort());
  });
});

describe("customer phone scan ordering is total and page-stable", () => {
  it("orders by created_at DESC, then id DESC", async () => {
    const recorded = await withFakeDb(async (recorded) => {
      await scanCustomersWithPhone(ORG, { limit: 5, offset: 0 });
      return recorded;
    });
    expect(recorded[0]).toEqual([
      ["created_at", false],
      ["id", false],
    ]);
  });

  it("walking every page of the phone scan returns each customer exactly once, in id order within ties", async () => {
    const seen = await withFakeDb(() =>
      walk((offset) => scanCustomersWithPhone(ORG, { limit: 5, offset })),
    );
    expect(seen).toHaveLength(ROWS.length);
    expect(new Set(seen).size).toBe(ROWS.length);
    expect(seen.slice(0, 10)).toEqual(TIED_IDS_DESC);
  });
});
