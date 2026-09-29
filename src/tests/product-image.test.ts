/**
 * Product Images (V1) — focused coverage.
 *
 *   A. Shared rules      — accepted/rejected types, size, magic bytes, paths.
 *   B. Server contract   — upload / replace / remove against an in-memory
 *                          database and in-memory storage (no hosted Supabase).
 *   C. Tenant isolation  — cross-org product ids, foreign object paths.
 *   D. Safe ordering     — a failed upload/save never destroys the old image.
 *   E. Browser flow      — attach is only reached after a successful upload.
 *   F. UI integration    — list, detail, POS, both order pickers, fallback.
 *   G. Migration/locale  — schema safety, locale parity, no Thai, no hex colors.
 *
 * Hosted Storage itself (bucket limits, signed-URL behaviour, real object
 * lifecycle) cannot be exercised without staging credentials and is PENDING
 * STAGING QA — see docs/PRODUCT_IMAGES.md.
 *
 * Run: bun test src/tests/product-image.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { ForbiddenError } from "../server/auth/authorization";
import type { AuthorizationContext } from "../server/auth/authorization";
import {
  PRODUCT_IMAGE_MAX_BYTES,
  buildProductImagePath,
  checkDeclaredImage,
  isOwnedProductImagePath,
  sniffImageMime,
} from "../lib/product-image";
import {
  ProductImageError,
  classifyProductImageError,
  uploadProductImage,
  validatePickedFile,
  type UploadDeps,
} from "../lib/product-image-client";
import en from "../locales/en.json";
import km from "../locales/km.json";

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.resolve(ROOT, p), "utf8");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PRODUCT_A = "a0000000-0000-4000-8000-000000000001";
const PRODUCT_B = "b0000000-0000-4000-8000-000000000001";
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// ── Structurally valid minimal images (built, not captured) ─────────────────

const bytes = (...parts: Array<number[] | Uint8Array>) => {
  const out: number[] = [];
  for (const p of parts) out.push(...p);
  return new Uint8Array(out);
};
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const tag = (t: string) => Array.from(t, (c) => c.charCodeAt(0));

function crc32(data: number[]): number {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeJpeg(w = 64, h = 48): Uint8Array {
  const app0 = [0xff, 0xe0, ...be16(16), ...tag("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [
    0xff,
    0xc0,
    ...be16(17),
    8,
    ...be16(h),
    ...be16(w),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ];
  const sos = [0xff, 0xda, ...be16(12), 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0];
  return bytes([0xff, 0xd8], app0, sof, sos, [0x12, 0x34], [0xff, 0xd9]);
}

function makePng(w = 64, h = 48, opts: { badCrc?: boolean } = {}): Uint8Array {
  const ihdr = [...tag("IHDR"), ...be32(w), ...be32(h), 8, 2, 0, 0, 0];
  const crc = crc32(ihdr) ^ (opts.badCrc ? 1 : 0);
  const idat = [...tag("IDAT"), 0x78, 0x9c];
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    be32(13),
    ihdr,
    be32(crc >>> 0),
    be32(2),
    idat,
    be32(crc32(idat)),
    be32(0),
    tag("IEND"),
    be32(crc32(tag("IEND"))),
  );
}

function riff(...chunks: number[][]): Uint8Array {
  const body = chunks.flat();
  return bytes(tag("RIFF"), le32(4 + body.length), tag("WEBP"), body);
}
const vp8Chunk = (w: number, h: number) => [
  ...tag("VP8 "),
  ...le32(10),
  0x10,
  0,
  0,
  0x9d,
  0x01,
  0x2a,
  ...le16(w),
  ...le16(h),
];
const vp8lChunk = (w: number, h: number) => [
  ...tag("VP8L"),
  ...le32(5),
  0x2f,
  ...le32((w - 1) | ((h - 1) << 14)),
];
const vp8xChunk = (w: number, h: number, flags = 0) => [
  ...tag("VP8X"),
  ...le32(10),
  flags,
  0,
  0,
  0,
  (w - 1) & 0xff,
  ((w - 1) >> 8) & 0xff,
  ((w - 1) >> 16) & 0xff,
  (h - 1) & 0xff,
  ((h - 1) >> 8) & 0xff,
  ((h - 1) >> 16) & 0xff,
];
const makeWebp = (w = 64, h = 48) => riff(vp8Chunk(w, h));

const JPEG = makeJpeg();
const PNG = makePng();
const WEBP = makeWebp();
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
const HTML = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff, 0, 0]);
const GIF = new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000");

function makeCtx(organizationId: string, permissions: string[]): AuthorizationContext {
  const perms = new Set(permissions);
  return {
    userId: USER,
    organizationId,
    roleId: "role",
    systemRole: "MANAGER",
    permissions: perms,
    can: (key: string) => perms.has(key),
    require: (key: string) => {
      if (!perms.has(key)) throw new ForbiddenError(`Missing permission: ${key}`);
    },
    isOwner: () => false,
    requireOwner: () => {
      throw new ForbiddenError("Owner access required");
    },
  } as unknown as AuthorizationContext;
}

const editor = (org: string) => makeCtx(org, ["products.read", "products.update_basic"]);
const viewer = (org: string) => makeCtx(org, ["products.read"]);

// ── In-memory database (just enough PostgREST for the product repository) ────

type Row = Record<string, unknown>;

class FakeDb {
  products: Row[] = [];
  variants: Row[] = [];
  uploads: Row[] = [];
  failTicketWrites = false;
  failNextProductUpdate = false;
  log: string[] = [];

  private table(name: string): Row[] {
    if (name === "products") return this.products;
    if (name === "product_variants") return this.variants;
    if (name === "product_image_uploads") return this.uploads;
    return [];
  }

  /**
   * JS model of the migration-050 functions, so the service-level tests below
   * run without a database. The SQL itself (atomicity, locking, state machine)
   * is exercised against a real PGlite replay in product-image-lifecycle-sql.test.ts.
   */
  rpc(name: string, a: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> {
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const t = (v: unknown) => new Date(String(v)).getTime();
    const ok = (data: unknown) => Promise.resolve({ data, error: null });
    const down = () => Promise.resolve({ data: null, error: { message: "ticket db down" } });
    const find = (org: unknown, product: unknown, path: unknown) =>
      this.uploads.find(
        (r) => r.organization_id === org && r.product_id === product && r.object_path === path,
      );
    if (this.failTicketWrites) return down();
    if (name === "issue_product_image_upload_v1") {
      const live = this.uploads.filter(
        (r) => r.organization_id === a.p_org && r.state !== "consumed",
      );
      if (live.filter((r) => r.issued_by === a.p_user).length >= Number(a.p_member_cap)) {
        return ok("member_cap");
      }
      if (live.length >= Number(a.p_org_cap)) return ok("org_cap");
      this.uploads.push({
        id: `t${this.uploads.length + 1}-${Math.random()}`,
        organization_id: a.p_org,
        product_id: a.p_product,
        issued_by: a.p_user,
        object_path: a.p_path,
        state: "pending",
        expires_at: iso(now + Number(a.p_ttl_seconds) * 1000),
        cleanup_error_count: 0,
        cleanup_retry_after: null,
      });
      return ok("ok");
    }
    if (name === "claim_product_image_upload_v1") {
      const r = find(a.p_org, a.p_product, a.p_path);
      if (
        !r ||
        t(r.expires_at) <= now ||
        !(r.state === "pending" || (r.state === "claimed" && t(r.claim_expires_at) <= now))
      ) {
        return ok(null);
      }
      Object.assign(r, {
        state: "claimed",
        claimed_at: iso(now),
        claim_expires_at: iso(now + Number(a.p_claim_seconds) * 1000),
      });
      return ok(r.id);
    }
    if (name === "finalize_product_image_upload_v1") {
      const r = find(a.p_org, a.p_product, a.p_path);
      if (!r || r.state !== "claimed") return ok(null);
      if (this.failNextProductUpdate) {
        this.failNextProductUpdate = false;
        return Promise.resolve({ data: null, error: { message: "db down" } });
      }
      const prod = this.products.find((p) => p.id === a.p_product && p.organization_id === a.p_org);
      if (!prod) return Promise.resolve({ data: null, error: { message: "product not found" } });
      Object.assign(r, { state: "consumed", consumed_at: iso(now) });
      const prev = (prod.image_path as string | null) ?? "";
      prod.image_path = a.p_path;
      this.log.push("db.update");
      return ok(prev);
    }
    if (name === "take_product_image_upload_cleanup_v1") {
      const eligible = this.uploads
        .filter(
          (r) =>
            t(r.expires_at) <= now &&
            (r.state === "pending" ||
              (r.state === "claimed" && t(r.claim_expires_at) <= now) ||
              (r.state === "cleaning" && t(r.cleanup_retry_after) <= now)),
        )
        .sort(
          (x, y) =>
            Number(x.cleanup_error_count) - Number(y.cleanup_error_count) ||
            t(x.expires_at) - t(y.expires_at),
        )
        .slice(0, Number(a.p_limit));
      const out: Row[] = [];
      for (const r of eligible) {
        if (this.products.some((p) => p.image_path === r.object_path)) {
          Object.assign(r, { state: "consumed", consumed_at: iso(now) });
          continue;
        }
        Object.assign(r, {
          state: "cleaning",
          cleanup_retry_after: iso(now + Number(a.p_lease_seconds) * 1000),
        });
        out.push({ ...r });
      }
      return ok(out);
    }
    if (name === "fail_product_image_upload_cleanup_v1") {
      for (const r of this.uploads.filter((x) => (a.p_ids as string[]).includes(x.id as string))) {
        r.cleanup_error_count = Number(r.cleanup_error_count) + 1;
        r.cleanup_retry_after = iso(
          now + 5 * 60_000 * 2 ** Math.min(Number(r.cleanup_error_count) - 1, 6),
        );
      }
      return ok(null);
    }
    return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
  }

  from(name: string) {
    const rows = this.table(name);
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    let deleting = false;
    let limitN = Infinity;
    const matches = () => rows.filter((r) => filters.every((f) => f(r)));
    const settle = () => {
      if (name === "product_image_uploads" && this.failTicketWrites) {
        return { data: null, error: { message: "ticket db down" } };
      }
      if (deleting) {
        const hit = matches();
        for (const r of hit) rows.splice(rows.indexOf(r), 1);
        return { data: null, error: null };
      }
      if (patch) {
        if (name === "products" && this.failNextProductUpdate) {
          this.failNextProductUpdate = false;
          return { data: null, error: { message: "db down" } };
        }
        const hit = matches();
        for (const r of hit) Object.assign(r, patch);
        if (name === "products") this.log.push("db.update");
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      return {
        data: matches()
          .slice(0, limitN)
          .map((r) => ({ ...r })),
        error: null,
      };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      update: (p: Row) => {
        patch = p;
        return q;
      },
      insert: (row: Row) => {
        if (name === "product_image_uploads" && this.failTicketWrites) {
          return Promise.resolve({ data: null, error: { message: "ticket db down" } });
        }
        rows.push({ id: `t${rows.length + 1}-${Math.random()}`, ...row });
        return Promise.resolve({ data: null, error: null });
      },
      delete: () => {
        deleting = true;
        return q;
      },
      gt: (col: string, val: unknown) => {
        filters.push((r) => String(r[col]) > String(val));
        return q;
      },
      lte: (col: string, val: unknown) => {
        filters.push((r) => String(r[col]) <= String(val));
        return q;
      },
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return q;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return q;
      },
      order: () => q,
      limit: (n: number) => {
        limitN = n;
        return q;
      },
      range: () => q,
      single: async () => {
        const res = settle();
        if (res.error) return res;
        const first = (res.data as Row[])[0];
        return first
          ? { data: first, error: null }
          : { data: null, error: { code: "PGRST116", message: "0 rows" } };
      },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
    };
    return q;
  }
}

function productRow(id: string, org: string, imagePath: string | null = null): Row {
  return {
    id,
    organization_id: org,
    workspace_id: null,
    name_km: "ផលិតផល",
    name_en: "Item",
    description_km: null,
    description_en: null,
    category_id: null,
    status: "ACTIVE",
    image_path: imagePath,
    image_updated_at: null,
    created_by: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

// ── In-memory storage ────────────────────────────────────────────────────────

class FakeStorage {
  objects = new Map<string, { head: Uint8Array; sizeBytes: number }>();
  removed: string[] = [];
  failRemove = false;
  failSign = false;
  failInspect = false;
  events: string[] = [];

  put(p: string, head: Uint8Array, sizeBytes = head.length) {
    this.objects.set(p, { head, sizeBytes });
  }
  async createUpload(p: string) {
    return { signedUrl: `https://storage.test/upload?token=t&p=${encodeURIComponent(p)}`, path: p };
  }
  async createReadUrls(paths: string[]) {
    if (this.failSign) throw new Error("sign down");
    return new Map(paths.map((p) => [p, `https://storage.test/read/${p}?token=x`]));
  }
  async inspect(p: string) {
    if (this.failInspect) throw new Error("inspect down");
    return this.objects.get(p) ?? null;
  }
  async remove(paths: string[]) {
    this.events.push(`remove:${paths.join(",")}`);
    if (this.failRemove) throw new Error("remove down");
    for (const p of paths) {
      this.objects.delete(p);
      this.removed.push(p);
    }
  }
}

let db: FakeDb;
let storage: FakeStorage;
let restoreDb: () => void;
let restoreStorage: () => void;
let restoreLimiter: () => void;

async function svc() {
  return import("../server/products/image-service");
}

beforeEach(async () => {
  db = new FakeDb();
  storage = new FakeStorage();
  db.products.push(productRow(PRODUCT_A, ORG_A), productRow(PRODUCT_B, ORG_B));
  const repo = await import("../server/products/repository");
  const st = await import("../server/products/image-storage");
  restoreDb = repo.setProductRepositoryDbForTests(db);
  restoreStorage = st.setProductImageStorageForTests(storage);
  // Record storage/db ordering in one timeline.
  db.log = storage.events;
  // A fresh in-memory limiter store per test stands in for the durable one.
  const lim = await import("../server/rate-limit/limiter");
  const store = await import("../server/rate-limit/store");
  restoreLimiter = lim.setPrimaryRateLimitStore(new store.MemoryRateLimitStore());
});

afterEach(() => {
  restoreDb();
  restoreStorage();
  restoreLimiter();
});

const rowOf = (id: string) => db.products.find((r) => r.id === id)!;

/** Full happy path helper: ticket → bytes land in storage → attach. */
async function uploadFor(
  ctx: AuthorizationContext,
  productId: string,
  bytes: Uint8Array,
  mime = "image/jpeg",
) {
  const s = await svc();
  const ticket = await s.requestProductImageUpload(ctx, productId, {
    mimeType: mime,
    sizeBytes: bytes.length,
  });
  storage.put(ticket.path, bytes);
  return { ticket, attach: () => s.attachProductImage(ctx, productId, ticket.path) };
}

// ══ A. Shared rules ═══════════════════════════════════════════════════════════

describe("A. shared image rules", () => {
  it("accepts JPEG, PNG and WebP within the size limit", () => {
    for (const mimeType of ["image/jpeg", "image/png", "image/webp"]) {
      expect(checkDeclaredImage({ mimeType, sizeBytes: 1000 })).toMatchObject({ ok: true });
    }
  });

  it("rejects SVG, HTML, executables, GIF and unknown types", () => {
    for (const mimeType of [
      "image/svg+xml",
      "text/html",
      "application/x-msdownload",
      "application/octet-stream",
      "image/gif",
      "application/pdf",
      "",
    ]) {
      expect(checkDeclaredImage({ mimeType, sizeBytes: 1000 })).toEqual({
        ok: false,
        kind: "unsupported_type",
      });
    }
  });

  it("gives HEIC/HEIF its own clear reason (by type OR extension)", () => {
    expect(checkDeclaredImage({ mimeType: "image/heic", sizeBytes: 10 })).toEqual({
      ok: false,
      kind: "heic_unsupported",
    });
    expect(
      checkDeclaredImage({ mimeType: "image/jpeg", sizeBytes: 10, fileName: "IMG_1.HEIC" }),
    ).toEqual({ ok: false, kind: "heic_unsupported" });
  });

  it("rejects empty and oversized files", () => {
    expect(checkDeclaredImage({ mimeType: "image/png", sizeBytes: 0 })).toEqual({
      ok: false,
      kind: "empty",
    });
    expect(
      checkDeclaredImage({ mimeType: "image/png", sizeBytes: PRODUCT_IMAGE_MAX_BYTES + 1 }),
    ).toEqual({ ok: false, kind: "too_large" });
    expect(
      checkDeclaredImage({ mimeType: "image/png", sizeBytes: PRODUCT_IMAGE_MAX_BYTES }),
    ).toMatchObject({ ok: true });
  });

  it("identifies real format by magic bytes, not by name or declared type", () => {
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
    for (const bad of [SVG, HTML, EXE, GIF, new Uint8Array([]), new Uint8Array([0xff, 0xd8])]) {
      expect(sniffImageMime(bad)).toBeNull();
    }
  });

  it("generates object paths inside <org>/<product>/ and never from a filename", () => {
    const objectId = "d0000000-0000-4000-8000-000000000009";
    const p = buildProductImagePath(ORG_A, PRODUCT_A, objectId, "image/webp");
    expect(p).toBe(`${ORG_A}/${PRODUCT_A}/${objectId}.webp`);
    expect(() => buildProductImagePath("../x", PRODUCT_A, objectId, "image/png")).toThrow();
  });

  it("owns only the exact server-generated shape in the caller's org+product", () => {
    const id = "d0000000-0000-4000-8000-000000000009";
    const good = `${ORG_A}/${PRODUCT_A}/${id}.jpg`;
    expect(isOwnedProductImagePath(good, ORG_A, PRODUCT_A)).toBe(true);
    for (const bad of [
      `${ORG_B}/${PRODUCT_A}/${id}.jpg`, // other org
      `${ORG_A}/${PRODUCT_B}/${id}.jpg`, // other product
      `${ORG_A}/${PRODUCT_A}/../${PRODUCT_B}/${id}.jpg`, // traversal
      `${ORG_A}/${PRODUCT_A}/photo.jpg`, // raw filename
      `${ORG_A}/${PRODUCT_A}/${id}.svg`, // svg
      `${ORG_A}/${PRODUCT_A}/${id}.jpg/extra`, // extra segment
      `/${good}`,
      `${good}\n`,
      `${good}?x=1`,
      "",
    ]) {
      expect(isOwnedProductImagePath(bad, ORG_A, PRODUCT_A)).toBe(false);
    }
    expect(isOwnedProductImagePath(undefined, ORG_A, PRODUCT_A)).toBe(false);
  });
});

// ══ B. Server contract ════════════════════════════════════════════════════════

describe("B. upload / replace / remove", () => {
  it("valid upload: server path under org/product, attach sets the reference", async () => {
    const { ticket, attach } = await uploadFor(editor(ORG_A), PRODUCT_A, JPEG);
    expect(ticket.path.startsWith(`${ORG_A}/${PRODUCT_A}/`)).toBe(true);
    expect(ticket.path.endsWith(".jpg")).toBe(true);
    expect(ticket.uploadUrl).toContain("token=");

    const res = await attach();
    expect(res.imageUrl).toContain("https://storage.test/read/");
    expect(rowOf(PRODUCT_A)["image_path"]).toBe(ticket.path);
  });

  it("never lets a client filename into the object path", async () => {
    const s = await svc();
    const ticket = await s.requestProductImageUpload(editor(ORG_A), PRODUCT_A, {
      mimeType: "image/png",
      sizeBytes: 100,
      fileName: "../../etc/passwd<script>.png",
    });
    expect(ticket.path).not.toContain("passwd");
    expect(ticket.path).not.toContain("..");
    expect(isOwnedProductImagePath(ticket.path, ORG_A, PRODUCT_A)).toBe(true);
  });

  it("rejects invalid MIME, HEIC and oversize at request time", async () => {
    const s = await svc();
    const ctx = editor(ORG_A);
    await expect(
      s.requestProductImageUpload(ctx, PRODUCT_A, { mimeType: "image/svg+xml", sizeBytes: 10 }),
    ).rejects.toThrow(/Unsupported image type/);
    await expect(
      s.requestProductImageUpload(ctx, PRODUCT_A, { mimeType: "image/heic", sizeBytes: 10 }),
    ).rejects.toThrow(/HEIC/);
    await expect(
      s.requestProductImageUpload(ctx, PRODUCT_A, {
        mimeType: "image/png",
        sizeBytes: PRODUCT_IMAGE_MAX_BYTES + 1,
      }),
    ).rejects.toThrow(/too large/);
    expect(rowOf(PRODUCT_A)["image_path"]).toBeNull();
  });

  it("re-sniffs the real bytes: SVG/HTML/EXE uploaded under an image name is refused and deleted", async () => {
    for (const evil of [SVG, HTML, EXE, GIF]) {
      const { ticket, attach } = await uploadFor(editor(ORG_A), PRODUCT_A, evil, "image/jpeg");
      await expect(attach()).rejects.toThrow(/not a valid/);
      expect(rowOf(PRODUCT_A)["image_path"]).toBeNull();
      expect(storage.removed).toContain(ticket.path);
    }
  });

  it("re-checks real object size against the limit", async () => {
    const { ticket, attach } = await uploadFor(editor(ORG_A), PRODUCT_A, JPEG);
    storage.put(ticket.path, JPEG, PRODUCT_IMAGE_MAX_BYTES + 1);
    await expect(attach()).rejects.toThrow(/too large/);
    expect(rowOf(PRODUCT_A)["image_path"]).toBeNull();
  });

  it("attach without a real uploaded object is refused", async () => {
    const s = await svc();
    const ticket = await s.requestProductImageUpload(editor(ORG_A), PRODUCT_A, {
      mimeType: "image/png",
      sizeBytes: 10,
    });
    await expect(s.attachProductImage(editor(ORG_A), PRODUCT_A, ticket.path)).rejects.toThrow(
      /could not be verified/,
    );
    expect(rowOf(PRODUCT_A)["image_path"]).toBeNull();
  });

  it("replace: product points at the new image, THEN the old object is deleted", async () => {
    const first = await uploadFor(editor(ORG_A), PRODUCT_A, JPEG);
    await first.attach();
    storage.events.length = 0;

    const second = await uploadFor(editor(ORG_A), PRODUCT_A, PNG, "image/png");
    await second.attach();

    expect(rowOf(PRODUCT_A)["image_path"]).toBe(second.ticket.path);
    expect(storage.objects.has(first.ticket.path)).toBe(false);
    expect(storage.objects.has(second.ticket.path)).toBe(true);
    // Ordering: the DB update precedes the old-object delete.
    expect(storage.events.indexOf("db.update")).toBeLessThan(
      storage.events.indexOf(`remove:${first.ticket.path}`),
    );
  });

  it("remove: clears the reference first, then deletes the object", async () => {
    const up = await uploadFor(editor(ORG_A), PRODUCT_A, WEBP, "image/webp");
    await up.attach();
    storage.events.length = 0;

    const s = await svc();
    expect(await s.removeProductImage(editor(ORG_A), PRODUCT_A)).toEqual({ imageUrl: null });
    expect(rowOf(PRODUCT_A)["image_path"]).toBeNull();
    expect(storage.objects.has(up.ticket.path)).toBe(false);
    expect(storage.events.indexOf("db.update")).toBeLessThan(
      storage.events.indexOf(`remove:${up.ticket.path}`),
    );
  });

  it("remove on a product with no image is a harmless no-op", async () => {
    const s = await svc();
    expect(await s.removeProductImage(editor(ORG_A), PRODUCT_A)).toEqual({ imageUrl: null });
    expect(storage.events).toEqual([]);
  });
});

// ══ permissions ══════════════════════════════════════════════════════════════

describe("permissions: products.update_basic gates every write path", () => {
  it("a view-only member gets no upload, attach or delete path", async () => {
    const s = await svc();
    const admin = await uploadFor(editor(ORG_A), PRODUCT_A, JPEG);
    await admin.attach();
    const before = rowOf(PRODUCT_A)["image_path"];
    storage.events.length = 0;

    const v = viewer(ORG_A);
    await expect(
      s.requestProductImageUpload(v, PRODUCT_A, { mimeType: "image/png", sizeBytes: 5 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.attachProductImage(v, PRODUCT_A, admin.ticket.path)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(s.removeProductImage(v, PRODUCT_A)).rejects.toBeInstanceOf(ForbiddenError);

    expect(rowOf(PRODUCT_A)["image_path"]).toBe(before);
    expect(storage.events).toEqual([]);
    expect(storage.objects.has(admin.ticket.path)).toBe(true);
  });

  it("a member with no permissions at all is denied", async () => {
    const s = await svc();
    await expect(
      s.requestProductImageUpload(makeCtx(ORG_A, []), PRODUCT_A, {
        mimeType: "image/png",
        sizeBytes: 5,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ══ C. Tenant isolation ══════════════════════════════════════════════════════

describe("C. tenant isolation", () => {
  it("org A cannot request an upload, attach or remove on org B's product (404)", async () => {
    const s = await svc();
    const b = await uploadFor(editor(ORG_B), PRODUCT_B, JPEG);
    await b.attach();
    const bPath = rowOf(PRODUCT_B)["image_path"];
    storage.events.length = 0;

    const a = editor(ORG_A);
    await expect(
      s.requestProductImageUpload(a, PRODUCT_B, { mimeType: "image/png", sizeBytes: 5 }),
    ).rejects.toThrow(/Product not found/);
    await expect(s.attachProductImage(a, PRODUCT_B, b.ticket.path)).rejects.toThrow(
      /Product not found/,
    );
    await expect(s.removeProductImage(a, PRODUCT_B)).rejects.toThrow(/Product not found/);

    expect(rowOf(PRODUCT_B)["image_path"]).toBe(bPath);
    expect(storage.objects.has(b.ticket.path)).toBe(true);
    expect(storage.events).toEqual([]);
  });

  it("org A cannot attach org B's object path to its OWN product, and B's object survives", async () => {
    const s = await svc();
    const b = await uploadFor(editor(ORG_B), PRODUCT_B, JPEG);
    await b.attach();
    storage.events.length = 0;

    await expect(s.attachProductImage(editor(ORG_A), PRODUCT_A, b.ticket.path)).rejects.toThrow(
      /could not be verified/,
    );
    expect(rowOf(PRODUCT_A)["image_path"]).toBeNull();
    expect(storage.objects.has(b.ticket.path)).toBe(true);
    // The foreign object was not even probed or deleted.
    expect(storage.events).toEqual([]);
  });

  it("cannot attach a sibling product's object or a path with traversal/extra segments", async () => {
    const s = await svc();
    db.products.push(productRow("a0000000-0000-4000-8000-000000000002", ORG_A));
    const sibling = await uploadFor(editor(ORG_A), "a0000000-0000-4000-8000-000000000002", JPEG);
    await sibling.attach();
    for (const p of [
      sibling.ticket.path,
      `${ORG_A}/${PRODUCT_A}/../${PRODUCT_B}/x.jpg`,
      `${ORG_A}/${PRODUCT_A}/photo.jpg`,
      "",
    ]) {
      await expect(s.attachProductImage(editor(ORG_A), PRODUCT_A, p)).rejects.toThrow();
    }
    expect(rowOf(PRODUCT_A)["image_path"]).toBeNull();
    expect(storage.objects.has(sibling.ticket.path)).toBe(true);
  });

  it("the org always comes from the context — the upload namespace is never client-chosen", async () => {
    const s = await svc();
    const ticket = await s.requestProductImageUpload(editor(ORG_A), PRODUCT_A, {
      mimeType: "image/jpeg",
      sizeBytes: 5,
    });
    expect(ticket.path.startsWith(`${ORG_A}/`)).toBe(true);
    expect(ticket.path).not.toContain(ORG_B);
  });
});

// ══ D. Safe ordering ═════════════════════════════════════════════════════════

describe("D. a failed replace never destroys the existing image", () => {
  async function withExisting() {
    const first = await uploadFor(editor(ORG_A), PRODUCT_A, JPEG);
    await first.attach();
    storage.events.length = 0;
    storage.removed.length = 0;
    return first;
  }

  it("new upload never lands (attach without object): old image kept, nothing deleted", async () => {
    const first = await withExisting();
    const s = await svc();
    const ticket = await s.requestProductImageUpload(editor(ORG_A), PRODUCT_A, {
      mimeType: "image/png",
      sizeBytes: 5,
    });
    await expect(s.attachProductImage(editor(ORG_A), PRODUCT_A, ticket.path)).rejects.toThrow();
    expect(rowOf(PRODUCT_A)["image_path"]).toBe(first.ticket.path);
    expect(storage.objects.has(first.ticket.path)).toBe(true);
    expect(storage.removed).toEqual([]);
  });

  it("new object is corrupt: refused, old image kept", async () => {
    const first = await withExisting();
    const bad = await uploadFor(editor(ORG_A), PRODUCT_A, SVG, "image/png");
    await expect(bad.attach()).rejects.toThrow();
    expect(rowOf(PRODUCT_A)["image_path"]).toBe(first.ticket.path);
    expect(storage.objects.has(first.ticket.path)).toBe(true);
  });

  it("save fails AFTER a good upload: product keeps the old image; the upload stays retryable", async () => {
    const first = await withExisting();
    const next = await uploadFor(editor(ORG_A), PRODUCT_A, PNG, "image/png");
    db.failNextProductUpdate = true;
    await expect(next.attach()).rejects.toThrow(/Could not save the photo/);
    expect(rowOf(PRODUCT_A)["image_path"]).toBe(first.ticket.path);
    expect(storage.objects.has(first.ticket.path)).toBe(true);
    // Transient failure: the object is kept and the claim released, so the
    // same upload can be attached on retry (no permanent consume, no orphan).
    expect(storage.objects.has(next.ticket.path)).toBe(true);
    expect(db.uploads.find((r) => r.object_path === next.ticket.path)?.state).toBe("pending");
    await next.attach();
    expect(rowOf(PRODUCT_A)["image_path"]).toBe(next.ticket.path);
  });

  it("storage verification outage: old image kept, nothing deleted", async () => {
    const first = await withExisting();
    const next = await uploadFor(editor(ORG_A), PRODUCT_A, PNG, "image/png");
    storage.failInspect = true;
    await expect(next.attach()).rejects.toThrow(/Could not verify/);
    expect(rowOf(PRODUCT_A)["image_path"]).toBe(first.ticket.path);
    expect(storage.objects.has(first.ticket.path)).toBe(true);
  });

  it("old-object cleanup failure leaves an orphan, never a corrupted product", async () => {
    const first = await withExisting();
    const next = await uploadFor(editor(ORG_A), PRODUCT_A, PNG, "image/png");
    storage.failRemove = true;
    const res = await next.attach();
    expect(res.imageUrl).not.toBeNull();
    expect(rowOf(PRODUCT_A)["image_path"]).toBe(next.ticket.path);
    expect(storage.objects.has(first.ticket.path)).toBe(true); // orphan, documented
  });

  it("remove: DB failure keeps the image and its object", async () => {
    const first = await withExisting();
    db.failNextProductUpdate = true;
    const s = await svc();
    await expect(s.removeProductImage(editor(ORG_A), PRODUCT_A)).rejects.toThrow(
      /Could not remove the photo/,
    );
    expect(rowOf(PRODUCT_A)["image_path"]).toBe(first.ticket.path);
    expect(storage.objects.has(first.ticket.path)).toBe(true);
  });

  it("remove: object-delete failure still succeeds (reference already cleared)", async () => {
    const first = await withExisting();
    storage.failRemove = true;
    const s = await svc();
    expect(await s.removeProductImage(editor(ORG_A), PRODUCT_A)).toEqual({ imageUrl: null });
    expect(rowOf(PRODUCT_A)["image_path"]).toBeNull();
    expect(storage.objects.has(first.ticket.path)).toBe(true); // orphan, documented
  });

  it("errors shown to callers are fixed APSA messages — no provider text or paths", async () => {
    const first = await withExisting();
    const next = await uploadFor(editor(ORG_A), PRODUCT_A, PNG, "image/png");
    db.failNextProductUpdate = true;
    const err = await next.attach().catch((e: Error) => e);
    expect((err as Error).message).not.toContain("db down");
    expect((err as Error).message).not.toContain(ORG_A);
    expect((err as Error).message).not.toContain(first.ticket.path);
  });
});

// ══ product reads ════════════════════════════════════════════════════════════

describe("product reads: imageUrl", () => {
  it("a product without an image reads imageUrl null and never touches storage", async () => {
    const { getProductCatalog } = await import("../server/products/service");
    let signed = 0;
    const orig = storage.createReadUrls.bind(storage);
    storage.createReadUrls = async (p: string[]) => {
      signed += 1;
      return orig(p);
    };
    const list = await getProductCatalog(editor(ORG_A));
    expect(list).toHaveLength(1);
    expect(list[0]!.imageUrl).toBeNull();
    expect(signed).toBe(0);
  });

  it("signs URLs, never exposes the storage path, and is org-scoped", async () => {
    const up = await uploadFor(editor(ORG_A), PRODUCT_A, JPEG);
    await up.attach();
    const { getProductCatalog, getProductDetail } = await import("../server/products/service");
    const list = await getProductCatalog(editor(ORG_A));
    expect(list).toHaveLength(1); // org B's product is not in org A's catalog
    expect(list[0]!.imageUrl).toContain("token=");
    const json = JSON.stringify(list);
    expect(json).not.toContain("image_path");
    expect(json).not.toContain("imagePath");
    const detail = await getProductDetail(viewer(ORG_A), PRODUCT_A);
    expect(detail.imageUrl).toContain("token=");
    await expect(getProductDetail(viewer(ORG_A), PRODUCT_B)).rejects.toThrow(/not found/);
  });

  it("a signing outage degrades to the placeholder — the catalog still loads", async () => {
    const up = await uploadFor(editor(ORG_A), PRODUCT_A, JPEG);
    await up.attach();
    storage.failSign = true;
    const { getProductCatalog } = await import("../server/products/service");
    const list = await getProductCatalog(editor(ORG_A));
    expect(list[0]!.imageUrl).toBeNull();
    expect(list[0]!.id).toBe(PRODUCT_A);
  });
});

// ══ E. Browser flow ══════════════════════════════════════════════════════════

describe("E. browser upload flow", () => {
  const prepared = { blob: new Blob([JPEG], { type: "image/jpeg" }), mime: "image/jpeg" as const };

  function deps(overrides: Partial<UploadDeps> = {}) {
    const calls: string[] = [];
    const d: UploadDeps = {
      requestUpload: async () => {
        calls.push("request");
        return { path: "p", uploadUrl: "u" };
      },
      putObject: async (_u, _b, onProgress) => {
        calls.push("put");
        onProgress(1);
      },
      attach: async () => {
        calls.push("attach");
        return { imageUrl: "https://x/y" };
      },
      ...overrides,
    };
    return { d, calls };
  }

  it("runs request → put → attach in order", async () => {
    const { d, calls } = deps();
    const res = await uploadProductImage("pid", prepared, "a.jpg", { deps: d });
    expect(res.imageUrl).toBe("https://x/y");
    expect(calls).toEqual(["request", "put", "attach"]);
  });

  it("an interrupted upload never reaches attach (existing image untouched)", async () => {
    const { d, calls } = deps({
      putObject: async () => {
        calls.push("put");
        throw new ProductImageError("network");
      },
    });
    await expect(uploadProductImage("pid", prepared, undefined, { deps: d })).rejects.toThrow();
    expect(calls).toEqual(["request", "put"]);
  });

  it("a refused ticket never uploads", async () => {
    const { d, calls } = deps({
      requestUpload: async () => {
        calls.push("request");
        throw new Error("Missing permission: products.update_basic");
      },
    });
    await expect(uploadProductImage("pid", prepared, undefined, { deps: d })).rejects.toThrow();
    expect(calls).toEqual(["request"]);
  });

  it("classifies every failure into a fixed kind with locale copy", () => {
    const cases: Array<[unknown, string]> = [
      [new Error("Missing permission: products.update_basic"), "forbidden"],
      [new Error("Product not found"), "not_found"],
      [new Error("HEIC photos are not supported yet."), "heic_unsupported"],
      [new Error("Unsupported image type. Use…"), "unsupported_type"],
      [new Error("This image is too large."), "too_large"],
      [new Error("This file is not a valid JPEG, PNG or WebP image."), "corrupt"],
      [new Error("Could not save the photo. Please try again."), "save_failed"],
      [new Error("Could not remove the photo. Please try again."), "remove_failed"],
      [new TypeError("Failed to fetch"), "network"],
      [new ProductImageError("corrupt"), "corrupt"],
      [new Error("some raw storage error with a secret"), "upload_failed"],
    ];
    for (const [err, kind] of cases) expect(classifyProductImageError(err)).toBe(kind);
    const errors = (en as unknown as { catalog: { image: { error: Record<string, string> } } })
      .catalog.image.error;
    for (const [, kind] of cases) expect(errors[kind]).toBeTruthy();
  });

  it("validates a picked file before any bytes move", () => {
    expect(validatePickedFile({ type: "image/jpeg", size: 100, name: "a.jpg" })).toBe("image/jpeg");
    expect(() => validatePickedFile({ type: "image/svg+xml", size: 100 })).toThrow();
    expect(() => validatePickedFile({ type: "image/heic", size: 100 })).toThrow();
    expect(() => validatePickedFile({ type: "image/png", size: 16 * 1024 * 1024 })).toThrow();
  });
});

// ══ F. UI integration ════════════════════════════════════════════════════════

describe("F. UI integration (structural)", () => {
  it("ProductImage never renders a broken image: onError → placeholder, lazy, sized box", () => {
    const src = read("src/components/products/ProductImage.tsx");
    expect(src).toContain("onError");
    expect(src).toContain('loading={eager ? "eager" : "lazy"}');
    expect(src).toContain("object-cover");
    expect(src).toContain('data-product-image="fallback"');
    expect(src).toContain("Package");
  });

  it("product list, detail, POS, Create Order and Inbox → Order all show the thumbnail", () => {
    expect(read("src/routes/app.products.tsx")).toContain("<ProductImage src={product.imageUrl}");
    expect(read("src/routes/app.products.$id.tsx")).toContain("<ProductImageField");
    expect(read("src/components/pos/PosProductList.tsx")).toContain("src={product.imageUrl}");
    expect(read("src/components/orders/CreateRealOrderSheet.tsx")).toContain(
      "<ProductImage src={item.imageUrl}",
    );
    const prep = read("src/components/inbox/PrepareOrderSheet.tsx");
    expect(prep).toContain("<ProductImage src={candidate.imageUrl}");
    expect(prep).toContain("<ProductImage src={product.imageUrl}");
    expect(read("src/components/inbox/CreateOrderSheet.tsx")).toContain(
      "<ProductImage src={item.imageUrl}",
    );
  });

  it("POS keeps its colour-tile fallback so a failing image never blocks a sale", () => {
    const pos = read("src/components/pos/PosProductList.tsx");
    expect(pos).toContain("fallback={");
    expect(pos).toContain("COMPANION_VAR[product.companion]");
    // Selection still passes the product, never anything derived from the image.
    expect(pos).toContain("onSelect(product)");
    expect(pos).not.toMatch(/imageUrl[^\n]*(id|sku|variant)/i);
  });

  it("product identity never derives from an image URL or filename", () => {
    for (const f of [
      "src/lib/api/index.ts",
      "src/components/orders/CreateRealOrderSheet.tsx",
      "src/components/inbox/PrepareOrderSheet.tsx",
      "src/lib/pos-cart.ts",
    ]) {
      const s = read(f);
      expect(s).not.toMatch(/(variantId|productId|sku)\s*[:=][^\n]*imageUrl/);
      expect(s).not.toMatch(/imageUrl[^\n]*\.(split|match|replace)\(/);
    }
  });

  it("the edit field is offered only with products.update_basic; create sheet gates the picker", () => {
    const detail = read("src/routes/app.products.$id.tsx");
    expect(detail).toContain("canEdit={canUpdateBasic && !archived}");
    const list = read("src/routes/app.products.tsx");
    expect(list).toContain('capabilities.can("products.update_basic")');
    expect(read("src/components/products/CreateProductSheet.tsx")).toContain("canSetPhoto ? (");
  });

  it("the field offers choose, take (camera), replace and remove, and blocks double submit", () => {
    const f = read("src/components/products/ProductImageField.tsx");
    expect(f).toContain('capture="environment"');
    expect(f).toContain("catalog.image.replace");
    expect(f).toContain("catalog.image.remove");
    expect(f).toContain("catalog.image.retry");
    expect(f).toContain("inFlight.current");
    expect(f).toContain("PRODUCT_IMAGE_ACCEPT");
    expect(f).not.toContain('accept="image/*"');
  });

  it("browser code never imports server modules or the service key", () => {
    for (const f of [
      "src/lib/product-image.ts",
      "src/lib/product-image-client.ts",
      "src/components/products/ProductImage.tsx",
      "src/components/products/ProductImageField.tsx",
    ]) {
      const s = read(f);
      expect(s).not.toMatch(/from\s+["']@\/server\//);
      expect(s).not.toMatch(/from\s+["']@\/lib\/supabase\/server["']/);
      expect(s).not.toContain("SERVICE_ROLE");
      expect(s).not.toContain("supabaseAdmin");
    }
    expect(read("src/api/products.ts")).not.toMatch(
      /^import .*server\/products\/image-(service|storage)/m,
    );
  });

  it("no hard-coded hex colours or uppercase transforms in the new components", () => {
    for (const f of [
      "src/components/products/ProductImage.tsx",
      "src/components/products/ProductImageField.tsx",
    ]) {
      const s = read(f);
      expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(s).not.toMatch(/uppercase/);
    }
  });
});

// ══ G. Migration + locale ════════════════════════════════════════════════════

describe("G. migration 048 and locales", () => {
  const sql = () => read("supabase/migrations/048_product_images.sql");

  it("adds a nullable single image reference bound to the row's own org and product", () => {
    const s = sql();
    expect(s).toMatch(/ADD COLUMN image_path TEXT/);
    expect(s).toContain("products_image_path_owned");
    expect(s).toContain("organization_id::text");
    expect(s).toContain("(jpg|png|webp)");
    expect(s).toContain("uniq_products_image_path");
  });

  it("creates a PRIVATE bucket limited to 5 MiB and JPEG/PNG/WebP (no SVG/HTML)", () => {
    const s = sql();
    expect(s).toContain("'product-images'");
    expect(s).toMatch(/false,\s*\n\s*5242880/);
    expect(s).toContain("to_regclass('storage.buckets')");
    expect(s).toContain("ARRAY['image/jpeg', 'image/png', 'image/webp']");
    const executable = s
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(executable.toLowerCase()).not.toContain("svg");
    expect(executable.toLowerCase()).not.toContain("html");
    expect(s).not.toMatch(/public\s*=\s*true/i);
    // No browser-facing storage policies: default-deny for anon/authenticated.
    expect(s).not.toMatch(/CREATE POLICY/i);
  });

  it("is repo-only: not recorded as hosted/applied", () => {
    const lockPath = path.resolve(ROOT, "supabase/hosted-migrations.lock.json");
    if (fs.existsSync(lockPath)) {
      expect(fs.readFileSync(lockPath, "utf8")).not.toContain("048_product_images");
    }
  });

  it("MIME/size constants match the bucket definition", () => {
    expect(PRODUCT_IMAGE_MAX_BYTES).toBe(5242880);
  });

  it("Khmer and English catalog.image keys match exactly", () => {
    const flat = (o: unknown, p = ""): string[] =>
      Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        v && typeof v === "object" ? flat(v, `${p}${k}.`) : [`${p}${k}`],
      );
    const e = flat((en as unknown as { catalog: { image: unknown } }).catalog.image).sort();
    const k = flat((km as unknown as { catalog: { image: unknown } }).catalog.image).sort();
    expect(k).toEqual(e);
    expect(e.length).toBeGreaterThan(20);
  });

  it("every catalog.image key used in code exists in both locales", () => {
    const code = [
      "src/components/products/ProductImageField.tsx",
      "src/components/products/CreateProductSheet.tsx",
      "src/routes/app.products.$id.tsx",
      "src/lib/product-image-client.ts",
    ]
      .map(read)
      .join("\n");
    const used = new Set(
      [...code.matchAll(/["'`](catalog\.image\.[a-zA-Z_.]+)["'`]/g)].map((m) => m[1]!),
    );
    const get = (loc: unknown, key: string) =>
      key
        .split(".")
        .reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], loc);
    for (const key of used) {
      expect(typeof get(en, key)).toBe("string");
      expect(typeof get(km, key)).toBe("string");
    }
  });

  it("no Thai characters in the new Khmer strings", () => {
    const khImage = JSON.stringify(
      (km as unknown as { catalog: { image: unknown } }).catalog.image,
    );
    expect(/[฀-๿]/.test(khImage)).toBe(false);
  });
});

// ══ H. Signed-upload abuse bounds ═════════════════════════════════════════════

const userId = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const as = (ctx: AuthorizationContext, n: number) =>
  ({ ...ctx, userId: userId(n) }) as AuthorizationContext;
const askTicket = async (ctx: AuthorizationContext, productId = PRODUCT_A) =>
  (await svc()).requestProductImageUpload(ctx, productId, {
    mimeType: "image/jpeg",
    sizeBytes: 1000,
  });

describe("H. signed-upload issuance limits", () => {
  it("limits one member per window (durable rule, fails with 429)", async () => {
    const { RATE_LIMITS } = await import("../server/rate-limit/policies");
    const ctx = editor(ORG_A);
    for (let i = 0; i < RATE_LIMITS.productImageUploadMember.limit; i++) {
      await askTicket(ctx);
      db.uploads.length = 0; // isolate the rate limit from the outstanding cap
    }
    await expect(askTicket(ctx)).rejects.toMatchObject({ statusCode: 429 });
    expect(db.uploads.length).toBe(0); // the refused request recorded nothing
  });

  it("limits the organization in aggregate: many staff cannot bypass the member limit", async () => {
    const { RATE_LIMITS } = await import("../server/rate-limit/policies");
    const orgLimit = RATE_LIMITS.productImageUploadOrganization.limit;
    const perMember = RATE_LIMITS.productImageUploadMember.limit;
    expect(orgLimit).toBeGreaterThan(perMember); // several staff fit …
    let issued = 0;
    for (let member = 1; issued < orgLimit; member++) {
      for (let k = 0; k < perMember && issued < orgLimit; k++) {
        await askTicket(as(editor(ORG_A), member));
        db.uploads.length = 0;
        issued++;
      }
    }
    // … a fresh member who never hit their own limit is still refused.
    await expect(askTicket(as(editor(ORG_A), 999))).rejects.toMatchObject({ statusCode: 429 });
  });

  it("does not affect a different organization", async () => {
    const { RATE_LIMITS } = await import("../server/rate-limit/policies");
    for (let i = 0; i < RATE_LIMITS.productImageUploadMember.limit; i++) {
      await askTicket(editor(ORG_A));
      db.uploads.length = 0;
    }
    await expect(askTicket(editor(ORG_A))).rejects.toMatchObject({ statusCode: 429 });
    const other = await askTicket(as(editor(ORG_B), 2), PRODUCT_B);
    expect(other.path.startsWith(`${ORG_B}/`)).toBe(true);
  });

  it("issues a unique, ticketed path per request and records each one", async () => {
    const a = await askTicket(editor(ORG_A));
    const b = await askTicket(editor(ORG_A));
    expect(a.path).not.toBe(b.path);
    expect(db.uploads.map((r) => r.object_path).sort()).toEqual([a.path, b.path].sort());
    expect(db.uploads[0]).toMatchObject({
      organization_id: ORG_A,
      product_id: PRODUCT_A,
      issued_by: USER,
    });
  });

  it("caps outstanding unattached tickets per member, then per organization", async () => {
    const s = await svc();
    const ctx = editor(ORG_A);
    for (let i = 0; i < s.PRODUCT_IMAGE_MAX_OUTSTANDING_MEMBER; i++) await askTicket(ctx);
    await expect(askTicket(ctx)).rejects.toMatchObject({ statusCode: 429 });
    // Other members still have their own allowance until the org cap is reached.
    let member = 2;
    while (db.uploads.length < s.PRODUCT_IMAGE_MAX_OUTSTANDING_ORGANIZATION) {
      const c = as(editor(ORG_A), member++);
      for (
        let k = 0;
        k < s.PRODUCT_IMAGE_MAX_OUTSTANDING_MEMBER &&
        db.uploads.length < s.PRODUCT_IMAGE_MAX_OUTSTANDING_ORGANIZATION;
        k++
      ) {
        await askTicket(c);
      }
    }
    await expect(askTicket(as(editor(ORG_A), 500))).rejects.toMatchObject({ statusCode: 429 });
    // A different tenant is unaffected.
    await askTicket(as(editor(ORG_B), 2), PRODUCT_B);
  });

  it("FAILS CLOSED when the durable limiter is unavailable (no ticket, no signed URL)", async () => {
    const lim = await import("../server/rate-limit/limiter");
    const { RateLimitBackendError } = await import("../server/rate-limit/store");
    const restore = lim.setPrimaryRateLimitStore({
      name: "postgres",
      hit: async () => {
        throw new RateLimitBackendError("down");
      },
    } as never);
    try {
      let signed = 0;
      const orig = storage.createUpload.bind(storage);
      storage.createUpload = async (p: string) => {
        signed++;
        return orig(p);
      };
      await expect(askTicket(editor(ORG_A))).rejects.toMatchObject({ statusCode: 503 });
      expect(signed).toBe(0);
      expect(db.uploads.length).toBe(0);
    } finally {
      restore();
    }
  });

  it("uses the fail-closed policy and documents its rules", async () => {
    const { BACKEND_FAILURE_POLICY, RATE_LIMITS } = await import("../server/rate-limit/policies");
    expect(BACKEND_FAILURE_POLICY.productImageUpload).toBe("fail_closed");
    expect(RATE_LIMITS.productImageUploadMember.id).toBe("products.image_upload.member");
    expect(RATE_LIMITS.productImageUploadOrganization.id).toBe(
      "products.image_upload.organization",
    );
  });

  it("permission is checked before the limiter or storage is touched", async () => {
    await expect(askTicket(viewer(ORG_A))).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.uploads.length).toBe(0);
  });

  it("no ticket is left if the URL cannot be signed; a ticket-write failure signs nothing", async () => {
    const orig = storage.createUpload.bind(storage);
    storage.createUpload = async () => {
      throw new Error("sign down");
    };
    await expect(askTicket(editor(ORG_A))).rejects.toMatchObject({ statusCode: 503 });
    expect(db.uploads.length).toBe(0);
    storage.createUpload = orig;

    let signed = 0;
    storage.createUpload = async (p: string) => {
      signed++;
      return orig(p);
    };
    db.failTicketWrites = true;
    await expect(askTicket(editor(ORG_A))).rejects.toMatchObject({ statusCode: 503 });
    expect(signed).toBe(0);
  });
});

// ══ I. Abandoned uploads: tickets + bounded sweep ═════════════════════════════

const expire = (path: string) => {
  const row = db.uploads.find((r) => r.object_path === path)!;
  row.expires_at = new Date(Date.now() - 1000).toISOString();
};

describe("I. abandoned-upload tickets and cleanup", () => {
  it("attach requires a live ticket for exactly this org + product + path", async () => {
    const s = await svc();
    const ctx = editor(ORG_A);
    // Well-formed owned path the server never issued.
    const forged = buildProductImagePath(
      ORG_A,
      PRODUCT_A,
      "d0000000-0000-4000-8000-0000000000aa",
      "image/jpeg",
    );
    storage.put(forged, JPEG);
    await expect(s.attachProductImage(ctx, PRODUCT_A, forged)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(rowOf(PRODUCT_A).image_path).toBeNull();

    // An expired ticket no longer authorises attach.
    const up = await uploadFor(ctx, PRODUCT_A, JPEG);
    expire(up.ticket.path);
    await expect(up.attach()).rejects.toMatchObject({ statusCode: 400 });
  });

  it("attach consumes the ticket", async () => {
    const up = await uploadFor(editor(ORG_A), PRODUCT_A, JPEG);
    expect(db.uploads.length).toBe(1);
    await up.attach();
    expect(db.uploads.length).toBe(1);
    expect(db.uploads[0]?.state).toBe("consumed");
    expect(rowOf(PRODUCT_A).image_path).toBe(up.ticket.path);
  });

  it("a rejected (spoofed) upload is deleted together with its ticket", async () => {
    const up = await uploadFor(editor(ORG_A), PRODUCT_A, new Uint8Array([0xff, 0xd8, 0xff]));
    await expect(up.attach()).rejects.toMatchObject({ statusCode: 400 });
    expect(storage.objects.has(up.ticket.path)).toBe(false);
    expect(db.uploads.length).toBe(0);
  });

  it("an abandoned upload expires and the next ticket request removes object and row", async () => {
    const abandoned = await uploadFor(editor(ORG_A), PRODUCT_A, JPEG);
    expect(storage.objects.has(abandoned.ticket.path)).toBe(true);
    expire(abandoned.ticket.path);
    const fresh = await askTicket(editor(ORG_A));
    expect(storage.objects.has(abandoned.ticket.path)).toBe(false);
    expect(db.uploads.map((r) => r.object_path)).toEqual([fresh.path]);
  });

  it("an unexpired ticket's object is never swept", async () => {
    const pending = await uploadFor(editor(ORG_A), PRODUCT_A, JPEG);
    await askTicket(editor(ORG_A));
    expect(storage.objects.has(pending.ticket.path)).toBe(true);
    expect(db.uploads.some((r) => r.object_path === pending.ticket.path)).toBe(true);
  });

  it("never deletes an attached/current image, even if a stale ticket row survives", async () => {
    const up = await uploadFor(editor(ORG_A), PRODUCT_A, JPEG);
    await up.attach();
    // Simulate a ticket left unconsumed for the CURRENT image.
    db.uploads.length = 0;
    db.uploads.push({
      id: "stale",
      state: "pending",
      cleanup_error_count: 0,
      organization_id: ORG_A,
      product_id: PRODUCT_A,
      issued_by: USER,
      object_path: up.ticket.path,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const s = await svc();
    const out = await s.sweepExpiredProductImageUploads();
    expect(out).toEqual({ resolved: 0, failed: 0 }); // the database resolved it as consumed
    expect(storage.removed).not.toContain(up.ticket.path);
    expect(storage.objects.has(up.ticket.path)).toBe(true);
    expect(rowOf(PRODUCT_A).image_path).toBe(up.ticket.path);
    expect(db.uploads[0]?.state).toBe("consumed"); // resolved, never handed out for deletion
  });

  it("never touches another tenant's attached image or live ticket", async () => {
    const b = await uploadFor(editor(ORG_B), PRODUCT_B, JPEG);
    await b.attach();
    const bPending = await uploadFor(as(editor(ORG_B), 2), PRODUCT_B, PNG, "image/png");
    const a = await uploadFor(editor(ORG_A), PRODUCT_A, JPEG);
    expire(a.ticket.path);
    await askTicket(editor(ORG_A)); // org A's request sweeps org A's abandoned upload …
    expect(storage.objects.has(a.ticket.path)).toBe(false);
    expect(storage.objects.has(b.ticket.path)).toBe(true); // … and only that.
    expect(rowOf(PRODUCT_B).image_path).toBe(b.ticket.path);
    expect(storage.objects.has(bPending.ticket.path)).toBe(true);
    expect(db.uploads.some((r) => r.object_path === bPending.ticket.path)).toBe(true);
  });

  it("refuses to delete a ticket row whose path is not its own org/product shape", async () => {
    const victim = await uploadFor(editor(ORG_B), PRODUCT_B, JPEG);
    await victim.attach();
    db.uploads.push({
      id: "poisoned",
      organization_id: ORG_A,
      product_id: PRODUCT_A,
      issued_by: USER,
      object_path: victim.ticket.path, // org B's object under an org A ticket
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    await (await svc()).sweepExpiredProductImageUploads();
    expect(storage.objects.has(victim.ticket.path)).toBe(true);
  });

  it("bounds the sweep per invocation", async () => {
    const s = await svc();
    const paths: string[] = [];
    for (let i = 0; i < s.PRODUCT_IMAGE_SWEEP_BATCH + 5; i++) {
      paths.push((await uploadFor(as(editor(ORG_A), 100 + i), PRODUCT_A, JPEG)).ticket.path);
    }
    paths.forEach(expire); // expire together so no request sweeps them early
    const first = await s.sweepExpiredProductImageUploads();
    expect(first.resolved).toBe(s.PRODUCT_IMAGE_SWEEP_BATCH);
    expect(db.uploads.length).toBe(5);
    const second = await s.sweepExpiredProductImageUploads();
    expect(second.resolved).toBe(5);
    expect(db.uploads.length).toBe(0);
  });

  it("a failing sweep never blocks ticket issuance, and the tickets are kept for retry", async () => {
    const abandoned = await uploadFor(editor(ORG_A), PRODUCT_A, JPEG);
    expire(abandoned.ticket.path);
    storage.failRemove = true;
    const t = await askTicket(editor(ORG_A));
    expect(t.uploadUrl).toContain("storage.test");
    // Still unresolved (and therefore still counted) — with a retry delay.
    const row = db.uploads.find((r) => r.object_path === abandoned.ticket.path)!;
    expect(row.state).toBe("cleaning");
    expect(row.cleanup_error_count).toBe(1);
    storage.failRemove = false;
    row.cleanup_retry_after = new Date(Date.now() - 1000).toISOString();
    await (await svc()).sweepExpiredProductImageUploads();
    expect(storage.objects.has(abandoned.ticket.path)).toBe(false);
  });

  it("the ticket outlives the signed upload token (2 h) so nothing can land after a sweep", async () => {
    const s = await svc();
    expect(s.PRODUCT_IMAGE_TICKET_TTL_SECONDS).toBeGreaterThan(2 * 60 * 60);
  });
});

// ══ J. Ranged-GET size verification fails closed ══════════════════════════════

describe("J. Range / Content-Range verification", () => {
  const PROBE = 128 * 1024;
  const res = (status: number, body: Uint8Array | null, headers: Record<string, string> = {}) =>
    new Response(body, { status, headers });
  const evaluate = async (r: Response) =>
    (await import("../server/products/image-storage")).evaluateProbeResponse(r);
  const body = (n: number) => new Uint8Array(n).fill(7);

  it("206 + valid Content-Range: size is the range TOTAL, not the body length", async () => {
    const out = await evaluate(
      res(206, body(PROBE), {
        "content-range": `bytes 0-${PROBE - 1}/2000000`,
        "content-length": String(PROBE),
      }),
    );
    expect(out?.sizeBytes).toBe(2_000_000);
    expect(out?.head.length).toBe(PROBE);
  });

  it("206 + valid range for an object smaller than the probe", async () => {
    const out = await evaluate(res(206, body(100), { "content-range": "bytes 0-99/100" }));
    expect(out).toMatchObject({ sizeBytes: 100 });
    expect(out?.head.length).toBe(100);
  });

  it("206 with NO Content-Range fails closed — Content-Length is never the object size", async () => {
    await expect(
      evaluate(res(206, body(PROBE), { "content-length": String(PROBE) })),
    ).rejects.toThrow();
    await expect(evaluate(res(206, body(100), { "content-length": "100" }))).rejects.toThrow();
  });

  it("206 with malformed Content-Range fails closed", async () => {
    for (const cr of [
      "garbage",
      "bytes 0-99/abc",
      "bytes 0-/100",
      "bytes -99/100",
      "items 0-99/100",
      "bytes 0-99/-5",
      "bytes 0-99/99999999999999999999",
    ]) {
      await expect(evaluate(res(206, body(100), { "content-range": cr }))).rejects.toThrow();
    }
  });

  it("206 with a wildcard / unknown total fails closed", async () => {
    await expect(
      evaluate(res(206, body(100), { "content-range": "bytes 0-99/*" })),
    ).rejects.toThrow();
    await expect(evaluate(res(206, body(0), { "content-range": "bytes */100" }))).rejects.toThrow();
  });

  it("206 with contradictory values fails closed", async () => {
    const bad: Array<[Uint8Array, Record<string, string>]> = [
      [body(100), { "content-range": "bytes 5-104/1000" }], // does not start at 0
      [body(100), { "content-range": "bytes 0-99/50" }], // end beyond total
      [body(100), { "content-range": "bytes 0-99/99" }], // end == total
      [body(50), { "content-range": "bytes 0-49/100" }], // shorter than asked, not clamped
      [body(100), { "content-range": "bytes 0-99/100", "content-length": "7" }], // header vs range
      [body(100), { "content-range": `bytes 0-${PROBE * 2 - 1}/9999999` }], // more than asked
      [body(60), { "content-range": "bytes 0-99/100" }], // body shorter than range
      [body(0), { "content-range": "bytes 0-99/0" }], // zero total
    ];
    for (const [b, h] of bad) await expect(evaluate(res(206, b, h))).rejects.toThrow();
  });

  it("200 + valid Content-Length: whole-object semantics", async () => {
    const out = await evaluate(res(200, body(300), { "content-length": "300" }));
    expect(out).toMatchObject({ sizeBytes: 300 });
    expect(out?.head.length).toBe(300);
  });

  it("200 large object: reads only the probe, size from Content-Length", async () => {
    const out = await evaluate(
      res(200, body(PROBE + 500), { "content-length": String(PROBE + 500) }),
    );
    expect(out?.sizeBytes).toBe(PROBE + 500);
    expect(out?.head.length).toBe(PROBE);
  });

  it("200 with missing / invalid length or a content-encoding fails closed", async () => {
    const chunked = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(body(10));
          c.close();
        },
      }),
      { status: 200 },
    );
    chunked.headers.delete("content-length");
    await expect(evaluate(chunked)).rejects.toThrow();
    await expect(evaluate(res(200, body(10), { "content-length": "abc" }))).rejects.toThrow();
    await expect(
      evaluate(res(200, body(10), { "content-length": "10", "content-encoding": "gzip" })),
    ).rejects.toThrow();
  });

  it("an oversize total is reported faithfully so the service can refuse it", async () => {
    const out = await evaluate(
      res(206, body(PROBE), {
        "content-range": `bytes 0-${PROBE - 1}/${PRODUCT_IMAGE_MAX_BYTES + 1}`,
      }),
    );
    expect(out?.sizeBytes).toBe(PRODUCT_IMAGE_MAX_BYTES + 1);
  });

  it("missing object / empty object → null; other statuses fail closed", async () => {
    expect(await evaluate(res(404, null))).toBeNull();
    expect(await evaluate(res(400, null))).toBeNull();
    expect(await evaluate(res(416, null, { "content-range": "bytes */0" }))).toBeNull();
    for (const status of [201, 204, 301, 403, 500, 503]) {
      await expect(evaluate(res(status, null))).rejects.toThrow();
    }
  });

  it("the service maps an unverifiable response to a retryable 503 and keeps the old image", async () => {
    const first = await uploadFor(editor(ORG_A), PRODUCT_A, JPEG);
    await first.attach();
    const next = await uploadFor(editor(ORG_A), PRODUCT_A, PNG, "image/png");
    storage.failInspect = true;
    await expect(next.attach()).rejects.toMatchObject({ statusCode: 503 });
    expect(rowOf(PRODUCT_A).image_path).toBe(first.ticket.path);
  });

  it("hosted Range behaviour stays a documented staging gate", () => {
    expect(read("docs/PRODUCT_IMAGES.md")).toMatch(/Range/);
    expect(read("docs/PRODUCT_IMAGES.md")).toMatch(/Pending staging/i);
  });
});

// ══ K. Structural image validation ════════════════════════════════════════════

describe("K. structural image validation", () => {
  const inspect = async (b: Uint8Array, total = b.length) =>
    (await import("../lib/product-image")).inspectImageStructure(b, total);

  it("accepts valid minimal JPEG, PNG and WebP (VP8, VP8L, VP8X) and reports dimensions", async () => {
    expect(await inspect(makeJpeg(320, 200))).toEqual({
      mime: "image/jpeg",
      width: 320,
      height: 200,
    });
    expect(await inspect(makePng(1600, 900))).toEqual({
      mime: "image/png",
      width: 1600,
      height: 900,
    });
    expect(await inspect(makeWebp(640, 480))).toEqual({
      mime: "image/webp",
      width: 640,
      height: 480,
    });
    expect(await inspect(riff(vp8lChunk(300, 200)))).toEqual({
      mime: "image/webp",
      width: 300,
      height: 200,
    });
    expect(await inspect(riff(vp8xChunk(50, 40), vp8Chunk(50, 40)))).toEqual({
      mime: "image/webp",
      width: 50,
      height: 40,
    });
  });

  it("accepts a JPEG whose frame header follows large metadata segments", async () => {
    const exif = [0xff, 0xe1, ...be16(60000), ...new Array(59998).fill(0)];
    const j = makeJpeg();
    const withExif = bytes([0xff, 0xd8], exif, j.subarray(2));
    expect((await inspect(withExif))?.mime).toBe("image/jpeg");
  });

  it("rejects truncated / header-only JPEG", async () => {
    const j = makeJpeg();
    expect(await inspect(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull(); // 3-byte signature
    expect(await inspect(j.subarray(0, 2 + 18))).toBeNull(); // SOI + APP0 only
    expect(await inspect(j.subarray(0, 12))).toBeNull(); // cut inside APP0
    expect(await inspect(j.subarray(0, 2 + 18 + 10))).toBeNull(); // cut inside SOF
    expect(await inspect(bytes([0xff, 0xd8, 0xff, 0xd9]))).toBeNull(); // EOI, no frame
    expect(await inspect(bytes([0xff, 0xd8, 0xff, 0xda, ...be16(2)]))).toBeNull(); // scan before frame
  });

  it("rejects a JPEG with a malformed segment structure", async () => {
    expect(await inspect(bytes([0xff, 0xd8, 0xff, 0xe0, ...be16(1), 0, 0]))).toBeNull(); // length < 2
    expect(await inspect(bytes([0xff, 0xd8, 0xff, 0xe0, ...be16(500), 0, 0, 0]))).toBeNull(); // runs past data
    expect(await inspect(bytes([0xff, 0xd8, 0x00, 0x11, 0x22, 0x33]))).toBeNull(); // not at a marker
    const sofShort = bytes([0xff, 0xd8, 0xff, 0xc0, ...be16(8), 8, ...be16(10), ...be16(10), 3]);
    expect(await inspect(sofShort)).toBeNull(); // 3 components declared, none present
  });

  it("rejects truncated / header-only PNG", async () => {
    const p = makePng();
    expect(await inspect(p.subarray(0, 8))).toBeNull(); // signature only
    expect(await inspect(p.subarray(0, 20))).toBeNull(); // truncated IHDR
    expect(await inspect(p.subarray(0, 32))).toBeNull(); // missing last CRC byte
    expect(await inspect(makePng(64, 48, { badCrc: true }))).toBeNull();
    const wrongLen = new Uint8Array(p);
    wrongLen[11] = 12; // IHDR length 12
    expect(await inspect(wrongLen)).toBeNull();
    const notIhdr = new Uint8Array(p);
    notIhdr[12] = 0x58;
    expect(await inspect(notIhdr)).toBeNull();
  });

  it("rejects truncated / header-only / malformed WebP", async () => {
    const w = makeWebp();
    expect(await inspect(bytes(tag("RIFF"), le32(4), tag("WEBP")))).toBeNull(); // RIFF+WEBP only
    expect(await inspect(w.subarray(0, 12))).toBeNull();
    expect(await inspect(w.subarray(0, 24))).toBeNull(); // chunk header, payload cut
    expect(await inspect(w, w.length - 4)).toBeNull(); // container claims more than exists
    expect(await inspect(riff([...tag("VP8 "), ...le32(9999), 0, 0, 0]))).toBeNull(); // chunk past RIFF
    expect(await inspect(riff([...tag("JUNK"), ...le32(4), 1, 2, 3, 4]))).toBeNull(); // no image chunk
    const badStart = new Uint8Array(w);
    badStart[23] = 0; // corrupt VP8 start code
    expect(await inspect(badStart)).toBeNull();
    expect(await inspect(riff(vp8xChunk(50, 40)))).toBeNull(); // extended header, no payload
    expect(await inspect(riff(vp8xChunk(50, 40, 0x02), vp8Chunk(50, 40)))).toBeNull(); // animated
    expect(await inspect(riff(vp8xChunk(50, 40), vp8Chunk(60, 40)))).toBeNull(); // canvas mismatch
  });

  it("rejects a valid signature followed by an arbitrary fake body", async () => {
    const fake = new TextEncoder().encode("<html><script>alert(1)</script></html>".repeat(20));
    expect(await inspect(bytes([0xff, 0xd8, 0xff], fake))).toBeNull();
    expect(await inspect(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], fake))).toBeNull();
    expect(await inspect(bytes(tag("RIFF"), le32(fake.length), tag("WEBP"), fake))).toBeNull();
    expect(await inspect(SVG)).toBeNull();
    expect(await inspect(HTML)).toBeNull();
    expect(await inspect(EXE)).toBeNull();
  });

  it("enforces dimension and pixel bounds (zero, absurd, decompression-bomb)", async () => {
    const lib = await import("../lib/product-image");
    expect(lib.PRODUCT_IMAGE_MAX_DIMENSION).toBe(8192);
    expect(lib.PRODUCT_IMAGE_MAX_PIXELS).toBe(40_000_000);
    expect(await inspect(makePng(0, 10))).toBeNull();
    expect(await inspect(makePng(10, 0))).toBeNull();
    expect(await inspect(makeJpeg(0, 10))).toBeNull();
    expect(await inspect(makeJpeg(10, 0))).toBeNull();
    expect(await inspect(makePng(8193, 10))).toBeNull(); // over per-edge bound
    expect(await inspect(makePng(0x7fffffff, 0x7fffffff))).toBeNull();
    expect(await inspect(makeJpeg(8000, 8000))).toBeNull(); // 64 MP
    expect(await inspect(riff(vp8lChunk(16384, 16384)))).toBeNull();
    expect(await inspect(makeJpeg(4032, 3024))).toMatchObject({ width: 4032, height: 3024 }); // 12 MP phone
    expect(await inspect(makePng(8192, 4096))).not.toBeNull(); // at the bounds (33.5 MP)
  });

  it("the service refuses truncated and spoofed uploads and keeps the current image", async () => {
    const first = await uploadFor(editor(ORG_A), PRODUCT_A, JPEG);
    await first.attach();
    const cases: Array<[Uint8Array, string]> = [
      [new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg"],
      [PNG.subarray(0, 8), "image/png"],
      [PNG.subarray(0, 20), "image/png"],
      [bytes(tag("RIFF"), le32(4), tag("WEBP")), "image/webp"],
      [bytes([0xff, 0xd8, 0xff], HTML), "image/jpeg"],
    ];
    for (const [b, mime] of cases) {
      const bad = await uploadFor(editor(ORG_A), PRODUCT_A, b, mime);
      await expect(bad.attach()).rejects.toMatchObject({ statusCode: 400 });
      expect(storage.objects.has(bad.ticket.path)).toBe(false);
      expect(rowOf(PRODUCT_A).image_path).toBe(first.ticket.path);
    }
    // Declared type must match the structure actually found.
    const mismatch = await uploadFor(editor(ORG_A), PRODUCT_A, PNG, "image/jpeg");
    await expect(mismatch.attach()).rejects.toMatchObject({ statusCode: 400 });
  });

  it("valid uploads still attach (JPEG, PNG, WebP)", async () => {
    for (const [b, mime] of [
      [JPEG, "image/jpeg"],
      [PNG, "image/png"],
      [WEBP, "image/webp"],
    ] as const) {
      const up = await uploadFor(editor(ORG_A), PRODUCT_A, b, mime);
      await up.attach();
      expect(rowOf(PRODUCT_A).image_path).toBe(up.ticket.path);
    }
  });
});

// ══ L. Migration 049 + docs ═══════════════════════════════════════════════════

describe("L. migration 049 and documentation", () => {
  const sql = () => read("supabase/migrations/049_product_image_uploads.sql");
  const code = () =>
    sql()
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");

  it("is RLS-only: no client policy or grant, no SECURITY DEFINER", () => {
    expect(code()).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(code()).toMatch(
      /REVOKE ALL ON public\.product_image_uploads FROM PUBLIC, anon, authenticated/,
    );
    expect(code()).not.toMatch(/CREATE POLICY/i);
    expect(code()).not.toMatch(/SECURITY DEFINER/i);
    expect(code()).not.toMatch(/GRANT[^;]*\b(anon|authenticated)\b/i);
  });

  it("pins the object path to the ticket's own org/product and indexes expiry + path", () => {
    expect(code()).toMatch(/product_image_uploads_path_owned/);
    expect(code()).toMatch(/UNIQUE INDEX[^;]*object_path/);
    expect(code()).toMatch(/INDEX[^;]*\(expires_at\)/);
    expect(code()).toMatch(/\(organization_id, issued_by, expires_at\)/);
  });

  it("docs state the storage-path exposure accurately", () => {
    const doc = read("docs/PRODUCT_IMAGES.md");
    expect(doc).not.toMatch(/storage path is never returned/i);
    expect(doc).toMatch(/signed bearer URL/i);
    expect(doc).toMatch(/not an authorization secret/i);
  });
});
