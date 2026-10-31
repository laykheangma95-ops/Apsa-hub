# Payment lifecycle policy — PROPOSAL FOR OWNER APPROVAL

**Status:** proposed, not approved. It is not a source-of-truth document and does
not amend `CORRECTIONS.md`, `DATA_MODEL.md` or `UX_FLOWS.md`. If it is approved,
the owner records it as a correction there; until then migration
`068_payment_lifecycle_guard.sql` (number provisional) stays a draft and is not
applied anywhere hosted.

**Implementation:** branch `claude/apsa-payment-lifecycle-repair-tr4x4e` —
`supabase/migrations/068_payment_lifecycle_guard.sql`,
`src/server/payments/service.ts` (409 mapping), `src/lib/payments.ts` (client
messages), tests in `src/tests/payment-lifecycle-guard-pg.runtime.ts`.

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
confirmed or rejected (COD included); **claimed** = received + pending.

| #   | Rule                                                                                                                                                                                                      | Enforced by 068 as                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **No deposits on drafts.** A draft is "not a sale yet" (migration 023). Payment starts once the order is confirmed.                                                                                       | `record_payment_v2`: lifecycle ≠ `confirmed` → `order_not_payable` (also cancelled and completed). `verify_payment_v1`: confirming a claim on a draft → `order_not_payable`. |
| P2  | **No newly recorded amount above the unclaimed order total.** The amount recorded is the amount the business keeps for this order.                                                                        | `record_payment_v2`: claimed + amount > total → `exceeds_outstanding` (with the remaining amount).                                                                           |
| P3  | **Pending claims, COD included, reserve the total.** A recorded claim holds its share of the total until it is confirmed, rejected (mismatch) or reversed.                                                | Counted in "claimed" for P2; rejecting or reversing a claim frees it; moving a rejected claim back to pending is refused if it no longer fits.                               |
| P4  | **Refunds do not reopen collection on the same sale.** A refund returns money; it does not turn the order back into "owed". A further sale is a new order.                                                | P2 measures _received_, which keeps a refunded principal (DATA_MODEL: "refunds do not undo the fact that money was received").                                               |
| P5  | **An existing payment may still be confirmed after cancellation**, so that money already received can be refunded (refunds act only on confirmed payments). No new payment is taken on a cancelled order. | `verify_payment_v1` does not refuse cancelled orders; only the balance rule applies.                                                                                         |
| P6  | Completed orders take no new payment (they are already paid in full).                                                                                                                                     | P1/P2.                                                                                                                                                                       |

Every refusal writes nothing: no payment, payment event, order history or audit
row. The idempotent retry of an already-recorded payment still replays (it is
answered before these rules), so a lost response never becomes a refusal.

Server errors (`src/server/payments/service.ts`): HTTP 409
`order_not_payable` and 409 `payment_exceeds_outstanding`, for record and
confirm alike. The client shows a specific message for each
(`payments.errors.order_not_payable` / `payments.errors.exceeds_outstanding`, en
and km — **the Khmer text needs native review**).

## 3. Cashier workflow: giving change without recording false cash

The ledger records **what the business keeps for this order**, never what was
tendered.

Example — order total ៛34,000, customer hands over ៛50,000:

1. The order is confirmed (POS confirms before payment).
2. The cashier takes ៛50,000, gives back ៛16,000 change from the drawer.
3. The cashier records **cash ៛34,000**. The drawer moved +50,000 − 16,000 =
   +34,000, which is exactly the ledger. End-of-day cash counts reconcile.
4. Recording ៛50,000 is refused (`exceeds_outstanding`, "Record only the amount
   that is outstanding") — it would claim ៛16,000 the business never kept.

Split tender — total $20.00, $10.00 by KHQR then cash: record KHQR $10.00, then
cash $10.00 (the remaining amount the refusal reports), giving change from the
cash handed over as above.

COD — the order is confirmed and COD recorded for the total (pending). On
delivery:

- courier hands over the full amount → confirm the COD claim;
- customer paid by KHQR instead → reject (mismatch) or reverse the COD claim
  first, then record the KHQR payment (P3 refuses it while the COD claim stands);
- courier collected less → reject the COD claim and record what was actually
  handed over (a payment's amount is immutable; it is never edited down).

**Gaps in today's UI (not changed on this branch — Lovable-owned surfaces):**

- The real POS path has no "cash received / change" helper; that helper exists
  only in the prototype `/design` path. The cashier types the amount into the
  shared Record payment sheet, which starts empty.
- That sheet's hint reads _"Order total {amount}. Record only what was handed
  over this time."_ (`order.recordPaymentSheet.amountHint`). Under P2 "handed
  over" invites recording the tendered ៛50,000. Proposed copy: _"Order total
  {amount}. Record the amount kept for this order — give change separately."_
  Proposed UX: prefill the remaining amount, and add an optional cash-received
  field that only computes change.

## 4. Contradictions and tensions with existing rules — owner must resolve

1. **Overpayment is already treated as a reviewable state, not a forbidden one.**
   `src/server/payments/reconciliation.ts` flags `overpaid` (net > total, "Check
   this with the customer"), and DATA_MODEL's refund-status rule "includes
   overpayments". P2 removes the way new overpayments arise. For **cash** that
   is correct (change is given in hand). For **KHQR / bank transfer** it is not
   neutral: if a customer transfers $105 for a $100 order, the money really
   arrived in the bank, but APSA can only record $100, so bank-statement
   reconciliation shows $5 APSA does not know about, and returning it is a real
   refund APSA cannot represent. Owner options:
   - (a) P2 as proposed; the excess is returned outside APSA and noted on the
     payment — simplest, but leaves an unrecorded bank movement;
   - (b) allow an overpayment for non-cash methods only, recorded at its true
     amount, kept flagged `overpaid` until the excess is refunded through APSA;
   - (c) allow it for every method with a mandatory reason.
2. **Refunds and re-collection (P4).** Reconciliation measures _net_ (received −
   refunded) while P2 measures _received_. After "$100 paid, $20 refunded" the
   order is `paid / partial`, reconciliation shows net $80 (not overpaid), yet P2
   refuses collecting $20 again. That is consistent with DATA_MODEL, but a
   refund made in error can then only be corrected with a new order. Owner
   option: measure P2 against net instead (a refund reopens collection).
3. **Legacy over-claims become unrefundable.** 068 refuses to _confirm_ a
   pending claim that would push received above the total. If such a claim was
   recorded before 068 and the money genuinely arrived, it can be rejected or
   reversed, but not confirmed — and refunds require a confirmed payment. The
   inventory (§6, row 04.01) counts these; each needs a decision before 068 is
   applied.
4. **Payment before confirmation in older sketches.** MVP_ROADMAP §13's flat
   list (DRAFT → PENDING_PAYMENT → PAID → CONFIRMED) and UX_FLOWS §38 ("Pending
   Payment: Record Payment…; Paid: Confirm…") describe paying before confirming.
   Migration 023 replaced that list with three axes in which a draft is "not a
   sale yet", and the shipped screens (Order detail, POS) already pay only after
   confirmation. P1 matches the implementation; the owner should retire the old
   sketch or decide that deposits on drafts are needed (which would also need a
   refund path when a draft is discarded).
5. **Paid orders may still be cancelled** — left open by migration 063 and not
   decided here. P5 keeps the refund path open after such a cancellation.
6. **Delivery COD amounts** (`deliveries.cod_amount_minor`) are operational and
   are not read by 068; a courier's COD figure larger than the order total is
   not refused by this policy.

## 5. Choices that would change the implementation

| Decision                      | As drafted              | Alternative and its effect                                                                                                      |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Draft deposits                | refused                 | allow on drafts → need a refund path on discard and a rule for deposits on cancelled drafts                                     |
| Overpayment                   | refused for all methods | allow for KHQR/bank (or all) → recorded at true amount, flagged `overpaid`, refunded through APSA                               |
| Balance measure               | received + pending      | net + pending → a refund reopens collection                                                                                     |
| Pending COD                   | reserves the total      | ignore pending COD → two methods may be recorded for one total; the second confirmed would overpay                              |
| Confirming legacy over-claims | refused                 | allow confirmation (then refund) → legacy money refundable, but overpaid orders can still be created through old pending claims |

## 6. Legacy data — inventory and review before 068 is applied

`scripts/sql/apsa_068_payment_legacy_inventory.sql` — read-only (one
`READ ONLY` transaction, then `ROLLBACK`), aggregates only (counts and per-
currency minor-unit sums; no order, payment, customer, organization or reference
identifier). The owner runs it on staging with `psql` (see its header); it was
**not** run on any hosted database from this branch. It is exercised by the
native PostgreSQL tests against seeded legacy states.

| Row           | State                                        | Effect of 068                                  | Review / correction before applying                                                                                               |
| ------------- | -------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 01.01         | pending claim on a cancelled order           | still confirmable (P5), rejectable, reversible | Did the money arrive? Yes → confirm, then refund. No → reject (mismatch) or reverse.                                              |
| 01.02         | pending claim on a completed order           | confirmation refused (over total)              | Almost always a duplicate or a wrong order → reject or reverse. If money really arrived → decision under §4.1/§4.3.               |
| 01.03         | cancelled order still holding received money | none (refund still possible)                   | Refund the customer, or record why the money is kept (owner decision from 063).                                                   |
| 02.01         | received above the total                     | none directly; the order takes no new claim    | Refund the excess on the payment that over-collected (refund is allowed: the payment is confirmed).                               |
| 02.02         | claimed above the total                      | new claims refused                             | Resolve the pending claims (confirm / reject / reverse) until claimed ≤ total.                                                    |
| 02.03         | reconciliation `overpaid` (net > total)      | none                                           | Same as 02.01; listed to compare with the existing screen.                                                                        |
| 03.01         | pending claim on a draft                     | confirmation refused                           | Confirm the order if it is a real sale (then the claim is judged normally), or reject/reverse the claim.                          |
| 03.02 / 03.03 | confirmed (or refunded) payment on a draft   | none; draft cannot take new money              | Confirm the order if the sale happened; otherwise refund and cancel the draft.                                                    |
| 04.01         | pending claims 068 refuses to confirm        | stranded unless resolved                       | Per claim: reject/reverse if no money arrived; if money arrived, the owner chooses §5 row 5 or a refund outside APSA with a note. |
| 04.02         | rejected claims 068 refuses to reinstate     | stays rejected                                 | Usually correct (another payment replaced it). If the rejection was itself wrong, resolve before applying 068.                    |

Order of operations for the owner: run the inventory on staging → review each
non-empty row with the merchant data owner, through the application's normal
audited actions (confirm / reject / reverse / refund) — **never by direct SQL
edits of payment rows** (payment history is append-only) → re-run the inventory
→ decide on 068.

## 7. Migration number

Provisional `068`. At the time of writing: main ends at `064`; PR #137 adds
`065_order_preparation_queue`; PR #139 (which contains main and #137) adds
`065` + `066_pack_order_round_guard`; PR #136 (behind main) still carries a
competing `065_order_parcel_workflow` that has to be renumbered — `067` if it
lands after #139. 068 has been applied successfully after #139's sequence alone
and after #139 + #136-as-067; it re-declares only two payment functions and does
not depend on 065–067. The final number is chosen when this branch is rebased
after those PRs land; if #136 lands with a different number, 068 follows it.
