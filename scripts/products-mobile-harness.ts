/**
 * The real Products route, on phone widths, against a real local backend.
 *
 * Builds nothing hosted and reaches nothing hosted. It provisions a throwaway
 * database with every migration and a real PostgREST (scripts/lib/
 * local-postgrest.ts, db-max-rows 1000 — Supabase's default), seeds fabricated
 * catalogues, and puts a small loopback gateway in front: `/rest/v1/*` is
 * proxied to that PostgREST, and `/auth/v1/user` answers for the session
 * tokens this run minted (nothing else of Supabase Auth is emulated). The
 * PRODUCTION build (`vite build`, Nitro) is then served against the gateway,
 * and headless Chromium drives /app/products at 320, 360, 390 and 430 px, in
 * Khmer and in English, recording each check and a screenshot.
 *
 *   APSA_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres \
 *   APSA_TEST_POSTGREST_BIN=/path/to/postgrest \
 *   APSA_PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
 *   bun run scripts/products-mobile-harness.ts --out <evidence dir> [--skip-build]
 *
 * Optional: APSA_CHROMIUM (default /opt/pw-browsers/chromium-1194/chrome-linux/chrome).
 * Playwright is NOT a dependency of this repository; point APSA_PLAYWRIGHT_CORE
 * at any local install of playwright-core.
 *
 * The build bakes the gateway URL into the browser bundle as
 * VITE_SUPABASE_URL, so the gateway listens on a fixed loopback port
 * (--gateway-port, default 54329). Rebuild before deploying anything.
 */
import { SQL } from "bun";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { jwt, provision } from "./lib/local-postgrest";

/* eslint-disable @typescript-eslint/no-explicit-any -- Playwright is loaded untyped, by path */

const root = path.resolve(import.meta.dir, "..");
const adminUrl = process.env["APSA_TEST_PG_URL"];
const bin = process.env["APSA_TEST_POSTGREST_BIN"];
const playwrightPath = process.env["APSA_PLAYWRIGHT_CORE"];
const chromiumPath =
  process.env["APSA_CHROMIUM"] ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
if (!adminUrl || !bin || !playwrightPath) {
  console.error("APSA_TEST_PG_URL, APSA_TEST_POSTGREST_BIN and APSA_PLAYWRIGHT_CORE are required.");
  process.exit(2);
}
const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const out = path.resolve(flag("--out") ?? "products-mobile-evidence");
const gatewayPort = Number(flag("--gateway-port") ?? 54329);
const appPort = gatewayPort + 1;
const ssrPort = gatewayPort + 2;
const skipBuild = args.includes("--skip-build");
mkdirSync(out, { recursive: true });

const WIDTHS = [320, 360, 390, 430];
const LANGS = ["km", "en"] as const;
type Lang = (typeof LANGS)[number];
const locale = Object.fromEntries(
  LANGS.map((lang) => [
    lang,
    JSON.parse(readFileSync(path.join(root, `src/locales/${lang}.json`), "utf8")),
  ]),
) as Record<Lang, any>;
const s = (lang: Lang, key: string): string =>
  key.split(".").reduce((node: any, part) => node?.[part], locale[lang]) as string;

// ── Backend ──────────────────────────────────────────────────────────────────

const target = await provision(adminUrl, bin, 1000);
const sql = new SQL({ url: target.databaseUrl, max: 2 });
let app: ChildProcess | null = null;
let gateway: ReturnType<typeof Bun.serve> | null = null;
let front: ReturnType<typeof Bun.serve> | null = null;

const users = {
  owner: { id: crypto.randomUUID(), email: "mobile-owner@test.invalid" },
  // One empty business per language pass: Khmer on KHR, English on USD.
  newcomerKm: { id: crypto.randomUUID(), email: "mobile-new-km@test.invalid" },
  newcomerEn: { id: crypto.randomUUID(), email: "mobile-new-en@test.invalid" },
};
const tokens = new Map<string, (typeof users)[keyof typeof users]>();
const tokenFor = (user: (typeof users)[keyof typeof users]) => {
  const token = jwt(target.secret, {
    sub: user.id,
    email: user.email,
    role: "authenticated",
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 7200,
  });
  tokens.set(token, user);
  return token;
};

const LONG_KM =
  "ទឹកក្រូចច្របាច់ស្រស់ធម្មជាតិគ្មានជាតិស្ករបន្ថែម ខ្ចប់ក្នុងដបកែវធំសម្រាប់គ្រួសារ និងការជប់លៀងពិសេស";
const LONG_EN =
  "Freshly squeezed natural orange juice, no added sugar, family-size glass bottle for parties";
const LONG_SKU = "APSA-ORANGE-JUICE-FAMILY-GLASS-BOTTLE-1500ML-NO-SUGAR-2026-LOT-0001";

async function seed() {
  for (const user of Object.values(users)) {
    await sql`insert into auth.users(id,email) values(${user.id}, ${user.email})`;
  }
  const shop = crypto.randomUUID();
  const emptyKhr = crypto.randomUUID();
  const emptyUsd = crypto.randomUUID();
  await sql`insert into organizations(id,legal_name,display_name,slug,created_by,default_currency)
            values(${shop}, 'Mobile Shop', 'Mobile Shop', 'mobile-shop', ${users.owner.id}, 'USD'),
                  (${emptyKhr}, 'Empty KHR', 'Empty KHR', 'empty-khr', ${users.newcomerKm.id}, 'KHR'),
                  (${emptyUsd}, 'Empty USD', 'Empty USD', 'empty-usd', ${users.newcomerEn.id}, 'USD')`;
  const owner = (
    (await sql`select id from roles where organization_id is null and name = 'Owner'`) as any[]
  )[0].id;
  await sql`insert into memberships(user_id,organization_id,role_id,status)
            values(${users.owner.id}, ${shop}, ${owner}, 'active'),
                  (${users.newcomerKm.id}, ${emptyKhr}, ${owner}, 'active'),
                  (${users.newcomerEn.id}, ${emptyUsd}, ${owner}, 'active')`;
  const drinks = crypto.randomUUID();
  await sql`insert into product_categories(id,organization_id,name_km,name_en)
            values(${drinks}, ${shop}, 'ភេសជ្ជៈ', 'Drinks')`;
  // 230 active (40 in Drinks), 8 archived; the oldest active one is found only by SKU.
  await sql`
    insert into products(id,organization_id,name_km,name_en,category_id,status,created_at)
    select gen_random_uuid(), ${shop}, 'កាហ្វេ ' || lpad(i::text, 3, '0'), 'Coffee ' || i,
           case when i % 6 = 0 then ${drinks}::uuid end,
           case when i > 230 then 'ARCHIVED' else 'ACTIVE' end::product_status,
           timestamptz '2026-10-01 12:00:00+00' - make_interval(secs => i)
      from generate_series(1, 238) as i`;
  await sql`
    insert into products(id,organization_id,name_km,name_en,status,created_at)
    values (gen_random_uuid(), ${shop}, ${LONG_KM}, ${LONG_EN}, 'ACTIVE', timestamptz '2026-10-02 12:00:00+00'),
           (gen_random_uuid(), ${shop}, 'ចាស់បំផុត', null, 'ACTIVE', timestamptz '2020-01-01 00:00:00+00')`;
  await sql`
    insert into product_variants(organization_id,product_id,sku,name,price_amount,price_currency,
                                 cost_amount,cost_currency,created_at)
    select p.organization_id, p.id,
           case when p.name_km = ${LONG_KM} then ${LONG_SKU}
                when p.name_km = 'ចាស់បំផុត' then 'ZX-90417'
                else 'CF-' || substr(p.name_km, 7) end,
           'Default', 250, 'USD', 100, 'USD', p.created_at
      from products p where p.organization_id = ${shop}`;
}

function startGateway() {
  gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: gatewayPort,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/rest/v1/")) {
        const headers = new Headers(request.headers);
        headers.delete("host");
        const upstream = await fetch(
          `${target.postgrestUrl}${url.pathname.slice("/rest/v1".length)}${url.search}`,
          {
            method: request.method,
            headers,
            body: ["GET", "HEAD"].includes(request.method)
              ? undefined
              : await request.arrayBuffer(),
          },
        );
        const responseHeaders = new Headers(upstream.headers);
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");
        return new Response(await upstream.arrayBuffer(), {
          status: upstream.status,
          headers: responseHeaders,
        });
      }
      if (url.pathname === "/auth/v1/user") {
        const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        const user = tokens.get(token);
        if (!user) return Response.json({ message: "invalid JWT" }, { status: 401 });
        return Response.json({
          id: user.id,
          aud: "authenticated",
          role: "authenticated",
          email: user.email,
          email_confirmed_at: "2026-01-01T00:00:00Z",
          app_metadata: {},
          user_metadata: {},
          created_at: "2026-01-01T00:00:00Z",
        });
      }
      console.warn(`[gateway] not emulated: ${request.method} ${url.pathname}`);
      return Response.json({ message: "not emulated" }, { status: 404 });
    },
  });
}

const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
const anonKey = jwt(target.secret, { role: "anon", exp: Math.floor(Date.now() / 1000) + 7200 });
const appEnv = {
  ...process.env,
  VITE_SUPABASE_URL: gatewayUrl,
  VITE_SUPABASE_ANON_KEY: anonKey,
  VITE_APP_URL: `http://127.0.0.1:${appPort}`,
  SUPABASE_SERVICE_ROLE_KEY: target.token,
};

async function startApp() {
  if (!skipBuild) {
    const build = spawnSync(process.execPath, ["x", "vite", "build"], {
      cwd: root,
      env: appEnv,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (build.status !== 0) throw new Error(`vite build failed:\n${build.stdout}${build.stderr}`);
  }
  app = spawn(process.execPath, [path.join(root, ".output/server/index.mjs")], {
    cwd: root,
    env: { ...appEnv, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(ssrPort) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  // The build's Nitro preset is cloudflare-module, where the platform serves
  // .output/public and the worker never does. Serve those files here, exactly
  // as built, and hand every other request to the server.
  const publicDir = path.join(root, ".output/public");
  front = Bun.serve({
    hostname: "127.0.0.1",
    port: appPort,
    async fetch(request) {
      const url = new URL(request.url);
      const file = path.join(publicDir, path.normalize(decodeURIComponent(url.pathname)));
      if (file.startsWith(`${publicDir}/`) && (await Bun.file(file).exists())) {
        return new Response(Bun.file(file));
      }
      const headers = new Headers(request.headers);
      headers.delete("host");
      return fetch(`http://127.0.0.1:${ssrPort}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
        redirect: "manual",
      });
    },
  });
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${ssrPort}/`)).status < 500) break;
    } catch {
      // not listening yet
    }
    if (attempt > 200) throw new Error("the production server did not start");
    await Bun.sleep(100);
  }
}

// ── Checks ───────────────────────────────────────────────────────────────────

interface Check {
  lang: Lang;
  width: number;
  name: string;
  ok: boolean;
  detail?: string;
  /** A failure already present on main, outside #126: listed, never hidden. */
  known?: string;
}
const checks: Check[] = [];
const consoleErrors: string[] = [];
/** The page in use, so a failure can leave its screenshot, URL and HTML behind. */
let lastPage: any = null;
/** While set, a failed page read is the one this run aborted on purpose. */
let abortingPageReads = false;
const expectedFailures: string[] = [];

/**
 * listProductsPageFn's id in this build: production server-function URLs are
 * content hashes, so the id is read from the built client chunk's exports.
 */
function pageFnId(): string {
  const assets = path.join(root, ".output/public/assets");
  for (const file of readdirSync(assets).filter((name) => /^products-.*\.js$/.test(name))) {
    const code = readFileSync(path.join(assets, file), "utf8");
    const local = /(\w+) as listProductsPageFn\b/.exec(code)?.[1];
    const id =
      local &&
      new RegExp(`\\b${local}=\\w+\\(\\)\\.handler\\(\\w+\\(\`([0-9a-f]+)\`\\)\\)`).exec(code)?.[1];
    if (id) return id;
  }
  throw new Error("listProductsPageFn's id was not found in the build");
}

async function run() {
  const pageFn = pageFnId();
  const { chromium } = await import(playwrightPath!);
  const browser = await chromium.launch({ executablePath: chromiumPath });
  const base = `http://127.0.0.1:${appPort}`;

  async function phone(lang: Lang, width: number, who: keyof typeof users) {
    const context = await browser.newContext({
      viewport: { width, height: 760 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: lang === "km" ? "km-KH" : "en-US",
    });
    await context.addCookies([
      { name: "sb-access-token", value: tokenFor(users[who]), url: base },
      // readCookieSession needs both; this run never refreshes (the gateway has no /token).
      { name: "sb-refresh-token", value: "harness-no-refresh", url: base },
      { name: "apsa_language", value: lang, url: base },
    ]);
    const page = await context.newPage();
    lastPage = page;
    page.on("console", (message: any) => {
      if (message.type() !== "error") return;
      const line = `${lang}@${width} ${message.text()} ${message.location()?.url ?? ""}`;
      const aborted =
        abortingPageReads && message.text().includes("ERR_FAILED") && line.includes(pageFn);
      (aborted ? expectedFailures : consoleErrors).push(line.slice(0, 300));
    });
    page.on("pageerror", (error: any) => consoleErrors.push(`${lang}@${width} ${String(error)}`));
    return { context, page };
  }

  /** On-screen text only: several lines are repeated in a screen-reader live region. */
  const seen = (page: any, text: string) => page.getByText(text).filter({ visible: true }).first();
  const rows = (page: any) => page.locator('main a[href^="/app/products/"]');
  const shot = (page: any, lang: Lang, width: number, label: string) =>
    page.screenshot({ path: path.join(out, `${lang}-${width}-${label}.png`), fullPage: false });

  async function layoutProblems(page: any): Promise<string[]> {
    return page.evaluate(() => {
      const problems: string[] = [];
      const root = document.documentElement;
      if (root.scrollWidth > root.clientWidth + 1) {
        problems.push(`page scrolls sideways: ${root.scrollWidth} > ${root.clientWidth}`);
      }
      for (const el of document.querySelectorAll<HTMLElement>(".chip-text, [role=tab], button")) {
        const style = getComputedStyle(el);
        if (style.textTransform === "uppercase") problems.push(`uppercase: ${el.textContent}`);
        const clipping = style.overflow === "hidden" || style.textOverflow === "ellipsis";
        if (clipping && el.scrollWidth > el.clientWidth + 1 && !el.closest("main a")) {
          problems.push(`clipped: "${(el.textContent ?? "").trim().slice(0, 40)}"`);
        }
      }
      for (const el of document.querySelectorAll<HTMLElement>("main a")) {
        const rect = el.getBoundingClientRect();
        if (rect.right > root.clientWidth + 1 || rect.left < -1) {
          problems.push(`row outside the screen: ${(el.textContent ?? "").slice(0, 40)}`);
        }
      }
      return problems;
    });
  }

  for (const lang of LANGS) {
    for (const width of WIDTHS) {
      const record = (name: string, ok: boolean, detail?: string, known?: string) =>
        checks.push({
          lang,
          width,
          name,
          ok,
          ...(detail ? { detail } : {}),
          ...(known && !ok ? { known } : {}),
        });

      // Loading: the first page held back for a moment.
      {
        const { context, page } = await phone(lang, width, "owner");
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        await page.route("**/_serverFn/**", async (route: any) => {
          if (route.request().url().includes(pageFn)) await gate;
          await route.continue();
        });
        await page.goto(`${base}/app/products`);
        await page.waitForSelector('[aria-busy="true"]', { timeout: 15000 });
        record("loading: the list is marked busy while the first page is read", true);
        await shot(page, lang, width, "loading");
        release();
        await rows(page).first().waitFor({ timeout: 15000 });
        await context.close();
      }

      // Error: the first page fails on the wire, then Try again.
      {
        const { context, page } = await phone(lang, width, "owner");
        let fail = true;
        abortingPageReads = true;
        await page.route("**/_serverFn/**", async (route: any) => {
          if (fail && route.request().url().includes(pageFn)) {
            await route.abort("failed");
          } else {
            await route.continue();
          }
        });
        await page.goto(`${base}/app/products`);
        await seen(page, s(lang, "catalog.list.error.title")).waitFor({ timeout: 15000 });
        record("error: first-load failure is said, with Try again", true);
        await shot(page, lang, width, "error");
        fail = false;
        abortingPageReads = false;
        await page
          .getByRole("button", { name: s(lang, "common.retry") })
          .first()
          .tap();
        await rows(page).first().waitFor({ timeout: 15000 });
        record("error: Try again loads the list", (await rows(page).count()) === 50);
        await context.close();
      }

      const { context, page } = await phone(lang, width, "owner");
      await page.goto(`${base}/app/products`);
      await rows(page).first().waitFor({ timeout: 20000 });
      record(
        "first page: 50 rows",
        (await rows(page).count()) === 50,
        String(await rows(page).count()),
      );
      const problems = await layoutProblems(page);
      record(
        "layout: no sideways scroll, clipped chip/tab/button or uppercase",
        problems.length === 0,
        problems.join("; "),
      );
      const longRow = rows(page).filter({ hasText: LONG_KM.slice(0, 12) });
      const longBox = await longRow.boundingBox();
      record(
        "long name: its row stays inside the screen",
        Boolean(longBox && longBox.x >= 0 && longBox.x + longBox.width <= width + 1),
      );
      // The TEXT, not just the row: every line of the Khmer name stays left of
      // the price and inside the row.
      const nameOverrun = await longRow.evaluate((row: HTMLElement) => {
        const name = row.querySelector('[lang="km"] .chip-text');
        const price = row.querySelector(".text-financial");
        if (!name || !price) return "name or price not found";
        const range = document.createRange();
        range.selectNodeContents(name);
        const priceBox = price.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        const lines = [...range.getClientRects()];
        const bad = lines.filter(
          (line) =>
            line.right > rowBox.right + 0.5 ||
            (line.right > priceBox.left + 0.5 &&
              line.top < priceBox.bottom &&
              line.bottom > priceBox.top),
        );
        return bad.length
          ? `${bad.length}/${lines.length} lines overrun (max right ${Math.round(Math.max(...bad.map((b) => b.right)))}, price left ${Math.round(priceBox.left)}, row right ${Math.round(rowBox.right)})`
          : "";
      });
      record(
        "long name: every line of the Khmer name clears the price and the row edge",
        nameOverrun === "",
        nameOverrun,
      );
      await shot(page, lang, width, "list");

      // Load more sits above the bottom navigation; tap it to the very end.
      const loadMore = page.getByRole("button", { name: s(lang, "catalog.list.loadMore") });
      await loadMore.scrollIntoViewIfNeeded();
      const nav = await page
        .locator(`nav[aria-label="${s(lang, "nav.primary")}"]:visible`)
        .boundingBox();
      const button = await loadMore.boundingBox();
      record(
        "Load more: fully above the bottom navigation, at least 44 px tall",
        Boolean(nav && button && button.y + button.height <= nav.y + 0.5 && button.height >= 44),
        JSON.stringify({ button, nav }),
      );
      await shot(page, lang, width, "load-more");
      let taps = 0;
      while ((await loadMore.count()) > 0 && taps < 10) {
        const before = await rows(page).count();
        await loadMore.tap();
        await page.waitForFunction(
          (n: number) => document.querySelectorAll('main a[href^="/app/products/"]').length > n,
          before,
          { timeout: 15000 },
        );
        taps += 1;
        await loadMore.waitFor({ state: "attached", timeout: 3000 }).catch(() => {});
      }
      record(
        "Load more: reaches all 232 active products (no 200 ceiling)",
        (await rows(page).count()) === 232,
        String(await rows(page).count()),
      );
      await seen(page, s(lang, "catalog.list.end.title")).waitFor({ timeout: 10000 });
      record("end of list is said", true);
      await seen(page, s(lang, "catalog.list.end.title")).scrollIntoViewIfNeeded();
      await shot(page, lang, width, "end");

      // Search: the oldest product, found only by its SKU, from the first page.
      await page.evaluate(() => window.scrollTo(0, 0));
      const box = page.locator('input[type="search"]');
      await box.tap();
      await box.fill("zx-90417");
      await page.waitForFunction(
        () => document.querySelectorAll('main a[href^="/app/products/"]').length === 1,
        undefined,
        { timeout: 15000 },
      );
      record(
        "search: the oldest product, by SKU, is the one result",
        (await rows(page).textContent())?.includes("ចាស់បំផុត") ?? false,
      );
      record(
        "search: the box keeps focus while the answer arrives",
        await box.evaluate((el: Element) => el === document.activeElement),
      );
      await shot(page, lang, width, "search-sku");

      await box.fill("zzzz-not-here");
      await seen(page, s(lang, "catalog.list.noMatches.title")).waitFor({ timeout: 15000 });
      record(
        "no matches: said, with Clear search",
        await page
          .getByRole("button", { name: s(lang, "catalog.list.noMatches.clear") })
          .isVisible(),
      );
      await shot(page, lang, width, "no-matches");
      await page.getByRole("button", { name: s(lang, "catalog.list.noMatches.clear") }).tap();
      await page.waitForFunction(
        () => document.querySelectorAll('main a[href^="/app/products/"]').length === 50,
        undefined,
        { timeout: 15000 },
      );
      record("Clear search: back to page one of the whole list", (await box.inputValue()) === "");

      // Category, then Archived + category: written labels, page one.
      await page.getByRole("button", { name: lang === "km" ? "ភេសជ្ជៈ" : "Drinks" }).tap();
      await page.waitForFunction(
        () => document.querySelectorAll('main a[href^="/app/products/"]').length === 38,
        undefined,
        { timeout: 15000 },
      );
      record("category: only its 38 active products", true);
      await page.getByRole("tab", { name: s(lang, "catalog.list.status.archived") }).tap();
      await page.waitForFunction(
        () => document.querySelectorAll('main a[href^="/app/products/"]').length === 1,
        undefined,
        { timeout: 15000 },
      );
      record("Archived + category: its one archived product", true);
      await shot(page, lang, width, "archived-category");

      // Keyboard: Tab reaches the status tabs with a visible focus ring.
      await page.keyboard.press("Tab");
      const focusVisible = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return false;
        const style = getComputedStyle(el);
        return style.outlineStyle !== "none" || style.boxShadow !== "none";
      });
      record("keyboard: the focused control shows a focus ring", focusVisible);

      // Add Product from the header, with the on-screen keyboard's room taken away.
      await page
        .getByRole("button", { name: s(lang, "catalog.list.addProduct") })
        .first()
        .tap();
      await page.locator("#product-name-km").waitFor({ timeout: 10000 });
      await page.locator("#product-name-km").tap();
      await page.setViewportSize({ width, height: 420 });
      const submit = page.getByRole("button", { name: s(lang, "catalog.list.addProduct") }).last();
      await submit.scrollIntoViewIfNeeded();
      const submitBox = await submit.boundingBox();
      record(
        "Add Product: its save button is reachable with ~340 px given to a keyboard",
        Boolean(submitBox && submitBox.y >= 0 && submitBox.y + submitBox.height <= 420),
        JSON.stringify(submitBox),
      );
      await shot(page, lang, width, "add-product-keyboard");
      await context.close();

      // First use: an empty KHR catalogue, its first-product guidance, and a KHR save.
      {
        const { context: firstContext, page: first } = await phone(
          lang,
          width,
          lang === "km" ? "newcomerKm" : "newcomerEn",
        );
        await first.goto(`${base}/app/products`);
        await seen(first, s(lang, "catalog.list.firstProduct.title")).waitFor({ timeout: 20000 });
        record("first use: the first-product guidance shows", true);
        record(
          "first use: no Load more / end-of-list claim",
          (await first.getByRole("button", { name: s(lang, "catalog.list.loadMore") }).count()) ===
            0,
        );
        await shot(first, lang, width, "first-product");
        // Saved once per language, on the last width, so every width sees it empty.
        if (width === WIDTHS.at(-1)) {
          // KHR has no minor unit (5000 = ៛5,000); USD is cents (5.00 = 500).
          const money =
            lang === "km"
              ? { typed: "5000", amount: 5000, currency: "KHR" }
              : { typed: "5", amount: 500, currency: "USD" };
          const name = `ទំនិញដំបូង ${lang}`;
          await first
            .getByRole("button", { name: s(lang, "catalog.list.firstProduct.action") })
            .tap();
          await first.locator("#product-name-km").fill(name);
          await first.locator("#product-price").fill(money.typed);
          await shot(first, lang, width, "first-product-sheet");
          await first
            .getByRole("button", { name: s(lang, "catalog.list.addProduct") })
            .last()
            .tap();
          await first
            .waitForFunction(
              () => document.querySelectorAll('main a[href^="/app/products/"]').length >= 1,
              undefined,
              { timeout: 20000 },
            )
            .catch(() => {});
          const saved = (await sql`
            select v.price_amount, v.price_currency from products p
              join product_variants v on v.product_id = p.id where p.name_km = ${name}`) as any[];
          record(
            `first use: saved in the business currency (${money.currency} ${money.amount} minor units)`,
            saved.length === 1 &&
              saved[0].price_currency === money.currency &&
              Number(saved[0].price_amount) === money.amount,
            JSON.stringify(saved),
          );
          await first.locator("#product-name-km").waitFor({ state: "detached", timeout: 10000 });
          await shot(first, lang, width, "first-product-saved");
        }
        await firstContext.close();
      }
    }
  }
  await browser.close();
}

let failed = false;
try {
  await seed();
  startGateway();
  await startApp();
  await run();
} catch (error) {
  failed = true;
  console.error(error);
  if (lastPage) {
    await lastPage.screenshot({ path: path.join(out, "failure.png") }).catch(() => {});
    writeFileSync(
      path.join(out, "failure.html"),
      `<!-- ${lastPage.url()} -->\n${await lastPage.content().catch(() => "")}`,
    );
  }
} finally {
  app?.kill("SIGTERM");
  gateway?.stop(true);
  front?.stop(true);
  await sql.close();
  await target.stop();
}

const failedChecks = checks.filter((check) => !check.ok && !check.known);
const knownChecks = checks.filter((check) => !check.ok && check.known);
writeFileSync(
  path.join(out, "results.json"),
  JSON.stringify({ versions: target.versions, checks, consoleErrors, expectedFailures }, null, 2),
);
console.info(
  `[products-mobile] ${checks.filter((c) => c.ok).length}/${checks.length} checks passed, ` +
    `${knownChecks.length} known pre-existing failures, ${failedChecks.length} new failures, ` +
    `${consoleErrors.length} console errors; evidence in ${out}`,
);
for (const check of knownChecks) {
  console.info(`  KNOWN ${check.lang}@${check.width} ${check.name}: ${check.detail ?? ""}`);
}
for (const check of failedChecks) {
  console.info(`  FAIL ${check.lang}@${check.width} ${check.name} ${check.detail ?? ""}`);
}
process.exit(failed || failedChecks.length > 0 || consoleErrors.length > 0 ? 1 : 0);
