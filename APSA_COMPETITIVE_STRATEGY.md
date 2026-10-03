# APSA — COMPETITIVE STRATEGY (Founder Memo)

**Document type:** Strategy + tracked engineering backlog
**Project:** APSA — Cambodian Business Operating System / Social Commerce OS
**Market:** Cambodia-first, international-ready
**Framing:** Compete with Chinese super-app commerce platforms without fighting their war — win Cambodian merchants instead of out-subsidizing them.
**Status:** DRAFT v1 — for founder review. This document does not override any source-of-truth document; it feeds the roadmap process.

> Time-sensitive market claims about specific competitors (e.g., TikTok Shop Cambodia operations, subsidy levels) must be verified before use in investor/board materials.

---

# PART 1 — WHY CHINESE APPS WIN TODAY (be honest about it)

1. **They closed the loop; we haven't yet.** TikTok Shop-style commerce owns the full funnel — video → live → checkout → delivery → payment — inside one app, with courier density already in Phnom Penh. APSA's inbox, orders, and delivery are still mock data. The core promise — *"never lose a customer, message, order"* — is currently a UI prototype.
2. **They subsidize acquisition.** They buy GMV with discounts and free shipping. Competing on subsidies is a war we lose.
3. **Engineering velocity.** They ship AI features weekly with thousands of engineers.
4. **Data flywheel.** Every transaction feeds recommendation and credit models. More volume → better conversion → more volume.

# PART 2 — WHY APSA WINS ANYWAY (structural gaps they cannot cross)

1. **They own the marketplace; we sell the tools.** On Chinese platforms, Cambodian merchants are commodity suppliers in a race to the bottom, paying commission to a landlord. APSA is the merchant's OS and never competes with its own customer. The existing rule — no consumer marketplace in MVP — is not a limitation; it **is** the strategy.
2. **Cambodian merchants live on Facebook, Messenger, and Telegram — not inside a Chinese super-app.** Chinese platforms must pull transactions into their walled garden. APSA meets merchants where they already are. Meta/Telegram integrations are natural for us and awkward for them.
3. **Khmer is a first-class problem we already solved.** The deterministic Khmer / romanized-Khmer intent engine (284 passing tests, 225-case local corpus, phone/address flagging, confidence gating) is hard to replicate and worthless to platforms optimized for English/Chinese-first sellers. A Khmer Facebook message → suggested order is a demo moment no Chinese app can match in Cambodia.
4. **Dual-currency money (USD + KHR) on KHQR/Bakong rails.** Integer minor units, configurable `KHR_PER_USD`, rate recorded at conversion time, no floating-point math — exactly what foreign platforms fumble in Cambodia. One of the hardest money environments in ASEAN, architected correctly from day one.
5. **COD reality.** Cambodia is still heavily cash-on-delivery. Per-order overpayment / needs-review settlement work is the right instinct — foreign platforms optimize for wallet payments; APSA optimizes for the messy settlement merchants actually live with.
6. **Trust is local.** Khmer-speaking onboarding and support win the merchant relationship a regional platform team never visits.

> **One-sentence strategy:** Chinese apps optimize the *platform's* GMV; APSA optimizes the *merchant's* P&L — in Khmer, on KHQR, inside Messenger. Win the merchants and we win the supply.

---

# PART 3 — THE AI COST TRAP AND THE LOCK-IN ENGINE

**Problem:** AI costs money per use; people love using AI and rarely love paying for it.

**Our structural answer — hybrid AI routing as the business model:** most competitors call an LLM on every message — a permanent tax per user. APSA's deterministic lexicon/scanner handles the ~80% common cases at **zero inference cost**; only ambiguous messages escalate to a paid model. AI feels free to the user while costing us almost nothing. Protect this architecture.

**The design goal:** make AI feel free, make leaving feel expensive. Only accumulated value creates lock-in. Four layers:

| Layer | Mechanism | Feature |
|---|---|---|
| **Habit** | daily return | Morning Money Pulse |
| **Asset** | data gravity | Credit Ledger, Business Brain, self-building catalog |
| **Money** | visible ROI | Daily value receipt, converting broadcasts, reconciliation |
| **Cost** | margin moat | deterministic-first AI routing |

## Sticky-feature portfolio

### Tier 1 — build first (directly on existing parts)

**S1. Morning Money Pulse (daily habit loop).** Every day 07:00, one Telegram/Messenger message in Khmer: yesterday's sales and order count, who owes money and aging, stock that runs out in ~N days (from inventory ledger velocity), quiet customers (30+ days no return). Built from payments + inventory-as-ledger + customers — the cheapest high-impact feature in the repo.

**S2. "Who Owes Me" Credit Ledger.** Structured informal buy-now-pay-later: debts per customer, polite auto-drafted Khmer reminders, payment promises, aging. Pure lock-in — a merchant's debt book is the last thing they abandon. Long-term: credit history that can underwrite micro-loans (revenue stream, not just retention).

**S3. AI Staff Member (Apsi) with one-tap approval.** Works overnight: drafts Khmer replies, follows up unpaid orders, nudges quiet customers, answers price/stock/delivery questions from the catalog. Merchant approves with one tap; never autonomous money (security rules unchanged). Lock-in: it learns the merchant's voice from every approved draft — leaving means firing an employee who knows the business.

### Tier 2 — make the AI pay for itself

**S4. Daily value receipt, never an AI bill.** No tokens or credits shown. Every evening: *"Apsi recovered $31 in follow-ups and answered 14 customer messages today."* Charge the subscription; display AI ROI in money. People won't pay for AI — they'll pay for a machine that visibly prints more than it costs.

**S5. AI credits earned through usage, not bought.** Every real order processed, broadcast sent, or referral made earns AI credits. Heavy users generate the most data and revenue and get the most free AI. Feels generous; is self-funding.

**S6. Broadcasts that close the loop.** Segment customers (recent buyers, big spenders, gone-quiet), generate Khmer promo copy per segment, send via Messenger/Telegram, track who ordered. The merchant watches APSA *create* revenue — the feature that converts free users to payers.

### Tier 3 — hard to build, real moats

**S7. The Business Brain (memory moat).** Every chat, order, and payment resolves into structured per-customer facts (*"Sokha → size M, pays Fridays, KHQR, 2 delivery complaints"*), recalled across conversations months later. Under the hood: entity resolution across Khmer script, romanized Khmer, and phone numbers — extending the intent engine. Leaving = amnesia.

**S8. Self-building catalog.** Customer sends a product photo or asks about something new → AI suggests a catalog entry (Khmer name, price, stock). The catalog grows out of the merchant's conversations; nobody re-types their catalog into a competitor after that.

**S9. Khmer voice notes → orders.** Merchant dictates while packing: *"Sok Chea, 2 shirts, 1 pant, deliver tomorrow"* → draft order. Khmer ASR is genuinely scarce — which is exactly why it is a moat when it works.

**S10. Offline-first selling.** Shops with bad connectivity still check out and queue orders; sync when back online. Foreign apps assume always-on connections; reliability in the provinces is a loyalty machine.

## DO NOT (reinforcing existing source-of-truth rules)

- No consumer marketplace, no consumer swipe feed, no own delivery fleet.
- No subsidy war on GMV.
- No AI-autonomous financial actions — AI recommends; authorized deterministic workflows execute.
- No floating-point money, no mutable stock counts, no client-trusted `organization_id`.

---

# PART 4 — ENGINEERING BACKLOG (tracked tasks converted from the FIX analysis)

Legend: `[ ]` open · `[x]` done · Priority P0 > P1 > P2

## P0 — Unblock the company

- [ ] **ENG-01 · Provision the Supabase project and apply all migrations (P0, owner: founder).**
  This is the single company-level blocker: 19 migration files (`supabase/migrations/001–019`) written but unapplied; auth foundation, RLS, and audit log built but unverified against a live database.
  - Steps: provision/confirm the APSA Supabase project (Seoul region) → copy `.env.example` → `.env.local`, fill `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` → apply migrations via `supabase db push` (or SQL Editor) → run `bun run verify:supabase` → run `supabase/verify-migrations.sql` → seed test data from `supabase/seed-test.sql` (test project only) → run `bun test src/tests/tenant-isolation.test.ts` (T1–T15).
  - Done when: live tests pass; tenant isolation verified on a real database.

- [ ] **ENG-02 · One real end-to-end flow: Inbox → Order (P0).**
  Inbox, orders, and delivery remain mock — the core promise is unproven. Pick ONE flow and make it fully real before touching anything else: a message arrives → intent engine suggests → merchant taps → order created → payment recorded.
  - Includes ripping mock out of the touched paths, not leaving mock fallback silently underneath.
  - Done when: a demo on the live database shows message → order → payment with no mock data.

- [ ] **ENG-03 · Wire the Khmer intent engine into the Conversation UI (P0/P1).**
  The engine is built, tested (284 tests), and disconnected. Surface the suggested-action strip in the Lovable-owned Conversation screen as a coordinated step.
  - Done when: inbound Khmer/romanized-Khmer messages render `[Prepare order]` suggestions at sufficient confidence in the real UI; interest/negation/hesitation correctly suppress them.

## P1 — Money visibility and process hygiene

- [ ] **ENG-04 · Payments reconciliation UI (P1).**
  Payments list / reconciliation is not started. Merchants pay for money visibility, not pretty screens.
  - Scope: payments list with filters (status: pending/paid/failed/reversed/refunded), per-order settlement view including overpayment/needs-review flags (already in backend), USD/KHR display with recorded conversion rate.
  - Done when: a merchant can answer "who paid me, who owes me, what's disputed" from one screen.

- [ ] **ENG-05 · CI completion gate on every PR (P1).**
  Enforce the constitution's own completion gate (`tsc --noEmit`, production build, tests) in GitHub Actions; block merges that fail it.
  - Done when: a failing PR cannot merge; badge green on `main`.

- [ ] **ENG-06 · Branch and docs hygiene (P1).**
  ~40 stale agent branches; `APSA_BUILD_STATUS.md` trails `main`. Delete dead branches; refresh BUILD_STATUS on `main` after each merged sprint.
  - Done when: branch list reflects only active work; BUILD_STATUS dated within the last sprint.

## P2 — Lock-in engine (Tier 1 sticky features)

- [ ] **ENG-07 · Morning Money Pulse (P2, blocked by ENG-01).**
  Spec first: aggregation queries (yesterday sales/orders, receivables + aging, days-of-stock from inventory ledger velocity, 30-day quiet customers), Khmer message templates via i18next, Telegram bot delivery channel (Messenger approval path investigated in parallel). Send 07:00 local.
  - Done when: a live merchant receives an accurate daily Khmer digest.

- [ ] **ENG-08 · Credit Ledger (P2, blocked by ENG-01).**
  Domain: customer debt records, payments against debt, aging, polite Khmer reminder drafts (AI-drafted, merchant-approved). Extends existing Customer/Payment domains; no floating-point money; all movements audited.
  - Done when: merchant can track and collect an informal debt end-to-end.

- [ ] **ENG-09 · AI Staff Member approval loop (P2, blocked by ENG-02/03).**
  Overnight batch: draft Khmer replies, unpaid-order follow-ups, quiet-customer nudges; one-tap approve/reject; learn tone from approvals (tone training data per merchant, server-side).
  - Done when: merchant clears an overnight suggestion queue in under 2 minutes and sees follow-up revenue attributed.

---

# PART 5 — SUCCESS METRICS (what "working" looks like)

| Horizon | Metric |
|---|---|
| 30 days | Live DB verified (ENG-01); Inbox→Order demo with zero mock (ENG-02) |
| 60 days | Intent suggestions live in Conversation (ENG-03); first paying pilot merchants on reconciliation (ENG-04) |
| 90 days | Daily Money Pulse retained: ≥60% of pilot merchants open/act on the morning digest 5 days/week |
| 6 months | Credit Ledger active for ≥30% of pilots; first measured "Apsi recovered $X" value receipts |
| 12 months | Churn story: a merchant who has 90+ days of Business Brain memory + debt book + catalog is functionally un-churnable — measure and prove it |

---

*Prepared as a founder strategy draft. Next step: founder review → promote accepted items into `MVP_ROADMAP.md` / `APSA_BUILD_STATUS.md` per the source-of-truth priority rules in `CLAUDE.md`.*
