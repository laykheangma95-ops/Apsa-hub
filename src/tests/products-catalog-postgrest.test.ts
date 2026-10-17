/**
 * Products catalogue pages and variants against a REAL PostgREST — opt-in.
 *
 * products-catalog-mounted emulates PostgREST (its SQL transport cuts every
 * response at max_rows). This file checks the same promises against the real
 * thing: the real products service and repository, through the real
 * @supabase/postgrest-js query builder (what supabaseAdmin.from() delegates
 * to), against a real PostgREST whose db-max-rows is set low, over a database
 * built from every migration.
 *
 * What it proves, under the configured max_rows:
 *   - the cap is real: a read asking for more rows comes back short, with no
 *     error and nothing in the body saying so;
 *   - every list, category, status and search walk returns each product once,
 *     in (created_at DESC, id DESC) order, and ends only at the true end;
 *   - same-instant bursts larger than the cap are neither skipped nor repeated;
 *   - every variant arrives, under its own product, never another tenant's;
 *   - the `!inner` embed the search uses filters as the emulation assumes.
 *
 * Skipped unless all four variables are set, and refuses any host but the
 * loopback interface, so it can never reach a hosted project:
 *
 *   APSA_TEST_POSTGREST_URL       e.g. http://127.0.0.1:3050
 *   APSA_TEST_POSTGREST_MAX_ROWS  that server's db-max-rows, e.g. 50
 *   APSA_TEST_POSTGREST_JWT       a service_role JWT signed with its jwt-secret
 *   APSA_TEST_DATABASE_URL        the same database, for seeding and the
 *                                 independent SQL each walk is compared with
 *
 * The database needs the Supabase shim from helpers/payment-order-fixture.ts
 * (roles anon/authenticated/service_role, schema auth) and every migration.
 * Run it on its own — it replaces the Supabase admin client module:
 *
 *   bun test src/tests/products-catalog-postgrest.test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, mock } from "bun:test";

const env = {
  url: process.env["APSA_TEST_POSTGREST_URL"],
  maxRows: Number(process.env["APSA_TEST_POSTGREST_MAX_ROWS"]),
  jwt: process.env["APSA_TEST_POSTGREST_JWT"],
  database: process.env["APSA_TEST_DATABASE_URL"],
};
const enabled = Boolean(env.url && env.jwt && env.database && env.maxRows > 0);

function loopbackOnly(raw: string) {
  const host = new URL(raw).hostname;
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
    throw new Error(`Refusing a non-loopback test target: ${host}`);
  }
}

// Module scope: bun registers no test declared after an await inside describe.
let rest: any;
let sql: any;
let service: typeof import("@/server/products/service");
const cap = env.maxRows;
const USER = crypto.randomUUID();

if (enabled) {
  loopbackOnly(env.url!);
  loopbackOnly(env.database!);

  const { PostgrestClient } = await import("@supabase/postgrest-js");
  rest = new PostgrestClient(env.url!, {
    headers: { Authorization: `Bearer ${env.jwt}`, apikey: env.jwt! },
  });
  mock.module("@/lib/supabase/server", () => ({ supabaseAdmin: rest }));

  const { SQL } = await import("bun");
  sql = new SQL(env.database!);
  service = await import("@/server/products/service");
  await sql`insert into auth.users(id,email) values(${USER}, ${`${USER}@test.invalid`})`;
}

describe.skipIf(!enabled)("Products catalogue against a real PostgREST", () => {
  async function newOrg(): Promise<string> {
    const org = crypto.randomUUID();
    await sql`insert into organizations(id,legal_name,display_name,slug,created_by)
              values(${org}, 'Cap test', 'Cap test', ${`cap-${org}`}, ${USER})`;
    return org;
  }

  async function newCategory(org: string): Promise<string> {
    const id = crypto.randomUUID();
    await sql`insert into product_categories(id,organization_id,name_km,name_en)
              values(${id}, ${org}, 'ភេសជ្ជៈ', 'Drinks')`;
    return id;
  }

  /** `count` products `<prefix>-00001…`, i seconds before `base` (or all AT `base`). */
  async function seed(
    org: string,
    count: number,
    prefix: string,
    options: {
      base?: string;
      sameInstant?: boolean;
      status?: string;
      categoryId?: string | null;
      nameEn?: string | null;
      variants?: number;
      variantName?: string;
    } = {},
  ) {
    const base = options.base ?? "2026-10-01 12:00:00+00";
    await sql`
      insert into products(id,organization_id,name_km,name_en,category_id,status,created_at)
      select gen_random_uuid(), ${org}, ${prefix} || '-' || lpad((i + 1)::text, 5, '0'),
             ${options.nameEn === undefined ? "Item" : options.nameEn},
             ${options.categoryId ?? null}, ${options.status ?? "ACTIVE"}::product_status,
             ${base}::timestamptz - make_interval(secs => case when ${options.sameInstant ?? false}
                                                          then 0 else i end)
        from generate_series(0, ${count} - 1) as i`;
    const variants = options.variants ?? 1;
    await sql`
      insert into product_variants(organization_id,product_id,sku,name,price_amount,price_currency,
                                   cost_amount,cost_currency,created_at)
      select p.organization_id, p.id, p.name_km || '-V' || v, ${options.variantName ?? "Size"} || ' ' || v,
             1000 + v, 'USD', 400, 'USD', p.created_at + make_interval(secs => v)
        from products p cross join generate_series(1, ${variants}) as v
       where p.organization_id = ${org} and p.name_km like ${prefix} || '-%'`;
  }

  /** The order the list must show, by plain SQL independent of the code under test. */
  async function expected(
    org: string,
    where: (row: any) => boolean = (r) => r.status === "ACTIVE",
  ) {
    const rows = await sql`
      select id, name_km, status, category_id from products where organization_id = ${org}
       order by created_at desc, id desc`;
    return (rows as any[]).filter(where).map((r) => r.id as string);
  }

  function ctxFor(org: string): any {
    return {
      userId: USER,
      organizationId: org,
      require: () => {},
      can: () => true,
    };
  }

  async function walk(org: string, query: Record<string, unknown> = {}) {
    const products: any[] = [];
    let before: any = query["before"];
    let pages = 0;
    for (;;) {
      const page = await service.listProductsPage(ctxFor(org), { ...query, before });
      pages += 1;
      products.push(...page.products);
      if (!page.nextCursor) break;
      before = page.nextCursor;
      if (pages > 1000) throw new Error("walk never ended");
    }
    return { pages, products, ids: products.map((p) => p.id as string) };
  }

  it(`the cap is real: asking for ${cap + 1} rows returns ${cap}, without an error`, async () => {
    const org = await newOrg();
    await seed(org, cap + 10, "RAW");
    const { data, error } = await rest
      .from("products")
      .select("id")
      .eq("organization_id", org)
      .limit(cap + 1);
    expect(error).toBeNull();
    expect(data).toHaveLength(cap);
  });

  it("201 and 1,000 products: every product once, in order, then the end", async () => {
    for (const count of [201, 1000]) {
      const org = await newOrg();
      await seed(org, count, `L${count}`);
      const walked = await walk(org);
      expect(walked.ids).toEqual(await expected(org));
      expect(walked.pages).toBe(Math.ceil(count / 50));
    }
  });

  it("the largest page (100) and a small one (7) walk exactly", async () => {
    const org = await newOrg();
    await seed(org, 333, "SIZES");
    for (const limit of [100, 7]) {
      expect((await walk(org, { limit })).ids).toEqual(await expected(org));
    }
  });

  it("a same-instant burst larger than the cap, between newer and older rows", async () => {
    const org = await newOrg();
    await seed(org, 30, "NEWER", { base: "2026-10-02 12:00:00+00" });
    await seed(org, Math.max(130, cap * 2 + 30), "BURST", {
      base: "2026-10-01 12:00:00.123456+00",
      sameInstant: true,
    });
    await seed(org, 30, "OLDER", { base: "2026-09-30 12:00:00+00" });
    for (const limit of [50, 100, 7]) {
      expect((await walk(org, { limit })).ids).toEqual(await expected(org));
    }
  });

  it("category, Archived, and both together", async () => {
    const org = await newOrg();
    const drinks = await newCategory(org);
    await seed(org, 120, "CAT", { categoryId: drinks });
    await seed(org, 90, "OTHER");
    await seed(org, 110, "ARCH", { status: "ARCHIVED", categoryId: drinks });
    expect((await walk(org, { categoryId: drinks })).ids).toEqual(
      await expected(org, (r) => r.status === "ACTIVE" && r.category_id === drinks),
    );
    expect((await walk(org, { status: "ARCHIVED" })).ids).toEqual(
      await expected(org, (r) => r.status === "ARCHIVED"),
    );
    expect((await walk(org, { status: "ARCHIVED", categoryId: drinks })).ids).toHaveLength(110);
  });

  it("search through the real !inner embed: names, SKUs and variant names, paged to the end", async () => {
    const org = await newOrg();
    const other = await newOrg();
    await seed(org, 120, "TEAN", { nameEn: "Tea blend" });
    await seed(org, 40, "VARI", { nameEn: null, variantName: "tea size" });
    await seed(org, 70, "COFF", { nameEn: "Coffee" });
    await seed(other, 80, "THEIRTEA", { nameEn: "Tea blend" });

    const walked = await walk(org, { search: "tea" });
    expect(walked.ids).toEqual(
      await expected(org, (r) => r.status === "ACTIVE" && /^(TEAN|VARI)-/.test(r.name_km)),
    );
    expect(walked.products.every((p) => p.organizationId === org)).toBe(true);
    // An archived variant's SKU does not make its product match.
    await sql`update product_variants set status = 'ARCHIVED'
               where organization_id = ${org} and sku = 'COFF-00001-V1'`;
    expect((await walk(org, { search: "COFF-00001-V1" })).ids).toEqual([]);
    expect((await walk(org, { search: "COFF-00002-V1" })).ids).toHaveLength(1);
  });

  it("variants: 2,500 on one product, 50 × 30 on a page — all of them, under their own product", async () => {
    const org = await newOrg();
    await seed(org, 1, "HUGE", { variants: 2500 });
    const huge = (await service.listProductsPage(ctxFor(org))).products[0];
    expect(huge.variants).toHaveLength(2500);
    expect(new Set(huge.variants.map((v: any) => v.id)).size).toBe(2500);

    const wide = await newOrg();
    await seed(wide, 60, "WIDE", { variants: 30 });
    const page = await service.listProductsPage(ctxFor(wide));
    expect(page.products).toHaveLength(50);
    for (const p of page.products) {
      expect(p.variants).toHaveLength(30);
      expect(p.variants.every((v: any) => v.sku.startsWith(`${p.nameKm}-V`))).toBe(true);
    }
  });

  it("the POS whole-catalogue read keeps every variant of the products it returns", async () => {
    const org = await newOrg();
    await seed(org, Math.min(cap, 40), "POS", { variants: 7 });
    const all = await service.getProductCatalog(ctxFor(org), { status: "ACTIVE" });
    expect(all.every((p: any) => p.variants.length === 7)).toBe(true);
  });

  it("another organization's cursor moves only through the caller's rows, completely", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await seed(a, 140, "MINE");
    await seed(b, 60, "THEIRS", { base: "2026-10-01 12:00:30+00" });
    const foreign = (await service.listProductsPage(ctxFor(b))).nextCursor!;
    const walked = await walk(a, { before: foreign });
    expect(walked.products.every((p) => p.organizationId === a)).toBe(true);
    const rows = await sql`
      select id from products
       where organization_id = ${a} and status = 'ACTIVE'
         and (created_at, id) < (${foreign.createdAt}::timestamptz, ${foreign.id}::uuid)
       order by created_at desc, id desc`;
    expect(walked.ids).toEqual((rows as any[]).map((r) => r.id));
  });
});
