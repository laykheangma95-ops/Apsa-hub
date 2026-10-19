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
 *   - the `!inner` embed the search uses filters as the emulation assumes;
 *   - through the PRODUCTION principal path (the session's user → its active
 *     membership → its role's permissions, each read through PostgREST),
 *     pages past 200 and past the cap end exactly, with exact first, middle
 *     and last pages, and only the caller's organization;
 *   - name, SKU, barcode (and Khmer-digit barcode) matches far past the first
 *     capped range, with filtered totals equal to independent SQL;
 *   - roles: no products.read is refused, no products.view_cost sees no cost
 *     on any page, and a suspended or absent membership reaches no catalogue;
 *   - archiving the cursor's product or a whole last page strands nothing;
 *   - negative control: the pre-#126 screen (one 200-row read + a browser
 *     filter) provably misses products these checks find.
 *
 * scripts/run-catalog-postgrest-gate.ts provisions all of it (a throwaway
 * database with every migration, a real PostgREST per row cap) and, with
 * --negative-controls, proves each named regression makes this file fail.
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
  rest = new PostgrestClient(
    env.url!,
    {
      headers: { Authorization: `Bearer ${env.jwt}`, apikey: env.jwt! },
    },
    120_000,
  );
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
    return walkAs(ctxFor(org), query);
  }

  async function walkAs(ctx: any, query: Record<string, unknown> = {}) {
    const products: any[] = [];
    const answered: any[] = [];
    let before: any = query["before"];
    for (;;) {
      const page = await service.listProductsPage(ctx, { ...query, before });
      answered.push(page);
      products.push(...page.products);
      if (!page.nextCursor) break;
      before = page.nextCursor;
      if (answered.length > 1000) throw new Error("walk never ended");
    }
    return {
      pages: answered.length,
      answered,
      products,
      ids: products.map((p) => p.id as string),
    };
  }

  /** A member of `org` in a system role, or (null) a custom role with no permissions. */
  async function member(org: string, roleName: string | null, status = "active") {
    const user = crypto.randomUUID();
    await sql`insert into auth.users(id,email) values(${user}, ${`${user}@test.invalid`})`;
    let roleId: string;
    if (roleName === null) {
      roleId = crypto.randomUUID();
      await sql`insert into roles(id,organization_id,name) values(${roleId}, ${org}, 'No catalogue')`;
    } else {
      roleId = (
        (await sql`select id from roles where organization_id is null and name = ${roleName}`) as any[]
      )[0].id;
    }
    await sql`insert into memberships(user_id,organization_id,role_id,status)
              values(${user}, ${org}, ${roleId}, ${status}::membership_status)`;
    return user;
  }

  /**
   * What listProductsPageFn does before the service (src/api/products.ts
   * resolveAuthContext), after the session: the user's canonical active
   * membership, then that membership's role and permission keys — every read
   * through PostgREST. null where the server function would refuse.
   */
  async function principal(user: string): Promise<any> {
    const { resolveActiveOrganizationId } = await import("@/server/auth/active-organization");
    const { AuthorizationService } = await import("@/server/auth/authorization");
    const org = await resolveActiveOrganizationId(user);
    return org ? AuthorizationService.forRequest(user, org) : null;
  }

  /** A pre-#126 copy of src/lib/catalog.ts searchLoadedProducts (7e7e733). */
  function legacySearchLoadedProducts(products: any[], query: string): any[] {
    const needle = query.trim().toLowerCase();
    if (needle === "") return [...products];
    return products.filter(
      (product) =>
        product.nameKm.toLowerCase().includes(needle) ||
        (product.nameEn ?? "").toLowerCase().includes(needle) ||
        product.variants.some(
          (variant: any) =>
            variant.name.toLowerCase().includes(needle) ||
            (variant.sku ?? "").toLowerCase().includes(needle) ||
            (variant.barcode ?? "").toLowerCase().includes(needle),
        ),
    );
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

  // Larger than the old 200-row read AND larger than this server's cap.
  const beyond = Math.max(200, cap) + 137;

  it(`the production principal path: ${beyond} products, beyond 200 and beyond the cap, exact pages`, async () => {
    const a = await newOrg();
    const b = await newOrg();
    const owner = await member(a, "Owner");
    await seed(a, beyond, "ALPHA");
    // The neighbour's rows interleave in time with the caller's.
    await seed(b, beyond, "ALPHA", { base: "2026-10-01 12:00:00.5+00" });

    const ctx = await principal(owner);
    expect(ctx.organizationId).toBe(a);
    const want = await expected(a);
    expect(want).toHaveLength(beyond);

    const walked = await walkAs(ctx);
    expect(walked.ids).toEqual(want);
    expect(new Set(walked.ids).size).toBe(beyond);
    expect(walked.products.every((p) => p.organizationId === a)).toBe(true);

    const pages = walked.answered;
    expect(pages).toHaveLength(Math.ceil(beyond / 50));
    for (const page of pages.slice(0, -1)) {
      expect(page.products).toHaveLength(50);
      expect(page.nextCursor).not.toBeNull();
    }
    const middle = Math.floor(pages.length / 2);
    expect(pages[0].products.map((p: any) => p.id)).toEqual(want.slice(0, 50));
    expect(pages[middle].products.map((p: any) => p.id)).toEqual(
      want.slice(middle * 50, middle * 50 + 50),
    );
    const last = pages.at(-1);
    expect(last.products.map((p: any) => p.id)).toEqual(want.slice((pages.length - 1) * 50));
    expect(last.products.length).toBe(beyond - 50 * (pages.length - 1));
    expect(last.nextCursor).toBeNull();
    for (const page of pages) {
      expect(page.servedAs).toEqual({ userId: owner, organizationId: a });
      expect(page.query).toEqual({ status: "ACTIVE", categoryId: null, search: "" });
    }
    // Asking for the last page again, from the cursor that led to it, answers the same.
    const again = await service.listProductsPage(ctx, { before: pages.at(-2).nextCursor });
    expect(again.products.map((p: any) => p.id)).toEqual(last.products.map((p: any) => p.id));
    expect(again.nextCursor).toBeNull();
  }, 120_000);

  it("SKU, barcode and name matches beyond the early pages and the cap; filtered totals", async () => {
    const a = await newOrg();
    const b = await newOrg();
    const owner = await member(a, "Owner");
    const ownerB = await member(b, "Owner");
    const drinks = await newCategory(a);
    const matches = Math.max(200, cap) + 23;
    // Non-matching rows newest, matching rows interleaved through them and beyond.
    await seed(a, Math.max(200, cap) + 61, "FILL", { nameEn: "Plain" });
    await seed(a, matches, "KTL", { nameEn: "Steel kettle", base: "2026-10-01 11:59:59.5+00" });
    // The oldest two products: one found only by SKU, one only by barcode.
    await seed(a, 1, "DEEPS", { nameEn: null, base: "2020-01-02 00:00:00+00" });
    await seed(a, 1, "DEEPB", { nameEn: null, base: "2020-01-01 00:00:00+00" });
    await sql`update product_variants set sku = 'ZX-90417'
               where organization_id = ${a} and sku = 'DEEPS-00001-V1'`;
    await sql`update product_variants set barcode = '8850000000777'
               where organization_id = ${a} and sku = 'DEEPB-00001-V1'`;
    // The neighbour holds the same names, SKU and barcode, all NEWER.
    await seed(b, 60, "KTL", { nameEn: "Steel kettle", base: "2026-10-03 12:00:00+00" });
    await sql`update product_variants set sku = 'ZX-90417'
               where organization_id = ${b} and sku = 'KTL-00001-V1'`;
    await sql`update product_variants set barcode = '8850000000777'
               where organization_id = ${b} and sku = 'KTL-00002-V1'`;
    const [deepSku] = await expected(a, (r) => r.name_km === "DEEPS-00001");
    const [deepBarcode] = await expected(a, (r) => r.name_km === "DEEPB-00001");
    const ctx = await principal(owner);

    const kettles = await expected(a, (r) => r.status === "ACTIVE" && r.name_km.startsWith("KTL-"));
    expect(kettles).toHaveLength(matches);
    const byName = await walkAs(ctx, { search: "kettle" });
    expect(byName.ids).toEqual(kettles);
    expect(byName.pages).toBe(Math.ceil(matches / 50));
    // The deep ones are past every early page and past the cap in raw order.
    const all = await expected(a);
    expect(all.indexOf(deepSku!)).toBeGreaterThan(Math.max(200, cap));
    expect(all.indexOf(deepBarcode!)).toBeGreaterThan(Math.max(200, cap));

    for (const text of ["ZX-90417", "zx-90417", "90417"]) {
      expect((await walkAs(ctx, { search: text })).ids).toEqual([deepSku]);
    }
    for (const text of ["8850000000777", "៨៨៥០០០០០០០៧៧៧", "0000777"]) {
      expect((await walkAs(ctx, { search: text })).ids).toEqual([deepBarcode]);
    }

    // Category + search, and Archived + search: totals equal independent SQL.
    await sql`update products set category_id = ${drinks}
               where organization_id = ${a} and name_km like 'KTL-%'
                 and substr(name_km, 5)::int % 3 = 0`;
    await sql`update products set status = 'ARCHIVED'
               where organization_id = ${a} and name_km like 'KTL-%'
                 and substr(name_km, 5)::int % 7 = 0`;
    const inDrinks = await expected(
      a,
      (r) => r.status === "ACTIVE" && r.category_id === drinks && r.name_km.startsWith("KTL-"),
    );
    expect((await walkAs(ctx, { search: "kettle", categoryId: drinks })).ids).toEqual(inDrinks);
    const archived = await expected(
      a,
      (r) => r.status === "ARCHIVED" && r.name_km.startsWith("KTL-"),
    );
    expect(archived.length).toBeGreaterThan(0);
    expect((await walkAs(ctx, { search: "kettle", status: "ARCHIVED" })).ids).toEqual(archived);
    expect((await walkAs(ctx, { search: "kettle" })).ids).toEqual(
      await expected(a, (r) => r.status === "ACTIVE" && r.name_km.startsWith("KTL-")),
    );

    // The neighbour sees only its own, with the same text.
    const ctxB = await principal(ownerB);
    const theirs = await walkAs(ctxB, { search: "kettle" });
    expect(theirs.ids).toEqual(await expected(b));
    expect((await walkAs(ctxB, { search: "ZX-90417" })).ids).toHaveLength(1);
    expect((await walkAs(ctxB, { search: "ZX-90417" })).products[0].organizationId).toBe(b);
  }, 120_000);

  it("roles through the real membership read: read, cost, no read, suspended, none", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await seed(a, cap + 60, "ROLE");
    await seed(b, 30, "ROLEB");
    const owner = await member(a, "Owner");
    const cashier = await member(a, "Cashier");
    const noRead = await member(a, null);
    const suspended = await member(a, "Owner", "suspended");
    const neighbour = await member(b, "Manager");
    const stranger = crypto.randomUUID();
    await sql`insert into auth.users(id,email) values(${stranger}, ${`${stranger}@test.invalid`})`;

    const want = await expected(a);
    const ownerCtx = await principal(owner);
    const asOwner = await walkAs(ownerCtx);
    expect(asOwner.ids).toEqual(want);
    // Real PostgREST cuts EMBEDDED arrays at max_rows too. The membership read
    // (src/server/auth/membership.ts, not changed by #126) embeds the role's
    // permission keys, so under a cap below the Owner's permission count the
    // Owner resolves with fewer permissions — fail closed, never more. Reported
    // as a finding; cost visibility for the Owner needs the whole set.
    const ownerPermissions = (
      (await sql`select count(*)::int as n from role_permissions rp join roles r on r.id = rp.role_id
                  where r.organization_id is null and r.name = 'Owner'`) as any[]
    )[0].n as number;
    if (cap >= ownerPermissions) {
      expect(asOwner.products.every((p) => p.variants.every((v: any) => v.cost !== null))).toBe(
        true,
      );
    } else {
      expect(ownerCtx.can("products.read")).toBe(true);
      expect(ownerCtx.can("products.view_cost")).toBe(false);
      expect(asOwner.products.every((p) => p.variants.every((v: any) => v.cost === null))).toBe(
        true,
      );
    }

    const asCashier = await walkAs(await principal(cashier));
    expect(asCashier.ids).toEqual(want);
    expect(asCashier.products.flatMap((p) => p.variants)).toHaveLength(want.length);
    expect(asCashier.products.every((p) => p.variants.every((v: any) => v.cost === null))).toBe(
      true,
    );
    expect(
      (await walkAs(await principal(cashier), { search: "ROLE-0000" })).products.every((p) =>
        p.variants.every((v: any) => v.cost === null),
      ),
    ).toBe(true);

    const { ForbiddenError } = await import("@/server/auth/authorization");
    const refused = await principal(noRead);
    expect(refused.organizationId).toBe(a);
    await expect(service.listProductsPage(refused)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.listProductsPage(refused, { search: "ROLE" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    expect(await principal(suspended)).toBeNull();
    expect(await principal(stranger)).toBeNull();

    const asNeighbour = await walkAs(await principal(neighbour));
    expect(asNeighbour.ids).toEqual(await expected(b));
    expect(asNeighbour.products.every((p) => p.organizationId === b)).toBe(true);
  }, 120_000);

  it("archiving the cursor's product, or a whole last page, strands nothing", async () => {
    const a = await newOrg();
    const ctx = await principal(await member(a, "Owner"));
    await seed(a, 120, "EDGE");
    const first = await service.listProductsPage(ctx);
    const cursor = first.nextCursor!;
    // The product the cursor names leaves the list; the next page is unchanged.
    await sql`update products set status = 'ARCHIVED' where id = ${cursor.id}`;
    const second = await service.listProductsPage(ctx, { before: cursor });
    expect(second.products.map((p: any) => p.id)).toEqual((await expected(a)).slice(49, 99));
    // An edit does not move a product.
    await sql`update products set name_en = 'Renamed' where id = ${second.products[0].id}`;
    expect((await service.listProductsPage(ctx, { before: cursor })).products[0].id).toBe(
      second.products[0].id,
    );
    // Archive everything from the last page: asking for it again is empty and the end.
    const last = await service.listProductsPage(ctx, { before: second.nextCursor! });
    expect(last.nextCursor).toBeNull();
    for (const p of last.products) {
      await sql`update products set status = 'ARCHIVED' where id = ${p.id}`;
    }
    const emptied = await service.listProductsPage(ctx, { before: second.nextCursor! });
    expect(emptied.products).toEqual([]);
    expect(emptied.nextCursor).toBeNull();
    expect((await walkAs(ctx)).ids).toEqual(await expected(a));
  });

  it("negative control: the pre-#126 read (200 rows + browser filter) misses what this gate finds", async () => {
    const a = await newOrg();
    const ctx = await principal(await member(a, "Owner"));
    await seed(a, beyond, "OLD");
    await seed(a, 1, "DEEPS", { nameEn: null, base: "2020-01-01 00:00:00+00" });
    await sql`update product_variants set sku = 'ZX-55501'
               where organization_id = ${a} and sku = 'DEEPS-00001-V1'`;
    const want = await expected(a);

    // The old screen: listProductsFn({ status, limit: 200 }), then a filter in the browser.
    const old = await service.getProductCatalog(ctx, { status: "ACTIVE", limit: 200 });
    expect(old).toHaveLength(Math.min(200, cap));
    const oldIds = new Set(old.map((p: any) => p.id as string));
    const missing = want.filter((id) => !oldIds.has(id));
    expect(missing.length).toBe(want.length - old.length);
    expect(missing.length).toBeGreaterThan(0);
    expect(legacySearchLoadedProducts(old, "zx-55501")).toEqual([]);
    // The same expectations this file applies to the new read reject the old one.
    expect(old.map((p: any) => p.id)).not.toEqual(want);

    // The new read finds everything, and the deep SKU.
    expect((await walkAs(ctx)).ids).toEqual(want);
    expect((await walkAs(ctx, { search: "zx-55501" })).ids).toHaveLength(1);

    // Unchanged by #126 and reported as P1: the POS/order-picker whole-catalogue
    // read is still cut at max_rows, silently.
    const pos = await service.getProductCatalog(ctx, { status: "ACTIVE" });
    expect(pos).toHaveLength(Math.min(want.length, cap));
  }, 120_000);
});
