# Staging verification — Orders attention views (PR #137, migration 065)

**Status:** procedure only. Nothing here has been run against staging. Nothing in
PR #137 may be called staging-verified until a person runs this and records the
result at the end of this file (or on the PR).

**Gate:** PR #137's application code must not be deployed to an environment
whose database lacks migration 065 (`order_preparation_queue_v1`). On such an
environment, Needs preparation and Packed · Needs delivery fail closed: the list
and the counts return an error, never a wrong list. Migration 065 must be
rehearsed on staging first, before any production plan.

What this proves that local tests cannot:

1. Real PostgREST answers the exact requests the repository sends:
   - the `deliveries!inner(id)` embed with `deliveries.status` /
     `deliveries.organization_id` filters (Waiting for pickup);
   - two filters on the same column (`fulfillment_status=neq.fulfilled` and
     `fulfillment_status=neq.cancelled`);
   - the exact head-only count (`Prefer: count=exact`, `Content-Range`);
   - keyset pagination (the two-request continuation).
     Locally these ran through a PGlite stand-in
     (`src/tests/helpers/postgrest-pglite.ts`), not PostgREST.
2. `order_preparation_queue_v1` through PostgREST: filter, order, count, and
   refusal for browser keys.
3. Query cost on staging's data volume and on Supabase's managed PostgreSQL.

---

## 0. Preconditions

- [ ] Migration 065 applied to **staging only**, through the project's normal
      reviewed migration path (`docs/RELEASE_CHECKLIST.md`). Record the time and
      who applied it.
- [ ] `select to_regclass('public.order_preparation_queue_v1')` returns the view
      (SQL editor, read-only).
- [ ] The staging app (Vercel `apsa_staging` preview for PR #137) is at the PR's
      current head SHA.
- [ ] A **dedicated, disposable test organization** exists on staging, used for
      nothing else — for example `QA Attention YYYY-MM-DD`. Record its id as
      `ORG`. Orders cannot be deleted (`orders_no_delete`), so the fixture stays
      in this organization for good; never build it in a real shop.
- [ ] A second test organization `ORG_B` exists, with at least one order that has
      a `ready` delivery (tenant-isolation check).
- [ ] The operator has the staging **service-role key** in a local shell
      variable (`SRK`), and the **anon key** (`ANON`). Never paste either into
      the PR, a chat, a screenshot or this file. Set
      `API=https://<staging-project-ref>.supabase.co/rest/v1`.

## 1. Disposable fixture — built only through the app's own flows

Sign in to the staging preview as the test organization's Owner. For each row,
create a POS or manual order (one item, USD), then perform the listed actions
**in order** through the UI (Order detail, Pack Order, Arrange delivery, the
delivery screen, Courier Handoff). Put the label in the order note or customer
name so each order can be identified. Record each order's code.

| Label                    | Actions after Confirm                                                                         | Expected view(s)                                          |
| ------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| F1 unpacked              | none                                                                                          | Needs preparation; Payment due                            |
| F2 arranged-first        | Arrange delivery (stays pending)                                                              | Needs preparation (fulfillment shows _processing_)        |
| F3 arranged-preparing    | Arrange delivery → Start preparing                                                            | Needs preparation                                         |
| F4 packed-no-delivery    | Pack Order                                                                                    | Packed · Needs delivery                                   |
| F5 packed-ready          | Pack Order → Arrange delivery (auto-ready)                                                    | Waiting for pickup                                        |
| F6 arranged-then-packed  | Arrange delivery → Pack Order (delivery → ready)                                              | Waiting for pickup                                        |
| F7 packed-cancelled      | as F5, then **Cancel** the ready delivery from the delivery screen (not a fulfillment reopen) | Packed · Needs delivery (reason: last delivery cancelled) |
| F8 packed-handoff-failed | as F5 → Courier Handoff (in transit) → mark **Failed**                                        | Packed · Needs delivery (reason: last delivery failed)    |
| F9 in-transit            | as F5 → Courier Handoff                                                                       | none of the packing views; Payment due if unpaid          |
| F10 delivered            | as F9 → mark Delivered                                                                        | none of the packing views                                 |
| F11 cancelled            | Cancel order (before any delivery)                                                            | none                                                      |
| F12 COD ready            | Arrange delivery **with COD amount** → Pack Order                                             | Waiting for pickup **and** Payment due                    |
| F13 partly paid ready    | Record a partial payment and confirm it → Pack → Arrange delivery                             | Waiting for pickup **and** Payment due (Received X of Y)  |
| F14 two attempts         | as F8, then Arrange delivery again (new pending)                                              | Packed · Needs delivery (reason: delivery not ready)      |

If any action above is not offered by the UI for the member, record it as
**N/A — not reachable** rather than writing rows by SQL.

## 2. Read-only verification

Every request below is a `GET` or `HEAD`. Every SQL statement is a `SELECT`
(or `EXPLAIN` of one). Nothing is written.

### 2.1 Ground truth (SQL editor, read-only)

```sql
-- One row per fixture order: the facts every view is defined by.
select o.order_number, o.lifecycle_status, o.payment_status, o.fulfillment_status,
       public.order_currently_packed_v1(o.organization_id, o.id) as packed,
       (select string_agg(d.status::text, ',' order by d.created_at)
          from deliveries d where d.organization_id = o.organization_id and d.order_id = o.id) as deliveries,
       q.preparation_state
from orders o
left join order_preparation_queue_v1 q on q.id = o.id
where o.organization_id = :'ORG'
order by o.created_at desc, o.id desc;
```

Expected: each order's `preparation_state` matches the table in §1:
`needs_packing` for F1–F3, `packed_needs_delivery` for F4, F7, F8 and F14, and
null for the rest.

### 2.2 Waiting for pickup — the embed, exactly as the repository sends it

```sh
H=(-H "apikey: $SRK" -H "Authorization: Bearer $SRK")
WAIT="organization_id=eq.$ORG&lifecycle_status=eq.confirmed&fulfillment_status=neq.fulfilled&fulfillment_status=neq.cancelled&deliveries.status=eq.ready&deliveries.organization_id=eq.$ORG"

# Exact count (head only): read the total after the slash in Content-Range.
curl -sS -I "${H[@]}" -H "Prefer: count=exact" \
  "$API/orders?select=id,deliveries!inner(id)&$WAIT" | grep -i content-range

# First page, one row per order, newest first (limit 2 forces pagination).
curl -sS "${H[@]}" \
  "$API/orders?select=*,deliveries!inner(id)&$WAIT&order=created_at.desc,id.desc&limit=2" \
  | jq '[.[] | {order_number, created_at, id, n_deliveries: (.deliveries|length)}]'
```

Expect:

- [ ] Count = 4 (F5, F6, F12, F13).
- [ ] Only those orders. F14 has an old failed and a new pending delivery, so it
      is absent. No order appears twice. Each row's `deliveries` array holds only
      the ready delivery.
- [ ] F9 (in transit) and F10 (delivered) are absent.

Keyset continuation (what `listOrdersBefore` sends). Take the 2nd row of a
`limit=2` page as the cursor `C_AT` / `C_ID`. Both values are from the response;
URL-encode `C_AT` (its `+` becomes `%2B`).

```sh
curl -sS "${H[@]}" "$API/orders?select=*,deliveries!inner(id)&$WAIT&created_at=eq.$C_AT&id=lt.$C_ID&order=id.desc&limit=2" | jq '[.[].order_number]'
curl -sS "${H[@]}" "$API/orders?select=*,deliveries!inner(id)&$WAIT&created_at=lt.$C_AT&order=created_at.desc,id.desc&limit=2" | jq '[.[].order_number]'
```

- [ ] Page 1 + the continuation = the full list from the first call, in order,
      with no repeats or gaps.

Tenant isolation:

- [ ] The same requests with `$ORG_B` in place of `$ORG` (both places) return
      only `ORG_B`'s orders. The request with `organization_id=eq.$ORG` and
      `deliveries.organization_id=eq.$ORG_B` returns `[]` and count 0.

### 2.3 Needs preparation and Packed · Needs delivery — the view

```sh
for STATE in needs_packing packed_needs_delivery; do
  Q="organization_id=eq.$ORG&preparation_state=eq.$STATE"
  curl -sS -I "${H[@]}" -H "Prefer: count=exact" "$API/order_preparation_queue_v1?select=id&$Q" | grep -i content-range
  curl -sS "${H[@]}" "$API/order_preparation_queue_v1?select=*&$Q&order=created_at.desc,id.desc&limit=2" | jq '[.[].order_number]'
done
```

- [ ] `needs_packing` count = 3 (F1, F2, F3). `packed_needs_delivery` count = 4
      (F4, F7, F8, F14), or fewer by exactly the fixtures recorded N/A.
- [ ] Rows carry every `orders` column plus `preparation_state` (the app maps
      them as orders).
- [ ] The same two-request keyset continuation as §2.2 returns the rest without
      repeats or gaps.

Browser keys are refused (no rows can leak):

```sh
curl -sS -o /dev/null -w "%{http_code}\n" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  "$API/order_preparation_queue_v1?select=id&limit=1"
```

- [ ] Not `200` (expected `401`, permission denied / `42501`). Repeat with a
      signed-in member's JWT: also refused.

### 2.4 The app, end to end

- [ ] On the staging preview, as Owner: each chip's number equals the counts
      above. Each list shows exactly the expected orders, with the reasons and
      next steps from §1.
- [ ] As a member with only `orders.read`: Waiting for pickup is not offered, and
      the other three are.
- [ ] Switching to `ORG_B` never shows `ORG`'s orders or numbers.

### 2.5 Cost (read-only `EXPLAIN`; executes the SELECT, writes nothing)

Run on the **largest real tenant on staging** (by confirmed orders), not only
the fixture org:

```sql
explain (analyze, buffers)
select count(*) from order_preparation_queue_v1
where organization_id = :'BIG' and preparation_state = 'needs_packing';

explain (analyze, buffers)
select * from order_preparation_queue_v1
where organization_id = :'BIG' and preparation_state = 'needs_packing'
order by created_at desc, id desc limit 51;

explain (analyze, buffers)
select count(*) from orders o
where o.organization_id = :'BIG' and o.lifecycle_status = 'confirmed'
  and o.fulfillment_status <> 'fulfilled' and o.fulfillment_status <> 'cancelled'
  and exists (select 1 from deliveries d where d.order_id = o.id
              and d.status = 'ready' and d.organization_id = :'BIG');
```

Also record the PostgREST-side timing of the §2.2/§2.3 requests
(`curl -w "%{time_total}"`). Note: PostgREST generates its own SQL for the embed
(a LATERAL subquery), so the third `EXPLAIN` approximates it.

Local reference (native PostgreSQL 16.15 in a container, not Supabase):

- A tenant with 60,000 orders, of which 10,000 are confirmed.
- Needs-preparation count ≈ 137 ms; first page ≈ 135 ms; Packed · Needs delivery
  count ≈ 151 ms. The packed rule runs once per confirmed order of the tenant.
- Waiting-for-pickup count (EXISTS form) ≈ 3.5 ms.

Staging numbers above roughly 500 ms for the largest tenant are a blocker to
raise before production.

## 3. Record

```
Staging verification — PR #137
Head SHA:
Migration 065 applied to staging at / by:
Operator:                       Date:
§2.1 ground truth:              PASS / FAIL (notes)
§2.2 waiting_pickup embed/count/pagination/isolation:  PASS / FAIL
§2.3 preparation view list/count/pagination/browser refusal:  PASS / FAIL
§2.4 app end to end:            PASS / FAIL
§2.5 cost (largest tenant, ms): count __ / page __ / waiting __ ; PostgREST __
Fixtures N/A (not reachable):
Residual risks:
```
