/** Migration 049 against a real (PGlite) replay of every migration. */
import { it, expect } from "bun:test";
import { financialFixture } from "./helpers/payment-order-fixture";
it("migration 049 replays fresh; ticket path, uniqueness and client access are enforced", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f: any = await financialFixture();
  const db = f.db;
  const org = "aaaaaaaa-0000-4000-8000-000000000001";
  const actor = "aaaaaaaa-0000-4000-8000-000000000002";
  const pid = "a1000000-0000-4000-8000-000000000001";
  await db.query(
    "insert into products(id,organization_id,name_km,name_en,status) values($1,$2,'x','x','ACTIVE')",
    [pid, org],
  );
  const path = `${org}/${pid}/d0000000-0000-4000-8000-000000000009.jpg`;
  await db.query(
    "insert into product_image_uploads(organization_id,product_id,issued_by,object_path,expires_at) values($1,$2,$3,$4,now()+interval '3 hours')",
    [org, pid, actor, path],
  );
  await expect(
    db.query(
      "insert into product_image_uploads(organization_id,product_id,issued_by,object_path,expires_at) values($1,$2,$3,$4,now()+interval '3 hours')",
      [org, pid, actor, path],
    ),
  ).rejects.toThrow(); // unique
  await expect(
    db.query(
      "insert into product_image_uploads(organization_id,product_id,issued_by,object_path,expires_at) values($1,$2,$3,$4,now()+interval '3 hours')",
      [
        org,
        pid,
        actor,
        `bbbbbbbb-0000-4000-8000-000000000001/${pid}/d0000000-0000-4000-8000-00000000000a.jpg`,
      ],
    ),
  ).rejects.toThrow(); // foreign org path
  await db.exec("set role authenticated");
  await expect(db.query("select * from product_image_uploads")).rejects.toThrow();
  await db.exec("reset role; set role anon");
  await expect(db.query("select * from product_image_uploads")).rejects.toThrow();
  await db.exec("reset role; set role service_role");
  expect((await db.query("select * from product_image_uploads")).rows.length).toBe(1);
});
