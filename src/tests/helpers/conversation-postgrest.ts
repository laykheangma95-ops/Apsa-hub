import type { PGlite } from "@electric-sql/pglite";

/** Local SQL-backed transport substitute: production repository and service run
 * unchanged. This covers query construction, not the HTTP PostgREST server. */
export function conversationPostgrest(db: PGlite) {
  const requests: string[] = [];
  const identifier = (value: string) => {
    if (!/^[a-z_]+$/.test(value)) throw new Error(`Invalid test identifier: ${value}`);
    return value;
  };
  function query(source: string, initial: unknown[] = [], rpcName?: string) {
    const values = [...initial];
    const where: string[] = [];
    const ordering: string[] = [];
    let selection = "*",
      max: number | undefined,
      single = false,
      nullable = false;
    let updates: Record<string, unknown> | undefined;
    const bind = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    const chain = {
      select(columns = "*") {
        selection = columns;
        return chain;
      },
      eq(key: string, value: unknown) {
        where.push(`${identifier(key)} = ${bind(value)}`);
        return chain;
      },
      gt(key: string, value: unknown) {
        where.push(`${identifier(key)} > ${bind(value)}`);
        return chain;
      },
      is(key: string, value: unknown) {
        if (value !== null) throw new Error("Unsupported test filter");
        where.push(`${identifier(key)} is null`);
        return chain;
      },
      in(key: string, items: unknown[]) {
        where.push(`${identifier(key)} in (${items.map(bind).join(",")})`);
        return chain;
      },
      ilike(key: string, value: unknown) {
        where.push(`${identifier(key)} ilike ${bind(value)}`);
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
      single() {
        single = true;
        return chain;
      },
      maybeSingle() {
        single = true;
        nullable = true;
        return chain;
      },
      update(input: Record<string, unknown>) {
        updates = input;
        return chain;
      },
      or(filter: string) {
        // Conversation-list keyset pagination ties break on `id` (a UUID);
        // message keyset pagination ties break on `sequence` (a bigint) —
        // see repository.ts's listMessagesBefore for why. Two distinct,
        // narrow patterns, so an unrecognized filter still fails loudly
        // rather than being silently misinterpreted.
        const conversationMatch =
          /^last_message_at\.lt\.([^,]+),and\(last_message_at\.eq\.([^,]+),id\.lt\.([^)]+)\)$/.exec(
            filter,
          );
        if (conversationMatch) {
          if (conversationMatch[1] !== conversationMatch[2])
            throw new Error(`Unexpected repository filter ${filter}`);
          where.push(
            `(last_message_at,id) < (${bind(conversationMatch[1])}::timestamptz,${bind(conversationMatch[3])}::uuid)`,
          );
          return chain;
        }
        const messageMatch =
          /^occurred_at\.lt\.([^,]+),and\(occurred_at\.eq\.([^,]+),sequence\.lt\.([^)]+)\)$/.exec(
            filter,
          );
        if (messageMatch) {
          if (messageMatch[1] !== messageMatch[2])
            throw new Error(`Unexpected repository filter ${filter}`);
          where.push(
            `(occurred_at,sequence) < (${bind(messageMatch[1])}::timestamptz,${bind(messageMatch[3])}::bigint)`,
          );
          return chain;
        }
        throw new Error(`Unexpected repository filter ${filter}`);
      },
      async execute() {
        try {
          const assignments = updates
            ? Object.entries(updates)
                .map(([key, value]) => `${identifier(key)}=${bind(value)}`)
                .join(",")
            : "";
          let sql = updates
            ? `update ${source} set ${assignments}`
            : `select ${selection} from ${source}`;
          if (where.length) sql += ` where ${where.join(" and ")}`;
          if (ordering.length) sql += ` order by ${ordering.join(",")}`;
          if (max !== undefined) sql += ` limit ${max}`;
          if (updates) sql += ` returning ${selection}`;
          requests.push(sql);
          const result = await db.query(sql, values);
          const rows = JSON.parse(JSON.stringify(result.rows));
          if (single) {
            if (!rows.length && !nullable) return { data: null, error: { code: "PGRST116" } };
            return { data: rows[0] ?? null, error: null };
          }
          if (rpcName === "conversation_counts")
            return { data: rows[0].conversation_counts, error: null };
          return { data: rows, error: null };
        } catch (error) {
          return { data: null, error };
        }
      },
      then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
        return chain.execute().then(onFulfilled, onRejected);
      },
    };
    return chain;
  }
  return {
    requests,
    from(table: string) {
      return query(identifier(table));
    },
    rpc(name: string, input: Record<string, unknown>) {
      const entries = Object.entries(input);
      return query(
        `${identifier(name)}(${entries.map(([key], i) => `${identifier(key)} => $${i + 1}`).join(",")})`,
        entries.map(([, value]) => value),
        name,
      );
    },
  };
}
