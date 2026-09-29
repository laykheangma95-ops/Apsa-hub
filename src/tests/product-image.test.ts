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

const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1,
]);
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0, 0, 0, 0,
]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0,
]);
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
  failNextProductUpdate = false;
  log: string[] = [];

  private table(name: string): Row[] {
    if (name === "products") return this.products;
    if (name === "product_variants") return this.variants;
    return [];
  }

  from(name: string) {
    const rows = this.table(name);
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    const matches = () => rows.filter((r) => filters.every((f) => f(r)));
    const settle = () => {
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
      return { data: matches().map((r) => ({ ...r })), error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      update: (p: Row) => {
        patch = p;
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
      limit: () => q,
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
  const origUpdate = db.from.bind(db);
  // Record storage/db ordering in one timeline.
  db.log = storage.events;
  void origUpdate;
});

afterEach(() => {
  restoreDb();
  restoreStorage();
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

  it("save fails AFTER a good upload: product keeps the old image; the new object is cleaned up", async () => {
    const first = await withExisting();
    const next = await uploadFor(editor(ORG_A), PRODUCT_A, PNG, "image/png");
    db.failNextProductUpdate = true;
    await expect(next.attach()).rejects.toThrow(/Could not save the photo/);
    expect(rowOf(PRODUCT_A)["image_path"]).toBe(first.ticket.path);
    expect(storage.objects.has(first.ticket.path)).toBe(true);
    expect(storage.objects.has(next.ticket.path)).toBe(false);
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
