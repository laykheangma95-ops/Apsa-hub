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

**Open owner decision that blocks 068:** §4 — how a real overpayment (a bank or
KHQR transfer above the order total) is recorded and returned. Everything else
in this document is implemented as drafted and can be accepted or changed.

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

After P2/P3, a claim recorded under 068 always fits the total, so P5 can only
create an excess for a claim recorded **before** 068 (§6). New excess money
needs the overpayment workflow of §4, which is not yet decided.

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

## 4. Real overpayment — OWNER DECISION REQUIRED (blocks 068)

A customer transfers **$105 by KHQR for a $100 order.** Verified on native
PostgreSQL with 068 applied:

| Step                                    | Result                                                                                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| record $105                             | refused (`exceeds_outstanding`, outstanding $100)                                                                                                                                         |
| record $100, confirm                    | succeeds — order `paid`                                                                                                                                                                   |
| "return" the $5 as a refund of the $100 | succeeds, but the ledger then says the sale was **partially refunded**: net $95 < total, `refund_status = partial`, no overpaid flag. The bank shows +$105 / −$5; APSA shows +$100 / −$5. |

So today there is **no truthful path**: either the $5 that arrived is
unrecorded, or the sale is falsely shown as partly refunded. (On main, before
068, staff could record $105, confirm it, see "Overpaid by $5", and refund $5 —
truthful, but with nothing stopping an accidental overpayment by any cashier.)

**Recommended smallest workflow — "record with excess" (not implemented):**

- A separate entry point, e.g. `record_payment_with_excess_v1`, with the same
  authority shape as 062's entry points (one function, SECURITY DEFINER, fixed
  `search_path`, EXECUTE for `service_role` only) and a separate server
  function. `record_payment_v2` and the cashier's Record payment sheet are
  unchanged, so an accidental overpayment is still refused.
- **Only `khqr` and `bank_transfer`.** Cash change is given in hand (§3); COD is
  collected by the courier against a known amount.
- **Required:** a reference (the bank/KHQR transaction id, so the excess traces
  to the statement), a reason, and `p_expected_outstanding_minor` equal to the
  outstanding amount the member was shown (an optimistic precondition — a stale
  screen or a typo is refused, as 062 does for refunds).
- **Permission:** a new manager-level grant, e.g. `payments.record_excess`, not
  in the cashier role.
- Under the order lock: lifecycle `confirmed`; amount > outstanding; records the
  full amount as an ordinary pending claim; the created event carries
  `excess_minor` = amount − outstanding; the mandatory audit row
  `payments.record_excess` commits in the same transaction (062's atomic audit
  pattern).
- Confirmation is the normal verify step (P5 already allows it; the excess is
  stamped). Reconciliation shows "Overpaid by $5" until the excess is returned
  with the normal refund (`refund_payment_v2`, ≤ the excess, reason "excess
  returned"), after which net = total and the flag clears.

Owner choices in that design:

1. Permission: new `payments.record_excess` (recommended) vs. an existing
   manager grant (e.g. `payments.override_status`).
2. Methods: KHQR + bank only (recommended) vs. all.
3. Excess handling: must be refunded (recommended) vs. may be kept as customer
   credit (store credit is not in MVP scope).
4. Whether an excess refund is shown as `refund_status = partial` (today's
   semantics: some money returned) or gets a distinct "excess returned" label —
   the latter needs a refund-kind field.

Alternatives: (a) keep 068 as is and return the excess outside APSA with a
payment note — simplest, leaves an unrecorded bank movement; (c) let
`record_payment_v2` accept an excess for any member with a reason — easiest,
but makes overpayment a normal cashier action.

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
   (`claim_exceeds_total`). This is a real overpayment and follows §4.

## 6. Decision table

| Topic                                                   | Recommended rule (as drafted unless noted)               | Alternative                                    | Consequence of the alternative                                                   | Code / data repair needed                                             |
| ------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Draft deposits                                          | refused (P1)                                             | allowed                                        | discard of a draft needs a refund path; deposits on cancelled drafts need a rule | none for P1; legacy draft claims per §7 (03.x)                        |
| Recording above the total                               | refused for normal recording (P2)                        | allowed with a reason                          | overpayment becomes a cashier action                                             | none                                                                  |
| **Real overpayment (bank/KHQR)**                        | **"record with excess" workflow (§4) — not implemented** | (a) excess returned outside APSA; (c) as above | (a) bank movement APSA cannot see; (c) see above                                 | **new entry point, permission, server function, UI — owner decision** |
| Pending COD                                             | reserves the total (P3)                                  | ignored                                        | two methods can be recorded for one total; confirming both overpays              | none                                                                  |
| Refund reopens balance                                  | no (P4)                                                  | yes (measure net)                              | a refunded sale can be collected again on the same order                         | 068: use net instead of received in the claim                         |
| Confirming a legacy claim above the total or on a draft | allowed, excess stamped (P5) — **implemented**           | refused (the previous draft)                   | money that arrived can be neither confirmed nor refunded                         | done on this branch                                                   |
| Reopening a rejected claim                              | refused when it no longer fits (P3)                      | allowed                                        | a second claim for an already covered total                                      | none                                                                  |
| Cancel a paid order                                     | open (063)                                               | —                                              | —                                                                                | separate decision                                                     |

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

| Row           | State                                            | Under 068                                           | Bounded path                                                                                                                                     |
| ------------- | ------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 01.01         | pending claim on a cancelled order               | confirmable, rejectable, reversible                 | Money arrived → confirm, then refund. Did not → reject.                                                                                          |
| 01.02         | pending claim on a completed order               | confirmable; excess stamped, order flagged overpaid | Duplicate / wrong order → reject or reverse. Money really arrived → confirm, then refund the excess on that payment.                             |
| 01.03         | cancelled order still holding received money     | refund possible                                     | Refund, or record why it is kept (063 decision).                                                                                                 |
| 02.01 / 02.03 | received (net) above the total                   | no new claim on the order                           | Refund the excess on the payment that over-collected (it is confirmed).                                                                          |
| 02.02         | claimed above the total                          | no new claim; pending claims confirmable            | Resolve each pending claim: confirm (then refund any excess) or reject/reverse.                                                                  |
| 03.01         | pending claim on a draft                         | confirmable (P5); draft takes no new money          | Real sale → confirm the order, then the claim. Not a sale but money arrived → confirm the claim, refund it, cancel the draft. No money → reject. |
| 03.02 / 03.03 | confirmed / refunded payment on a draft          | refund possible                                     | Real sale → confirm the order. Otherwise refund, then cancel the draft.                                                                          |
| 04.01         | pending claims whose confirmation creates excess | confirmable; excess stamped                         | As 01.02 / 02.02: confirm-then-refund only when the money is real.                                                                               |
| 04.02         | rejected claims that cannot be reopened          | stays rejected                                      | Usually right. If both payments are real, it is a real overpayment (§4).                                                                         |

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
