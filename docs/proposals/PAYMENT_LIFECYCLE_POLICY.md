# Payment lifecycle policy — PROPOSAL FOR OWNER APPROVAL

**Status:** proposed, not approved. It is not a source-of-truth document and does
not amend `CORRECTIONS.md`, `DATA_MODEL.md` or `UX_FLOWS.md`. If it is approved,
the owner records it as a correction there; until then migration
`068_payment_lifecycle_guard.sql` (number provisional) stays a draft and is not
applied anywhere hosted.

**Implementation:** branch `claude/apsa-payment-lifecycle-repair-tr4x4e` —
`supabase/migrations/068_payment_lifecycle_guard.sql`,
`src/server/payments/service.ts` (409 mapping), `src/lib/payments.ts` (client
messages), tests in `src/tests/payment-lifecycle-guard-pg.runtime.ts` and
`src/tests/payment-excess-pg.runtime.ts`.

**Everything in this document is implemented as a draft and awaits the owner's
approval** — including the "record with excess" workflow of §4, built to the
pilot policy the owner proposed and repaired after an independent review
(§4.5). The questions still open are listed in §4.4.

---

## 1. The defect this policy closes

Reproduced on PostgreSQL 16 against main's migrations: a member holding
`payments.record` and `payments.manual_confirm` could record and confirm money
on a **draft** order, on a **cancelled** order (also when the Record Payment
request was queued behind the cancellation on the order lock), on an already
**completed** order, and for **any amount** on a confirmed order. Each produced
`payment_status = paid` or `received_minor` above the order total. No layer —
SQL, service, API or UI — checked the order's lifecycle or balance. The Order
detail screen hid the control on draft/cancelled orders and claimed the rule was
"re-checked server-side"; it was not.

## 2. Proposed pilot policy

Terms: **received** = money the ledger counts as received
(`order_payment_totals.received_minor`); **pending** = recorded claims not yet
confirmed or rejected (COD included); **claimed** = received + pending;
**net** = received − refunded (what reconciliation compares with the total).

| #   | Rule                                                                                                                                                                                                                              | Enforced by 068 as                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **No deposits on drafts.** A draft is "not a sale yet" (migration 023). Payment starts once the order is confirmed.                                                                                                               | `record_payment_v2`: lifecycle ≠ `confirmed` → `order_not_payable` (also cancelled and completed).                                                                                                                                                             |
| P2  | **No newly recorded amount above the unclaimed order total.** The amount recorded is the amount the business keeps for this order.                                                                                                | `record_payment_v2`: claimed + amount > total → `exceeds_outstanding` (with the remaining amount).                                                                                                                                                             |
| P3  | **Pending claims, COD included, reserve the total** until confirmed, rejected (mismatch) or reversed.                                                                                                                             | Counted in "claimed"; rejecting or reversing frees it; reopening a rejected claim (mismatch → unverified) is a new claim → `claim_exceeds_total`.                                                                                                              |
| P4  | **Refunds do not reopen collection on the same sale.** A refund returns money; it does not make the order "owed" again. A further sale is a new order.                                                                            | P2 measures _received_, which keeps a refunded principal (DATA_MODEL: "refunds do not undo the fact that money was received").                                                                                                                                 |
| P5  | **Confirmation never strands money that arrived.** An existing claim can always be confirmed — after a cancellation, on a legacy draft, or above the total — so that it can be refunded (refunds act only on confirmed payments). | `verify_payment_v1` never refuses pending → paid. A confirmation that takes received above the total stamps the excess on its own immutable event (`order_excess_minor`, `order_total_minor`); reconciliation then shows "Overpaid by …" until it is refunded. |
| P6  | Completed orders take no new payment (they are already paid in full).                                                                                                                                                             | P1/P2.                                                                                                                                                                                                                                                         |

After P2/P3, an ordinary claim recorded under 068 always fits the total, so P5
creates an excess only for a claim recorded **before** 068 (§7) or for a payment
recorded through the "record with excess" workflow of §4 — the only way new
excess money enters the ledger.

Every refusal writes nothing: no payment, payment event, order history or audit
row. The idempotent retry of an already-recorded payment still replays (it is
answered before these rules), so a lost response never becomes a refusal.

Server errors (`src/server/payments/service.ts`), all HTTP 409, and the client
message each shows (`src/lib/payments.ts`, en + km — **the Khmer needs native
review**):

| Code                          | When                                        | English message                                                                                                                            |
| ----------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `order_not_payable`           | record on a draft / cancelled / completed   | This order cannot take a payment now. Only a confirmed order that is not yet completed can.                                                |
| `payment_exceeds_outstanding` | record above the unclaimed total            | That is more than the order still owes. Record only the amount that is outstanding.                                                        |
| `payment_claim_exceeds_total` | reopen a rejected claim that no longer fits | Other payments already cover this order's total, so this claim can't be reopened. Reverse or flag the other payment first if it was wrong. |

## 3. Cashier workflow: giving change without recording false cash

The ledger records **what the business keeps for this order**, never what was
tendered. Change is a drawer movement, not a payment.

Order total ៛34,000, customer hands over ៛50,000:

1. The order is confirmed (POS confirms before payment).
2. The cashier takes ៛50,000 and gives ៛16,000 back from the drawer.
3. The cashier records **cash ៛34,000**. The drawer moved +50,000 − 16,000 =
   +34,000 — exactly the ledger; the end-of-day count reconciles.
4. Recording ៛50,000 is refused (`exceeds_outstanding`).

Split tender — total $20.00, $10.00 by KHQR, rest in cash: record KHQR $10.00,
then cash $10.00 (the remaining amount the refusal reports), giving change from
the cash handed over.

COD — confirmed order, COD recorded for the total (pending). On delivery:

- courier hands over the full amount → confirm the COD claim;
- customer paid by KHQR instead → reject (mismatch) or reverse the COD claim,
  then record the KHQR payment (P3 refuses it while the COD claim stands);
- courier collected less → reject the COD claim and record what was actually
  handed over (a payment's amount is immutable; it is never edited down).

**Copy changed on this branch** (the old copy told the cashier to record the
tendered cash, which was wrong before 068 too: it produced a false
"overpaid"): `order.recordPaymentSheet.body` — "Write down the money kept for
this order…"; `order.recordPaymentSheet.amountHint` — "Order total {amount}.
Record the amount kept for this order — give any change back separately." (en,
km).

**Not changed (Lovable-owned UI):** the real POS path has no cash-received /
change helper (it exists only in the prototype `/design` path,
`PosCheckoutSheet.tsx` "prototype cash path only"); the cashier types the
amount into an empty sheet. Proposed UX: prefill the remaining amount; an
optional "cash received" field that only computes change.

## 4. Real overpayment — "record with excess" (implemented, DRAFT)

A customer transfers **$105 by KHQR for a $100 order.** Before this workflow
(verified on native PostgreSQL with the rest of 068 applied) there was no
truthful path: recording $105 was refused, and "recording $100 then refunding
$5" left the ledger saying the sale was partially refunded (net $95, no
overpaid flag) while the bank showed +$105 / −$5.

### 4.1 Pilot policy (proposed by the owner)

1. Ordinary Record payment refuses any amount above the unclaimed order total.
2. A separate manager-level permission controls "Record with excess".
3. Bank transfer and KHQR only; a transfer reference and a reason are
   required; the full amount actually received is recorded.
4. The excess is refunded through the existing audited refund. Customer credit
   is out of scope.
5. Refund ledger semantics are preserved. "Excess returned" is shown only when
   the recorded excess and the refund evidence support it.
6. Cash tendered and change stay separate from the amount retained (§3).
7. **Scope: a transfer that exceeds a still-positive order balance.** When
   nothing is outstanding (the order is fully claimed), money that arrives is
   an _unallocated receipt_ — outside this feature — and is never attached to
   the paid order (`nothing_outstanding`).
8. **Cash and COD excess is change.** It is handed back at once (by the
   cashier, or by the courier on delivery) and only the amount kept is
   recorded. Cash and COD are never recorded through "record with excess".
9. **One transfer, one recording.** A transfer reference recorded with excess
   is exclusive (§4.5 B2).

### 4.2 What was built (migration 068, provisional number)

| Piece                                          | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permission `payments.record_excess` (critical) | Seeded to OWNER and MANAGER. Returning the excess needs `payments.refund`, which stays OWNER-only (036).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `record_payment_with_excess_v1`                | Under the order lock (then the same reference lock as ordinary recording): confirmed order; `khqr`/`bank_transfer`; reference, reason, idempotency key and **the outstanding amount the member was shown** required. A different outstanding amount → `stale`, nothing written. Amount ≤ outstanding → `no_excess`. Records the full amount as an ordinary pending / unverified claim (duplicate_suspected when the reference matches another active payment). The created event carries `excess_minor`, `expected_outstanding_minor`, `order_total_minor`. Mandatory audit `payments.record_excess` in the same transaction. Same-key replay only for the original member's original request. |
| Confirmation                                   | The ordinary verify step. The reference proves nothing: the claim settles only when a member confirms it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `return_payment_excess_v1`                     | Calls `refund_payment_v2` (key, acknowledgement, expected total, mandatory `payments.refund` audit — unchanged), bounded to LEAST(recorded excess − already returned, net − total), so it never returns part of the sale. Writes an `excess_returned` event naming the refund event, and audit `payments.return_excess`, in the same transaction.                                                                                                                                                                                                                                                                                                                                              |
| "Excess returned" label                        | Shown on a refund only when an `excess_returned` event names it. A refund made through the ordinary refund is never labelled, even when it equals the excess. A legacy over-claim (no recorded excess) is returned by the ordinary refund and is not labelled.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| UI                                             | Order detail: "Record a transfer above the total" for members holding the grant, beside Record payment, with the server's outstanding figure. Payment detail: "Recorded with an excess of …", "Still to return …", "Return the excess" (the refund sheet in excess mode), and the "Excess returned" chip on labelled refunds.                                                                                                                                                                                                                                                                                                                                                                  |

Refund semantics: after the excess is returned, the order is `paid / partial`
(money was returned) and net = total; the "Overpaid by …" warning clears.
`refund_status = partial` keeps its ledger meaning — some money went back —
also when only an excess was returned. Once an `excess_returned` event exists
the Payment detail explains it from the order's **current** accounting
(`payment_excess_state_v1` returns the order's net and total): while net ≥
total, "partly refunded because the excess was returned; the sale itself is
still paid in full"; after a later ordinary refund of part or all of the sale
(e.g. 105 received, 5 returned, then 20 or everything refunded), "the excess
was returned, and part or all of the sale has been refunded since" — never
"paid in full".

### 4.3 Server errors (all HTTP 409 unless noted)

| Code                                    | When                                                                 |
| --------------------------------------- | -------------------------------------------------------------------- |
| `payment_outstanding_changed`           | the outstanding amount changed since the screen showed it            |
| `payment_nothing_outstanding`           | nothing is outstanding (fully claimed, or legacy over-claimed)       |
| `payment_duplicate_transfer_reference`  | the canonical reference is held by another payment (§4.5 B2)         |
| `payment_excess_reinstatement_required` | ordinary reinstatement of a payment recorded with excess             |
| `payment_excess_changed`                | reinstatement: other claims changed the excess since it was recorded |
| `payment_no_excess`                     | the amount is not above the outstanding amount                       |
| `order_not_payable`                     | draft / cancelled / completed order                                  |
| `payment_no_recorded_excess`            | "return the excess" on a payment recorded without one                |
| `payment_exceeds_returnable_excess`     | more than the excess still returnable                                |
| `idempotency_conflict`                  | a reused key for a different request                                 |
| 400                                     | missing reference / reason / key / outstanding; cash, COD            |
| 403                                     | missing `payments.record_excess` / `payments.refund`                 |

### 4.4 Questions still open for the owner

1. Is MANAGER the right tier for `payments.record_excess`, or OWNER only?
2. Should returning the excess stay OWNER-only (`payments.refund`), or should a
   manager be able to return an excess they recorded (a capped refund was left
   open in 036)?
3. ~~Should an unreturned excess appear as work to do?~~ Payments now has the
   "Excess to return" view (§4.5 B3). Home attention is deliberately not part
   of this repair; whether Home should show it stays open.
4. Wording, especially Khmer (**needs native-speaker review**).

### 4.5 Repairs after the independent review

**B1 — a positive balance is required.** `record_payment_with_excess_v1`
refuses `nothing_outstanding` when the authoritative outstanding amount
(total − received − pending claims, read under the order lock) is zero or
below zero (legacy over-claims), before any write. Order detail offers the
action only while the server's outstanding figure is positive.

**B2 — exclusive transfer references.**

- Canonical form, `payment_reference_canonical_v1`: every whitespace
  character removed (leading, trailing, internal — spaces, tabs, line breaks,
  NBSP, zero-width characters, BOM), then lower-cased; an empty result is
  "reference required". `TRF-P1`, `trf-p1 `, `TRF - P1` are one reference.
  Punctuation, leading zeros and prefixes are kept — nothing
  provider-specific. Trade-off: two identifiers that differ only in case or
  spacing collapse into one; that refuses a recording visibly (recoverable),
  whereas missing a collision would count one transfer twice.
- Scope: organization + payment method + canonical reference.
- Held by a payment that is **pending, paid or refunded** (a refunded
  transfer still happened). **Released** by **reversed** (the record was
  wrong) and by **rejected** (verification mismatch — no longer a claim; a
  rejected payment cannot be reversed, so this is what keeps a mistaken
  rejection recoverable). Taking a rejected claim back rechecks the
  reference under the same lock.
- One ownership rule for every writer of a holding payment's reference: a
  payment recorded with excess may not share its canonical reference with any
  other holder; an ordinary payment may not share one with a holder recorded
  with excess. It is applied to recording ("record with excess" and ordinary
  recording), to taking a rejected claim back (both reinstatements) and to
  reference **correction** (`correct_payment_v2`) — each refuses
  `duplicate_transfer_reference` and writes nothing (no reference change,
  event or audit row). Ordinary references among themselves keep the 035 rule
  (flagged `duplicate_suspected` when recorded, never refused — also when
  corrected).
- Race safety: every writer takes a canonical-reference advisory lock after
  the order lock and rechecks after the wait; a partial unique index over
  payments recorded with excess (`uniq_payments_excess_reference_held`) is
  the database's own backstop. Existing rows are untouched
  (`payments.excess_recorded` defaults to false), so no historical data meets
  the index.
- The sheet's idempotency key is kept per member + organization + order in
  this tab's session storage (`src/lib/excess-intent.ts`, the refund-intent
  pattern): the same request after a reload replays. Every request whose
  outcome is unknown keeps its own key; a different (e.g. mistyped) request
  never displaces or overwrites one.
- **Settlement** — an entry is removed only by: a payment in the response
  (made now or replayed); one of the database's write-free refusals —
  `order_not_payable`, `nothing_outstanding`, `stale` (outstanding changed),
  `no_excess`, `duplicate_transfer_reference`, which
  `record_payment_with_excess_v1` reaches only after answering a replay of the
  same key — identified by structured code or by its **exact** message from
  `src/lib/payment-refusals.ts` (the only text that survives the
  server-function wire; the boundary sanitizes every non-public error); or the
  member explicitly forgetting that attempt (after confirming it was not
  recorded) or starting over. Network errors, timeouts, malformed or unknown
  responses, sanitized server errors and refusals raised before the database
  (permission, principal, rate limit, validation, not found, idempotency
  conflict) keep the key, and the member is told the outcome is unknown and
  how to check it. What is _shown_ and whether the key is _settled_ are
  separate decisions; neither uses substring matching any more.
- **Capacity** — at most 5 unknown attempts per order and 50 orders/members
  per tab. A new attempt beyond either is refused before anything is sent;
  no key is ever evicted. Storage refusing the write (quota) refuses the
  attempt too. There is no expiry. Remaining limit: closing the tab, clearing
  site data, or another tab/device loses the keys — then the order's payment
  list (and Payments → "Excess to return") shows what was recorded, and the
  server refuses a second recording of the same reference.
- A lost response can leave the order owing nothing (the recording
  committed). Order detail then offers **"Check a transfer you recorded"**
  instead of the ordinary action: re-entering the same details replays under
  the retained key (the server answers a replay before any balance rule);
  anything else is refused (`nothing_outstanding`, or the duplicate
  reference), so nothing new is ever recorded against zero.
- The partial unique index covers **only excess vs excess**. An
  ordinary/excess collision — in either direction, including by correction —
  is refused by the ownership rule under the reference lock, never by the
  index (an earlier draft of this document wrongly said the index refused
  correction collisions; it does not see ordinary payments).
- `correct_payment_v2` now takes the order lock first (040's Order BEFORE
  Payment), then the payment, then the reference lock — the order
  reinstatement uses.
- Residual: an owner-level, audited correction of an ordinary payment's
  reference into one held by another ordinary payment is not refused (the 035
  rule, unchanged).

**B3 — "Excess to return" in Payments.** A chip on the Payments list for
members holding `payments.reconcile` (Owner, Manager), backed by
`list_excess_to_return_v1`: one statement, exact total, deterministic pages
(newest first; ties by kind, order id, payment id), organization-scoped. Rows:
_To return_ (confirmed, returnable > 0 — the payment-detail figure),
_Awaiting confirmation_ (pending, its recorded excess) and _Overpaid order_
(legacy: net > total and no payment recorded with excess — returned through
the ordinary refund). One row per payment or per order, never multiplied by
events or refunds.

**M1 — the returnable amount is the server's.** `payment_excess_state_v1`
computes `max(0, min(recorded excess − linked excess returns, net − total))`,
0 unless the payment is confirmed. The return function, the payment detail and
the list all use it. Return the excess is offered only when it is positive;
an ordinary refund that already brought net to the total leaves nothing to
return, and the screen says so.

**M2 — recovering a mistaken rejection.** `reinstate_excess_payment_v1`
(`payments.record_excess`) takes a rejected payment recorded with excess back
to pending on the same payment row (no second row, created event untouched)
when, under the order lock, the order is confirmed, the other claims leave a
positive outstanding amount that equals the one it was recorded against, and
no other payment holds its reference. It writes the verification event
(`excess_reinstated`) and the audit row `payments.reinstate_excess`. If other
claims changed the excess (`excess_changed`), the transfer is recorded again
with its new excess — the rejection released the reference, and the old row
can never be reinstated afterwards (nothing is outstanding for it). The
ordinary reinstatement refuses such a payment.

**Small repairs.** Ordinary refund and excess-return keys are
domain-separated in the browser (a lost ordinary refund is never re-sent as an
excess return); inventory row 04.01 counts a draft claim only when confirming
it would take received money above the total.

## 5. Other tensions with existing rules

1. **Refunds and re-collection (P4).** Reconciliation compares _net_ with the
   total; P2 compares _received_. After "$100 paid, $20 refunded" the screen
   shows Received $100 / Refunded $20 / Net $80, no warning, order `paid /
   partial`, and recording $20 again is refused. Nothing on the screen claims
   $20 is due (the real Order detail shows no outstanding figure; the next
   action follows `payment_status = paid`), so the UI is consistent with P4. A
   refund made in error can only be corrected with a new order. Alternative:
   measure P2 against net (a refund reopens collection) — then a refunded sale
   can be collected again on the same order.
2. **Payment before confirmation in older sketches.** MVP_ROADMAP §13 (DRAFT →
   PENDING_PAYMENT → PAID → CONFIRMED) and UX_FLOWS §38 describe paying before
   confirming. Migration 023 replaced that list; shipped screens pay only after
   confirmation. P1 matches the implementation; the old sketch should be
   retired or deposits on drafts designed (with a refund path on discard).
3. **Paid orders may still be cancelled** — left open by 063. P5 keeps the
   refund path open after such a cancellation.
4. **Delivery COD amounts** (`deliveries.cod_amount_minor`) are operational and
   are not read by 068.
5. **Two real payments for one total** (COD rejected, KHQR recorded, then the
   courier's cash turns out to be real too): the COD claim cannot be reopened
   (`claim_exceeds_total`). The cash is change: it goes back to the customer
   (§4.1 rule 8) and is not recorded. "Record with excess" is bank / KHQR only.

## 6. Decision table

| Topic                                                   | Recommended rule (as drafted unless noted)         | Alternative                                                     | Consequence of the alternative                                                   | Code / data repair needed                      |
| ------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------- |
| Draft deposits                                          | refused (P1)                                       | allowed                                                         | discard of a draft needs a refund path; deposits on cancelled drafts need a rule | none for P1; legacy draft claims per §7 (03.x) |
| Recording above the total                               | refused for normal recording (P2)                  | allowed with a reason                                           | overpayment becomes a cashier action                                             | none                                           |
| Real overpayment (bank/KHQR)                            | "record with excess" (§4) — **implemented, draft** | (a) excess returned outside APSA; (c) any member, with a reason | (a) bank movement APSA cannot see; (c) overpayment becomes a cashier action      | done on this branch; §4.4 questions open       |
| Pending COD                                             | reserves the total (P3)                            | ignored                                                         | two methods can be recorded for one total; confirming both overpays              | none                                           |
| Refund reopens balance                                  | no (P4)                                            | yes (measure net)                                               | a refunded sale can be collected again on the same order                         | 068: use net instead of received in the claim  |
| Confirming a legacy claim above the total or on a draft | allowed, excess stamped (P5) — **implemented**     | refused (the previous draft)                                    | money that arrived can be neither confirmed nor refunded                         | done on this branch                            |
| Reopening a rejected claim                              | refused when it no longer fits (P3)                | allowed                                                         | a second claim for an already covered total                                      | none                                           |
| Cancel a paid order                                     | open (063)                                         | —                                                               | —                                                                                | separate decision                              |

## 7. Legacy data — inventory and review before 068 is applied

`scripts/sql/apsa_068_payment_legacy_inventory.sql` — read-only (one
`READ ONLY` transaction, then `ROLLBACK`), aggregates only (counts and
per-currency minor-unit sums; no order, payment, customer, organization or
reference identifier). The owner runs it on staging with `psql` (see its
header); it was **not** run on any hosted database from this branch. The native
PostgreSQL tests seed every state through the real pre-068 functions and assert
its counts, and then show 068's behaviour on exactly those claims.

Every correction goes through the application's audited actions — confirm,
reject (mismatch), reverse, refund — never a direct edit of payment rows
(payment history is append-only).

| Row           | State                                                                                                                                                                                                            | Under 068                                           | Bounded path                                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01.01         | pending claim on a cancelled order                                                                                                                                                                               | confirmable, rejectable, reversible                 | Money arrived → confirm, then refund. Did not → reject.                                                                                                                                 |
| 01.02         | pending claim on a completed order                                                                                                                                                                               | confirmable; excess stamped, order flagged overpaid | Duplicate / wrong order → reject or reverse. Money really arrived → confirm, then refund the excess on that payment.                                                                    |
| 01.03         | cancelled order still holding received money                                                                                                                                                                     | refund possible                                     | Refund, or record why it is kept (063 decision).                                                                                                                                        |
| 02.01 / 02.03 | received (net) above the total                                                                                                                                                                                   | no new claim on the order                           | Refund the excess on the payment that over-collected (it is confirmed).                                                                                                                 |
| 02.02         | claimed above the total                                                                                                                                                                                          | no new claim; pending claims confirmable            | Resolve each pending claim: confirm (then refund any excess) or reject/reverse.                                                                                                         |
| 03.01         | pending claim on a draft                                                                                                                                                                                         | confirmable (P5); draft takes no new money          | Real sale → confirm the order, then the claim. Not a sale but money arrived → confirm the claim, refund it, cancel the draft. No money → reject.                                        |
| 03.02 / 03.03 | confirmed / refunded payment on a draft                                                                                                                                                                          | refund possible                                     | Real sale → confirm the order. Otherwise refund, then cancel the draft.                                                                                                                 |
| 04.01         | pending claims whose confirmation would take received money above the total                                                                                                                                      | confirmable; excess stamped                         | As 01.02 / 02.02: confirm-then-refund only when the money is real.                                                                                                                      |
| 04.02         | rejected claims that cannot be reopened: reinstating them would take received + pending above the total (the rule has no lifecycle condition — a rejected draft claim that fits is reinstatable and not counted) | stays rejected                                      | Usually right. If both payments are real: bank / KHQR money is returned through the ordinary refund of the confirmed payment; cash / COD money is change, handed back and not recorded. |

Order of operations: run the inventory on staging → review each non-empty row
with the merchant's data owner → resolve through the audited actions → re-run
the inventory → decide on 068.

## 8. Migration number

Provisional `068`. Main ends at `064`; PR #137 adds
`065_order_preparation_queue`; PR #139 (which contains main and #137) adds
`065` + `066_pack_order_round_guard`; PR #136 (behind main) still carries a
competing `065_order_parcel_workflow` that has to be renumbered — `067` if it
lands after #139. 068 applies and behaves correctly after #139's sequence alone
and after #139 + #136-as-067; it re-declares only two payment functions and does
not depend on 065–067. The final number is set when this branch is rebased
after those PRs land.
