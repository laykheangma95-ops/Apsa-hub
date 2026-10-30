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
create an order (one item, USD) from Orders → New order, or from POS **without**
recording a payment at checkout. Record **no payment** unless the row says so.
Then perform the listed actions **in order** through the UI (Order detail, Pack
Order, Arrange delivery, the delivery screen, Courier Handoff). Put the label in
the order note or customer name so each order can be identified. Record each
order's code.

Arrange delivery on an order that is **already packed** readies the new delivery
at once (auto-ready, `readyPackedOrderDelivery`). So no fixture here ends with a
packed order whose delivery is still pending. That state is covered by the local
tests only (`order-attention-lists`, "packed, pending delivery never readied").
This rehearsal requires no privilege or grant change of any kind.

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
| F9 in-transit            | as F5 → Courier Handoff                                                                       | none of the packing views; Payment due                    |
| F10 delivered            | as F9 → mark Delivered                                                                        | none of the packing views                                 |
| F11 cancelled            | Cancel order (before any delivery)                                                            | none                                                      |
| F12 COD ready            | Arrange delivery **with COD amount** → Pack Order                                             | Waiting for pickup **and** Payment due                    |
| F13 partly paid ready    | Record a partial payment and confirm it → Pack → Arrange delivery                             | Waiting for pickup **and** Payment due (Received X of Y)  |
| F14 two attempts         | as F8, then Arrange delivery again (still packed, so the new delivery auto-readies)           | Waiting for pickup (deliveries: failed, then ready)       |

If any action above is not offered by the UI for the member, record it as
**N/A — not reachable** rather than writing rows by SQL.

**Expected totals for F1–F14** (reduce by exactly the fixtures recorded N/A):

| View                        | Count | Orders                                                                            |
| --------------------------- | ----- | --------------------------------------------------------------------------------- |
| Payment due                 | 13    | every fixture order except F11 (cancelled); none is fully paid (F13 is part paid) |
| Needs preparation           | 3     | F1, F2, F3                                                                        |
| Packed · Needs delivery     | 3     | F4, F7, F8                                                                        |
| Packed · Waiting for pickup | 5     | F5, F6, F12, F13, F14                                                             |

## 2. Read-only verification

Every request below is a `GET` or `HEAD`. Every SQL statement is a `SELECT`
(or `EXPLAIN` of one). Nothing is written.

### 2.1 Ground truth (SQL editor, read-only)

```sql
-- One row per fixture order: the facts every view is defined by.
select o.id, o.created_at, o.order_number, o.lifecycle_status, o.payment_status, o.fulfillment_status,
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
`needs_packing` for F1–F3, `packed_needs_delivery` for F4, F7 and F8, and null
for the rest. F14 has `packed = true` and `deliveries = failed,ready`; its ready
delivery puts it in Waiting for pickup, not in the view. F5, F6, F12 and F13
show one `ready` delivery each.

**Baseline.** Before §2.2, save this result. It has 14 rows, already in the list
order `created_at desc, id desc`, with each row's fixture label (F1–F14) written
next to it. From it, write down three baselines. Each is the **ids** of the
labelled orders, in the order they appear in this result:

```sh
BASE_WAIT=(<id F?> ...)      # exactly F5, F6, F12, F13, F14 — 5 ids, in §2.1 row order
BASE_PACK=(<id F?> ...)      # exactly F1, F2, F3            — 3 ids, in §2.1 row order
BASE_RECOVER=(<id F?> ...)   # exactly F4, F7, F8            — 3 ids, in §2.1 row order
```

Fewer ids only for fixtures recorded N/A in §1, never otherwise. Also record
whether any two fixture orders share a `created_at` (the same-timestamp
boundary):

```sql
select created_at, count(*) from orders
where organization_id = :'ORG' group by created_at having count(*) > 1;
```

### 2.2 Waiting for pickup — the embed, exactly as the repository sends it

```sh
H=(-H "apikey: $SRK" -H "Authorization: Bearer $SRK")
WAIT="organization_id=eq.$ORG&lifecycle_status=eq.confirmed&fulfillment_status=neq.fulfilled&fulfillment_status=neq.cancelled&deliveries.status=eq.ready&deliveries.organization_id=eq.$ORG"

# Exact count (head only): read the total after the slash in Content-Range.
curl -sS -I "${H[@]}" -H "Prefer: count=exact" \
  "$API/orders?select=id,deliveries!inner(id)&$WAIT" | grep -i content-range

# One row per order: each row's deliveries array holds only the ready one.
curl -sS "${H[@]}" "$API/orders?select=*,deliveries!inner(id)&$WAIT&order=created_at.desc,id.desc" \
  | jq '[.[] | {order_number, n_deliveries: (.deliveries|length)}]'
```

Expect:

- [ ] Count = 5 (F5, F6, F12, F13, F14).
- [ ] Only those orders. F14 has two deliveries (an old failed one and a new
      ready one) and appears **once**. Each row's `deliveries` array holds only
      the ready delivery (`n_deliveries` = 1 on every row).
- [ ] F9 (in transit) and F10 (delivered) are absent.

**Pagination: walk every page to the end, exactly as the repository does.**
`listOrdersPage` with page size `P` asks for `P+1` rows. A continuation
(`listOrdersBefore`) sends two requests, each with `limit=P+1`:

- the **same instant**: `created_at=eq.C`, `id=lt.I`, ordered by `id desc`;
- everything **older**: `created_at=lt.C`, ordered by `created_at desc, id desc`.

It concatenates them (same-instant rows first), keeps the first `P+1`, and shows
the first `P`. It continues from the `P`-th row only when a `(P+1)`-th row
exists; otherwise the list has ended. `walk` below does exactly that, until
exhausted. It needs bash, curl and jq.

```sh
# walk BASE P -> prints a JSON array of every row served, page by page, in order.
# BASE: "<relation>?select=...&<filters>" (no order/limit). Stops non-zero on any anomaly.
walk() {
  local base="$1" P="$2" n=0 rows page same older at C_AT="" C_ID="" ALL='[]'
  while :; do
    n=$((n+1))
    [ "$n" -le 50 ] || { echo "STOP: more than 50 pages" >&2; return 1; }
    if [ -z "$C_ID" ]; then
      rows=$(curl -sS "${H[@]}" "$API/$base&order=created_at.desc,id.desc&limit=$((P+1))")
    else
      at=$(jq -rn --arg v "$C_AT" '$v|@uri')
      same=$(curl -sS "${H[@]}" "$API/$base&created_at=eq.$at&id=lt.$C_ID&order=id.desc&limit=$((P+1))")
      older=$(curl -sS "${H[@]}" "$API/$base&created_at=lt.$at&order=created_at.desc,id.desc&limit=$((P+1))")
      for r in "$same" "$older"; do
        jq -e 'type == "array"' <<<"$r" >/dev/null || { echo "STOP: error response: $r" >&2; return 1; }
      done
      echo "page $n: same-instant rows $(jq length <<<"$same")" >&2
      rows=$(jq -n --argjson a "$same" --argjson b "$older" "(\$a + \$b)[0:$((P+1))]")
    fi
    jq -e 'type == "array"' <<<"$rows" >/dev/null || { echo "STOP: error response: $rows" >&2; return 1; }
    [ "$(jq length <<<"$rows")" -le "$((P+1))" ] || { echo "STOP: more than P+1 rows" >&2; return 1; }
    page=$(jq "[.[0:$P][] | {id, order_number, created_at}]" <<<"$rows")
    ALL=$(jq -n --argjson a "$ALL" --argjson b "$page" '$a + $b')
    [ "$(jq length <<<"$rows")" -gt "$P" ] || break          # no (P+1)-th row: exhausted
    local next_id; next_id=$(jq -r '.[-1].id' <<<"$page")
    [ "$next_id" != "$C_ID" ] || { echo "STOP: cursor did not advance" >&2; return 1; }
    C_AT=$(jq -r '.[-1].created_at' <<<"$page"); C_ID="$next_id"
  done
  echo "$ALL"
}

# check RESULT BASELINE_IDS... -> PASS only if every row was served exactly once, in baseline order.
check() {
  local result="$1"; shift
  local rows distinct
  rows=$(jq length <<<"$result"); distinct=$(jq '[.[].id] | unique | length' <<<"$result")
  [ "$rows" -eq "$distinct" ] || { echo "FAIL: duplicate rows ($rows rows, $distinct distinct)"; return 1; }
  [ "$rows" -eq "$#" ] || { echo "FAIL: $rows rows served, baseline has $#"; return 1; }
  diff <(jq -r '.[].id' <<<"$result") <(printf '%s\n' "$@") \
    || { echo "FAIL: rows missing, extra or out of order (diff above)"; return 1; }
  echo "PASS: $rows rows, each exactly once, in baseline order"
}

for P in 1 2 50; do   # 1 and 2 force 5 and 3 pages; 50 is the screen's default page size
  R=$(walk "orders?select=*,deliveries!inner(id)&$WAIT" "$P") || { echo "P=$P: STOPPED"; continue; }
  echo "P=$P"; check "$R" "${BASE_WAIT[@]}"
done
```

- [ ] For every `P` (1, 2, 50), `check` prints the PASS line for 5 rows (fewer
      only by fixtures recorded N/A), with no `STOP` and no `FAIL`. The
      concatenated pages, never a single page, must equal `BASE_WAIT`. With
      `P=50` everything is on one page.
- [ ] The number of rows served equals the exact count above (5).
- [ ] Same-timestamp boundary: every continuation printed its same-instant row
      count.
  - If the §2.1 tie query returned no rows, the same-instant request must have
    returned 0 on every page. Record "no tie in fixture". Tie paging is proven
    only locally (`orders-pagination-mounted` case G, through the PGlite
    stand-in, not PostgREST).
  - If it returned a tie between two orders of the **same** view, that view's
    walks crossed it: a continuation printed a non-zero same-instant count, and
    the walks must still pass. Record which labels were tied. A tie between
    orders of different views exercises nothing; record it as "no tie in view".

**Stop conditions (record FAIL and stop §2):** any `STOP` or `FAIL` line, any
non-array (error) response, a count that differs from the rows served, or any
row id outside its baseline.

Tenant isolation:

- [ ] `walk` with `$ORG_B` in place of `$ORG` (both places in `WAIT`) serves only
      `ORG_B`'s orders. Check it with `check` against `ORG_B`'s own baseline,
      taken from the §2.1 query run for `ORG_B`, limited to orders with a
      `ready` delivery.
- [ ] The request with `organization_id=eq.$ORG` and
      `deliveries.organization_id=eq.$ORG_B` returns `[]` and count 0.

### 2.3 Needs preparation and Packed · Needs delivery — the view

```sh
for STATE in needs_packing packed_needs_delivery; do
  Q="organization_id=eq.$ORG&preparation_state=eq.$STATE"
  curl -sS -I "${H[@]}" -H "Prefer: count=exact" "$API/order_preparation_queue_v1?select=id&$Q" | grep -i content-range
  curl -sS "${H[@]}" "$API/order_preparation_queue_v1?select=*&$Q&order=created_at.desc,id.desc" \
    | jq '[.[] | {order_number, preparation_state}]'
done

for P in 1 2 50; do
  for STATE in needs_packing packed_needs_delivery; do
    if [ "$STATE" = needs_packing ]; then BASE=("${BASE_PACK[@]}"); else BASE=("${BASE_RECOVER[@]}"); fi
    R=$(walk "order_preparation_queue_v1?select=*&organization_id=eq.$ORG&preparation_state=eq.$STATE" "$P") \
      || { echo "$STATE P=$P: STOPPED"; continue; }
    echo "$STATE P=$P"; check "$R" "${BASE[@]}"
  done
done
```

- [ ] `needs_packing` count = 3 (F1, F2, F3). `packed_needs_delivery` count = 3
      (F4, F7, F8). Either is fewer by exactly the fixtures recorded N/A.
- [ ] Rows carry every `orders` column plus `preparation_state` (the app maps
      them as orders).
- [ ] Every walk (`P` = 1, 2, 50, both states) has `check` print the PASS line
      for 3 rows (fewer only by fixtures recorded N/A), with no `STOP` or `FAIL`.
      The §2.2 stop conditions apply.

Browser keys are refused (no rows can leak):

```sh
curl -sS -o /dev/null -w "%{http_code}\n" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  "$API/order_preparation_queue_v1?select=id&limit=1"
```

- [ ] Not `200` (expected `401`, permission denied / `42501`). Repeat with a
      signed-in member's JWT: also refused.

### 2.4 The app, end to end

- [ ] On the staging preview, as Owner: the chips read Payment due 13, Needs
      preparation 3, Packed · Needs delivery 3, Waiting for pickup 5 (the §1
      totals). Each list shows exactly the expected orders, with the reasons and
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
     walks P=1/2/50 vs BASE_WAIT:   PASS / FAIL ; same-instant: no tie in fixture / tie crossed
§2.3 preparation view list/count/pagination/browser refusal:  PASS / FAIL
     walks P=1/2/50 vs BASE_PACK / BASE_RECOVER:  PASS / FAIL
§2.4 app end to end:            PASS / FAIL
§2.5 cost (largest tenant, ms): count __ / page __ / waiting __ ; PostgREST __
Fixtures N/A (not reachable):
Residual risks:
```
