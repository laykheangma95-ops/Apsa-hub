# APSA Competitive Research — SaleSmartly
**Status:** Product strategy reference — not an implementation specification  
**Date:** 2026-10-10  
**Owner:** APSA product / design / engineering  
**Decision horizon:** V1 merchant launch and V2 growth  
**Research confidence:** Mixed (vendor documentation, small third-party review sample, product strategy inference). Revalidate before business commitments.  
**Primary competitor:** [SaleSmartly](https://www.salesmartly.com/)  
**APSA repository:** [Apsa-hub](https://github.com/laykheangma95-ops/Apsa-hub)

> **Core strategic decision:** Do not build "a cheaper SaleSmartly." APSA should be the Cambodia-first, mobile-first business operating workflow: **customer message → customer record → authoritative order → payment → stock → parcel → pack → delivery/return**. A compelling inbox is necessary, but it is not the differentiator by itself.
>
> **User experience principle:** Simple enough for a first-time seller. Powerful enough for a growing business. Fast enough to become a daily habit.
>
> **Accuracy rule:** A competitor's public documentation is evidence of advertised functions, not proof of quality, reliability, full API permissions, or use by any particular named client. The APSA roadmap below lists goals, not claims that features are production-ready.

---

## 1. Executive findings

1. **SaleSmartly is an established omnichannel customer engagement platform.** Its proposition combines shared inboxes, routing, CRM-like customer context, automation, AI-assisted support, team roles, reporting, and multi-channel integrations.
2. **It already advertises some commerce/order capabilities.** Its order-information workflows mean "create order from a chat" alone is **not** a credible APSA differentiator.
3. **It has an aggressive entry-level offering.** Small-business/free and paid plans make "APSA is cheaper" a fragile positioning strategy. See Section 6 for pricing verification.
4. **APSA's defensible possibility is operational completeness** for merchants selling on social platforms and in physical stores: variant/product-backed orders, server-owned totals, inventory ledger, fulfillment, payment accountability, COD and local delivery operations.
5. **A Cambodia-first advantage must be earned, not assumed.** Khmer-language UX, KHR/USD behavior, local payment and shipping practices, mobile performance, merchant support and hands-on onboarding are concrete outcomes to prove.
6. **Security and reliability are product features.** The current PR #121 class of identity-switch / idempotency bugs illustrates why financial authorization, tenant isolation, exactly-once sale outcomes and recovery must precede marketing automation.
7. **Do not copy the entire competitor.** Especially avoid shipping an enterprise CRM / automation builder before the primary merchant selling journey is effortless.

## 2. SaleSmartly: documented offering and usage model

### Typical operating journey

1. Merchant connects eligible messaging accounts, website chat, or channel integrations.
2. Incoming conversations appear in a shared inbox with filters, assignment, tags and conversation controls.
3. Staff or configured automation answers customers, optionally using quick replies, AI tools, translation and knowledge material.
4. Customer records, conversations, classification, follow-up and — on supported workflows — order information are associated.
5. Managers supervise teams and assess workload, channel performance, responsiveness and engagement.
6. Larger businesses use more seats, accounts, permissions, campaigns, integrations, API/webhook access or custom configurations, depending on their plan.

**Integration caveat:** Channel features depend on platform rules, account type, review/approval, permissions, rate limits, and vendor plan. Never equate "platform logo shown" with unlimited, production-approved functionality.

### Strengths worth studying

| Capability | SaleSmartly advertised pattern | What APSA should learn | Do **not** assume |
| --- | --- | --- | --- |
| Unified communications | Multiple channel accounts and an agent workspace | Make messages accessible without switching applications | Every channel/feature is equally available |
| Inbox operations | Unread/replied filtering, assignment, status, quick replies | Task-state clarity, ownership and low-effort replies | All unread chats are urgent |
| Customer context | Profile fields, tags, notes, history and segmentation | A useful customer card tied to actual transactions | Unrestricted PII access is acceptable |
| Automation | Trigger/condition/action workflows and canned responses | Start with highly useful, safe templates | Merchants want to configure complex workflow graphs |
| AI | Chatbots, knowledge-base and support-assist use cases | Assist on repetitive inquiries with human handoff | AI should create/charge/fulfill orders without verification |
| Marketing | Broadcast/segments/attribution in eligible contexts | Attribute enquiries to confirmed sales without misleading conversion claims | Promotional messaging is always allowed |
| Team operations | Agent assignments, roles, supervision | Role-aware workspace and auditability | Admin-only UI should be shown to every seller |
| Analytics | Conversation and agent/channel reports | Measure work done and time saved, not decorative charts | Vendor metrics translate directly to merchant profit |
| Order records | Order information captured in conversation workflows | Integrate verified financial and inventory transactions | A documented order record equals a complete inventory-backed POS |
| Enterprise sales | Custom quotes, customer-logo social proof | Separate solo-seller and multi-staff/multi-location experiences | Displayed logos prove a specific deployment or endorsement |

### Interface design: learn the structure, not the skin

**Desktop structure:** conversation list → active thread → customer-information panel. This is efficient for support agents on wide screens.

**APSA mobile translation:**
- Inbox list: conversation, last message, ownership, *needs merchant response* status.
- Conversation: readable thread, single prominent action reflecting the real next step.
- Customer/orders context: accessible as a sheet or detail view, not three squeezed columns.
- Clear recovery and feedback: never say "completed" until confirmed by the server.
- Role-sensitive data: phone and sensitive information masked unless a fresh authorized grant exists.
- No permanently noisy collection of colorful cards, meaningless alerts or fabricated AI scores.

### What the supplied pricing screenshot supports

The user-provided screenshot appears to show SaleSmartly's **Custom / enterprise** sales section: a request for a personalized quote, a contact action, and company logos (visually resembling OPPEIN, MINISO, CHAGEE and others). This is **vendor marketing/social proof**, not evidence that we know which team in each business uses the software, which channels are connected, or whether a brand operates on the platform in Cambodia.

**Why such businesses might buy it (hypotheses, not verified case studies):** multi-location enquiry routing, high-volume support, common reply policy, lead qualification, staff metrics and centralized customer interactions.

Before naming any company as a proven customer in APSA investor or sales material, obtain independently verifiable case studies or direct confirmation.

## 3. Competitive distinction APSA must prove

**SaleSmartly centers conversation operations. APSA should center commerce operations, with conversation as a high-value entry point.** This is strategic positioning, not an assertion that SaleSmartly lacks a particular connector or module.

| Merchant's real job | APSA V1 desired outcome | APSA V2 extension |
| --- | --- | --- |
| Respond to a buyer | Fast, permissioned conversation workflow on approved channels | Assisted triage, relevant replies and follow-ups |
| Prepare an order | Real customer, product, variant, quantity and KHR/USD totals | Draft from structured conversation signals with confirmation |
| Take payment | Accurate status, audit trail and safe retries | Better local payment reconciliation and reminders |
| Sell in person | Fast POS with correct stock movement | Barcode/QR shortcuts, better multi-location support |
| Manage stock | Reliable product/variant inventory and stock ledger | Smart Stock batch entry, reorder recommendations |
| Hand off a parcel | Order → Parcel → Pack → carrier-ready handoff | Carrier selection and COD reconciliation |
| Handle exceptions | Explicit failed payment, cancellation, return and recovery states | Priority engine and automated, approved remediation |
| Understand repeat buyers | Correct customer/order history with PII gates | Segments and channel-to-completed-sale attribution |

**Non-negotiable differentiation:** consistent order identity, single authoritative stock/payment state, permission checks on every action, recovery after network failure, and clear next actions.

**Potential competitive moat (requires validation):** deeply adapted Cambodian workflow and supplier/carrier/bank integrations, merchant habits, support, clean native Khmer, data portability, and a daily-use interface. None is automatically a moat just because APSA is local.

## 4. V1 — what we should prioritize before launch

**Scope rule:** V1 is a reliable completed-sale workflow, not an AI platform. Prioritize functional evidence and merchant time savings.

### V1-P0 — release gates, not optional features

1. **Order/payment correctness:** server-derived tenant and actor, currency-safe money, reliable confirm/cancel/payment semantics, idempotency and lost-response reconciliation.
2. **Access and privacy:** org/member switching, role/capability revocation, sensitive customer display and mutation authorizations tested across tabs and asynchronous requests.
3. **Inventory correctness:** variant quantities, ledger integrity, stock movement only on allowed transitions and consistent cancellation/returns.
4. **Fulfillment correctness:** Order → APSA Parcel → Pack → handoff/delivery/return with recoverable statuses; no false claims about a courier integration.
5. **Operational readiness:** migration/staging validation, security/CI gates, error monitoring, backup/restore plan and controlled rollout. **Migration 061 staging readiness remains an independent launch concern; do not modify it through this document.**
6. **Merchant acceptance tests:** complete the end-to-end journey on real mobile devices and weak networks, including Khmer text wrapping at 320/360/390/430 px.

**Implementation note (dated 2026-10-10):** PR #121 is a separate, unmerged engineering review track. This document neither approves nor merges it. Re-check repository state before any implementation.

### V1-P1 — product focus after release gates

| Item | Merchant benefit | Minimum acceptance proof |
| --- | --- | --- |
| **Home: task-first** | User knows what needs attention within seconds | Real, actionable "pack", "reply", "payment issue" states; no invented counts |
| **Inbox reply-state clarity** | Fewer unanswered buyer conversations | Correct unread vs awaiting-merchant-response vs awaiting-buyer-response; respectful of channel API limits |
| **Conversation → order** | No duplicate typing or spreadsheets | Customer, source, product/variant, correct totals, provenance and idempotent order creation |
| **Customer context** | Less searching and fewer wrong-customer orders | Authorized history available; sensitive fields masked on revocation |
| **Quick actions** | Fast common tasks on a phone | Open POS, create order, add product; prioritized by job and role |
| **Product and variant management** | Merchant can sell actual catalog | Create/edit SKU/variants with correct stock behavior |
| **Payment and delivery status** | Merchant knows if a sale can advance | Server-confirmed truth, explicit pending and exception states |
| **Khmer/English usability** | Less training | Human-reviewed terms, field names, receipts and empty/error states |
| **Responsive/performance budget** | Useful on affordable Android | Collect real p50/p95 timings before setting launch thresholds |
| **Local merchant support** | Real trust and practical help | Small assisted onboarding pilot and simple support escalation |

**Channel strategy:** connect only official, approved channel functionality when ready; an alpha simulator can test flows without implying live Messenger/Instagram/TikTok access. Telegram-first is a potential pilot sequencing decision, not evidence of completed approval.

### V1 defer list

Do not make launch dependent on: an open-ended AI agent, arbitrary workflow-builder UI, multi-channel bulk marketing, every social connector, advanced attribution, predictive stocking, complex enterprise roles, dynamic courier AI, or a fully autonomous assistant.

## 5. V2 — deliberate expansion after successful pilots/income

Each V2 investment requires merchant evidence, economics and an explicit authorization model.

| Opportunity | Specific product idea | Preconditions and risk | Success evidence |
| --- | --- | --- | --- |
| **Next Action Engine** | Prioritize actionable work across inbox, order, packing, payment and stock | Reliable authoritative state machine; role-aware suggestions | Tasks completed faster, fewer abandoned orders |
| **Silent Business Guardian** | Alert on order/payment exceptions and fulfillment delays | Low-noise rules, deduplication, recoverable alerts | Fewer unresolved exceptions, low alert-dismissal rate |
| **Smart Stock** | Batch photo → product draft, size/variant suggestions, label/QR workflows | Confirmation before saving, accurate catalog and ledger | Time per SKU reduced, lower correction rate |
| **Assisted order drafting** | Convert explicit conversation signals to a suggested draft | Customer consent / platform terms, ambiguity handling, no auto-confirmation | Higher correct draft acceptance, fewer errors |
| **Safe automations** | Preapproved message drafts, follow-up tasks, pack reminders | Official messaging windows, opt-in, audit and kill switch | Less repetitive work without unwanted messages |
| **Delivery intelligence** | Recommend service based on coverage, COD, speed and observed reliability | Actual carrier APIs/SLAs/prices before ETA promises | Higher first-attempt delivery success |
| **Payments/COD reconciliation** | Match local payment and COD status to sales | Authorized bank/carrier access, reconciliation exceptions | Fewer unexplained balances |
| **Sales attribution** | Track inquiries → authorized orders → completed paid sales | Reliable provenance, no misleading conversion claims | Channel ROI decision support |
| **Multi-branch/staff** | Scalable permissions, queues and inventory by location | Auditable mutations, sensitive information gates | Team adoption without cross-org leakage |
| **AI Sidekick** | Explain next steps; propose (not silently execute) business operations | Grounding, permissions, cost caps, merchant approval | Higher task success, acceptable cost and error rate |

**Automation maturity:** V1 recommendation → V2 one-tap approved execution → later opt-in, bounded autopilot only for low-risk tasks. Financial, refund and external-send actions require specific authorization and auditability.

## 6. Pricing, market and competitive risk

### Vendor pricing snapshot — verify live before quoting

Earlier review of SaleSmartly's public marketing referenced an entry free tier, a Pro base listing around **US$15.90/month** and a higher Max offering around **US$199/month**, with enterprise custom quotes. The free tier was described as limited by seats/channels/contacts. **These are historical vendor-published indicative figures, not validated quotes or guaranteed current prices.** Plan availability, billing duration, members, usage and AI allowances can materially change the bill. Always check the [official pricing page](https://www.salesmartly.com/) before using any numbers externally.

**APSA response:** do not race to the bottom. Test willingness to pay for **verified completed-sale outcomes**, training/support and local workflow depth. Track cost-to-serve (support, messaging APIs, AI tokens, payment/carrier expenses).

### Cambodia reality

- Social-channel selling, messaging and COD/local payments are meaningful workflows; the precise channel mix varies by merchant.
- Localization alone is insufficient. Other Cambodia-focused POS and social-commerce tools exist.
- SaleSmartly is globally accessible already. A more plausible threat than "future availability" is **stronger local sales, Khmer UX, local integration partnerships and pricing**.
- Platform API restrictions can prevent features irrespective of engineering quality; channel promises must be matched to permissions.
- Enterprise logo walls and vendor usage claims should not be treated as independent market proof.

### Positioning and competitive-response playbook

**If SaleSmartly makes a Cambodia push:**
1. Do **not** start a feature-count contest or retaliatory price war.
2. Show a 60–90 second real APSA phone demo: incoming buyer → accurate order → payment/stock → pack → delivery status.
3. Prove owner-first mobile speed and Khmer comprehension with real merchants.
4. Prioritize requested local payment/COD/carrier workflows that materially reduce daily manual work.
5. Offer transparent data ownership/export and practical onboarding.
6. Track churn reasons against each competitor and prioritize measurable friction rather than guessing.
7. Keep integration architecture modular so APSA can interoperate with other inbox/CRM providers if commercially sensible—without a single-provider dependency.

## 7. Research-backed mobile UX recommendations

**Primary screen:** Calm Command Center, not a KPI wallpaper.

Hierarchy:
1. **Most important actionable task** for this role and merchant state: e.g., "5 orders ready to pack" only if confirmed by backend.
2. **Secondary attention**: conversations needing response, payment/fulfillment exceptions, stock warnings.
3. **Today at a glance**: real sales/order figures with clear definitions/currencies.
4. **Daily quick actions**: POS, new order, add product/customer.
5. **Recent activity** below immediate jobs.

Design language: APSA's white/porcelain background, restrained APSA Blue `#3478F6` for the main action, typography-led hierarchy, limited motion, no decorative multicolor grids or exaggerated AI treatment.

Behavioral principles:
- **Recognition over recall:** plain labels (Pack orders, Reply, Record payment).
- **Hick's Law:** one prominent next action, few equal-weight choices.
- **Progressive disclosure:** customer/order details when relevant, not always visible.
- **Consistent semantics:** red for real errors, amber for attention, blue for action, muted for information.
- **Honesty of state:** pending means pending; committed only once server-confirmed.
- **Role appropriateness:** owner vs staff see relevant actionable tasks, not forbidden information.

Accessibility/performance: touch targets, keyboard/assistive technology support, readable Khmer, reduced motion, skeleton/loading states, 320 px layout, low-end Android, poor connectivity, cancellation/retry.

## 8. Empirical validation before more engineering

Recruit **10 pilot merchants** (solo and small-team social sellers; e.g. apparel, beauty, general retail). Include first-time and experienced software users.

Ask each to:
1. Set up products, prices, variants and initial stock.
2. Identify the most important task from Home.
3. Find a customer conversation and respond.
4. Create and confirm an order.
5. Record the appropriate payment.
6. Pack and prepare delivery.
7. Handle a lost network response without duplicate sale.
8. Find purchase history and confirm stock changes.

Record:
- Task completion without assistance.
- Median and p95 task duration on actual target phones/networks.
- Mis-taps, backtracks, help requests and abandonment.
- Duplicate/incorrect orders and inventory discrepancies (target: zero).
- Time from inquiry to confirmed order.
- Repeated usage after 7 and 30 days.
- Paid intent and actual retention, not only compliments.

Compare with whichever alternative the merchant **actually uses** (SaleSmartly, spreadsheet, chat app, local POS). Avoid claiming superiority without comparable observations.

### Go/no-go to invest in V2

Proceed when the critical launch gates are resolved, merchants complete the core journey without hand-holding, financial state is trustworthy, and pilots show repeated use. Prioritize the *single highest-friction step* revealed by evidence.

## 9. Source register and verification plan

**Primary vendor** (feature/pricing statements should be rechecked at the publication date):
- SaleSmartly home/product: https://www.salesmartly.com/
- SaleSmartly help center: https://help.salesmartly.com/

**Independent contextual checks:**
- G2 product reviews: https://www.g2.com/products/salesmartly/reviews — limited, self-selected review sample; do not infer population satisfaction.
- DataReportal Cambodia: https://datareportal.com/reports/digital-2026-cambodia — advertising reach is not the same as unique monthly active users.
- U.S. International Trade Administration, Cambodia e-commerce overview: https://www.trade.gov/country-commercial-guides/cambodia-ecommerce — revisit for current policy/market changes.

**Evidence labels used here:**
- **Documented/vendor claim:** capabilities described by SaleSmartly.
- **User-provided screenshot:** enterprise/custom-price presentation and apparent logos only.
- **APSA strategic inference:** competitor positioning, differentiation, UX and roadmap suggestions; to be tested.
- **Engineering requirement:** security and correctness rules, not a claim of completed V1 deployment.

**Next research checks:** hands-on SaleSmartly trial, channel-level feature/permission matrix, order/inventory/API/webhook behavior, Khmer support, total cost at 1/3/10 agents, mobile UX timings, independent named-client case studies and local competitor side-by-side.

## 10. Engineering and governance

- This document authorizes **no code changes**. Each work item needs a scoped ticket or PR and acceptance tests.
- **Do not couple this research PR to the open PR #121.** The latter has its own independent merge gate.
- For authentication, orders, stock, payment, personal data and migrations: independent security review before merge.
- For external connectors: official API approval, credential protection, permission scopes, account unlink and outage handling.
- For AI: explicit merchant approval where consequential; guardrails, source provenance, audit trail and escape hatch.
- Product/marketing should revisit this research quarterly as competitors and API policies change.

---

### The APSA product promise to test

> **From customer message to completed sale. One simple place to run your business.**

The objective is **fewer merchant actions, fewer mistakes, faster completion**, with correct and visible business state—not the longest feature list.
