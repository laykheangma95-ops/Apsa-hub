/**
 * A Supabase admin client stand-in over PGlite, for repository code that uses
 * the PostgREST builder: eq / neq / lt / gt / gte / in / or(eq…) / order /
 * limit / range / single, PostgREST's exact count (also head-only), `.rpc()`,
 * and ONE embedded resource — `deliveries!inner(id)` from `orders`, filtered
 * through `deliveries.<column>` — as an EXISTS over the order's deliveries,
 * which is what PostgREST's inner embed does to the parent rows (each parent
 * once, however many children match).
 *
 * Rows come back through json_agg, as PostgREST renders them, so timestamps
 * keep their microseconds. Anything else throws: a query this cannot express
 * fails the test instead of silently answering something else.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PGlite } from "@electric-sql/pglite";

const EMBED = "deliveries!inner(id)";

export function postgrestOverPglite(db: PGlite) {
  const identifier = (value: string) => {
    if (!/^[a-z_0-9]+$/.test(value)) throw new Error(`Invalid test identifier: ${value}`);
    return value;
  };

  function select(table: string) {
    const where: string[] = [];
    const embedWhere: string[] = [];
    const values: unknown[] = [];
    const ordering: string[] = [];
    let columns = "*";
    let embed = false;
    let single: "single" | "maybe" | null = null;
    let max: number | undefined;
    let skip: number | undefined;
    let counted = false;
    let headOnly = false;

    const target = (key: string) => {
      if (key.startsWith("deliveries.")) {
        if (!embed) throw new Error(`Filter on ${key} without the deliveries embed`);
        return { list: embedWhere, column: `d.${identifier(key.slice("deliveries.".length))}` };
      }
      return { list: where, column: identifier(key) };
    };
    const compare = (op: string) => (key: string, value: unknown) => {
      const { list, column } = target(key);
      values.push(value);
      list.push(`${column} ${op} $${values.length}`);
      return chain;
    };

    const chain: any = {
      select(cols = "*", options: { count?: "exact"; head?: boolean } = {}) {
        let plain = cols.trim();
        if (plain.endsWith(EMBED)) {
          if (table !== "orders") throw new Error(`Unsupported embed on ${table}`);
          embed = true;
          plain = plain.slice(0, -EMBED.length).replace(/,\s*$/, "").trim() || "*";
        }
        if (plain !== "*" && !/^[a-z_0-9, ]+$/.test(plain)) {
          throw new Error(`Unsupported test select: ${cols}`);
        }
        columns = plain;
        counted = options.count === "exact";
        headOnly = options.head === true;
        return chain;
      },
      eq: compare("="),
      neq: compare("<>"),
      lt: compare("<"),
      gt: compare(">"),
      gte: compare(">="),
      or(expression: string) {
        const terms = expression.split(",").map((term) => {
          const match = /^([a-z_]+)\.eq\.([a-z_]+)$/.exec(term);
          if (!match) throw new Error(`Unsupported test or(): ${expression}`);
          values.push(match[2]);
          return `${identifier(match[1]!)} = $${values.length}`;
        });
        where.push(`(${terms.join(" or ")})`);
        return chain;
      },
      in(key: string, list: unknown[]) {
        const { list: into, column } = target(key);
        const params = list.map((value) => {
          values.push(value);
          return `$${values.length}`;
        });
        into.push(list.length ? `${column} in (${params.join(",")})` : "false");
        return chain;
      },
      order(key: string, options: { ascending: boolean }) {
        ordering.push(`${identifier(key)} ${options.ascending ? "asc" : "desc"}`);
        return chain;
      },
      limit(n: number) {
        max = n;
        return chain;
      },
      range(from: number, to: number) {
        skip = from;
        max = to - from + 1;
        return chain;
      },
      single() {
        single = "single";
        return chain;
      },
      maybeSingle() {
        single = "maybe";
        return chain;
      },
      async execute() {
        const clauses = [...where];
        if (embed) {
          clauses.push(
            `exists (select 1 from deliveries d where d.order_id = ${table}.id${
              embedWhere.length ? ` and ${embedWhere.join(" and ")}` : ""
            })`,
          );
        }
        const filtered = clauses.length ? ` where ${clauses.join(" and ")}` : "";
        let count: number | null = null;
        if (counted) {
          try {
            const total = await db.query<{ n: number }>(
              `select count(*)::int as n from ${table}${filtered}`,
              values,
            );
            count = total.rows[0]!.n;
          } catch (error) {
            return { data: null, count: null, error };
          }
          if (headOnly) return { data: null, count, error: null };
        }
        let inner = `select ${columns} from ${table}${filtered}`;
        if (ordering.length) inner += ` order by ${ordering.join(",")}`;
        if (max !== undefined) inner += ` limit ${max}`;
        if (skip !== undefined) inner += ` offset ${skip}`;
        try {
          const result = await db.query<{ rows: unknown[] }>(
            `select coalesce(json_agg(t), '[]'::json) as rows from (${inner}) t`,
            values,
          );
          const rows = result.rows[0]!.rows as unknown[];
          if (single) {
            if (rows.length) return { data: rows[0], error: null };
            return single === "maybe"
              ? { data: null, error: null }
              : { data: null, error: { code: "PGRST116", message: "no rows" } };
          }
          return { data: rows, count, error: null };
        } catch (error) {
          return { data: null, error };
        }
      },
      then(ok: (value: unknown) => unknown, fail?: (reason: unknown) => unknown) {
        return chain.execute().then(ok, fail);
      },
    };
    return chain;
  }

  /** Every call the transport answered, by table or function name. */
  const reads: string[] = [];

  return {
    reads,
    from(table: string) {
      reads.push(table);
      return select(identifier(table));
    },
    async rpc(name: string, args: Record<string, unknown>) {
      reads.push(`rpc:${name}`);
      const keys = Object.keys(args);
      const params = keys.map((key, i) => `${identifier(key)} => $${i + 1}`).join(", ");
      try {
        const result = await db.query<{ result: unknown }>(
          `select public.${identifier(name)}(${params}) as result`,
          keys.map((key) => args[key]),
        );
        return { data: result.rows[0]!.result, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
}
