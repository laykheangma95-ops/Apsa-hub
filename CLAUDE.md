# APSA — Claude Code Operating Constitution

Read this file at the start of every session before touching any other file.
When this file conflicts with any other document, this file wins — except where
`CORRECTIONS.md` supersedes it (CORRECTIONS.md is the highest authority).

---

## APSA PROJECT IDENTITY

This repository is **APSA only**.

APSA is a **Cambodian Business Operating System** — a unified social-commerce platform
connecting Messages → Customers → Orders → Products → Inventory → Payments → Delivery → CRM → Analytics.

**APSA is completely separate from Domner / Travel-app.**

- Never read, copy, import, modify, or commit Domner code.
- Never share secrets, packages, databases, or Supabase instances with Domner.
- Never mix Vercel projects, GitHub repos, or environment variables with Domner.

---

## SOURCE-OF-TRUTH PRIORITY

Consult documents in this order before implementing anything:

1. `CORRECTIONS.md` — active overrides; always wins
2. Direct instruction in the current session
3. `APSA_MASTER_PLAN.md` — product and engineering vision
4. `ARCHITECTURE.md` — structural constraints
5. `SECURITY.md` — non-negotiable security requirements
6. `PERMISSIONS_MATRIX.md` — role and access rules
7. `DATA_MODEL.md` — data structures
8. `API_AND_EVENTS.md` — API contracts and events
9. `MVP_ROADMAP.md` — implementation sequence
10. `UX_FLOWS.md` — user journeys

Once `APSA_BUILD_STATUS.md` exists, consult it after `CORRECTIONS.md`.

**Never silently override a source-of-truth decision.** If a conflict is found
that is not yet in CORRECTIONS.md, stop and flag it rather than guessing.

---

## CURRENT STACK

Verified from the repository (`package.json`):

| Layer | Library / Version |
|---|---|
| Build | Vite 8.1.5 |
| Framework | TanStack Start 1.168 + TanStack Router 1.170 |
| UI runtime | React 19 |
| Language | TypeScript 5.8 |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite 4.2.1`) |
| Components | shadcn/ui + Radix UI (full suite) |
| Localization | i18next 26 + react-i18next 17 |
| Motion | motion 13 |
| Server | Nitro 3 |
| Data fetching | TanStack Query 5 |
| Forms | react-hook-form 7 + zod 3 |

**Do not migrate frameworks without explicit approval from the project owner.**

---

## ARCHITECTURE RULES

- **Modular monolith** — no Kubernetes, no dozens of microservices prematurely.
- **Organization-based tenancy**: `User → Membership → Organization → Workspace → Location`. Never `User → Business`.
- **Service/application layer is authoritative for authorization** — the backend/server enforces all access control; frontend never is the authority.
- **Clean layered boundaries**: UI → Application/API → Domain/Services → Repository/Data Access → PostgreSQL/Supabase.
- **No business logic scattered through React components.** Components render and dispatch; domain logic lives in the application/service layer.
- **Provider abstractions** for messaging, payments, delivery, and AI. No courier field names, no provider-specific calls appear in domain types.
- **Future native clients** (iOS/Android) reuse backend, domain logic, auth, and permissions without a rewrite.
- **Money is always an integer minor unit** with an explicit currency. Never floating-point financial arithmetic in UI components or anywhere else.
- **Inventory is a ledger**, not a mutable stock count field. Stock = sum of movements.
- **Data lives in APSA-controlled infrastructure.** AI providers are a processing layer, not the system of record.

---

## SECURITY RULES

These are non-negotiable. A feature request that conflicts with them must be
flagged, not silently weakened.

- **Tenant isolation is mandatory.** Organization A must never access Organization B's data. Test specifically for URL/API ID manipulation and IDOR.
- **Client-provided `organization_id` is never authorization truth.** The server must verify membership and ownership independently.
- **No secrets in browser code.** Service-role keys and privileged credentials stay server-side only.
- **No service-role keys client-side.** Supabase public/anon keys may be client-side only where explicitly designed for that.
- **Server-side authorization on every protected request.** Hiding a UI button is not security.
- **Audit logging** for sensitive actions: price changes, stock adjustments, refunds, permission changes, customer exports, payment overrides.
- **Provider token protection.** OAuth access tokens (Meta, Telegram) are stored server-side, never exposed to the browser or logs.
- **Secure session handling**: expiration, revocation, re-authentication gates for high-risk actions.
- **No hidden founder/admin backdoors.** No `if user.email == founder_email: allow_everything`. Privileged internal access must be role-controlled and auditable.
- **Permissions enforced server-side in production.** Authorization must exist at trusted server/database boundaries.
- **Webhook signature verification** for all providers. Idempotent processing — duplicate webhooks must not corrupt money or stock.
- **No AI-autonomous financial actions.** AI recommends; a deterministic authorized workflow executes.

Before any production release: run the security checklist in `SECURITY.md §100`.

---

## MONEY RULES

From `ARCHITECTURE.md` (applies everywhere — do not invent alternatives):

- Store all monetary values as **integer minor units** (e.g., cents for USD, riel for KHR).
- Currency is **explicit** on every value.
- `KHR_PER_USD` exchange rate is **configurable**, not a constant.
- Record the exchange rate **at the time of conversion**.
- **Never introduce floating-point financial calculations** directly into UI components or anywhere in the stack.

---

## LOCALIZATION / UX

- **Khmer is first-class and the default language.** Khmer typography must be treated professionally.
- **No hard-coded user-facing strings.** Every visible string uses i18next keys.
- **No hard-coded hex color values** in components. Use design-system tokens only.
- **No `text-transform: uppercase`** on Khmer text or generally in UI.
- **Do not clip Khmer** in fixed-width chips, badges, or status labels.
- **Visible focus states** on all interactive elements.
- **Status must never be conveyed by color alone.** Always include a label, icon, or pattern.
- **Reuse design-system components** before creating duplicates.
- Follow accessibility: strong contrast, keyboard navigation, meaningful labels, large touch targets, semantic markup.

---

## APSA BRAND RULES

- Brand direction: **APSA Blue / Navy Ink / Porcelain** — premium, restrained, calm, professional.
- No generic AI-SaaS redesign.
- No excessive gradients.
- Soft-depth / liquid-glass aesthetic only where contextually appropriate.
- **Apsi** (the APSA character/mascot) appears in: onboarding, help, success moments, empty states, marketing.
- **Apsi must NOT appear in dense operational UI** — active Inbox, Conversation view, POS, Orders, Products tables.

---

## LOVABLE / CLAUDE BOUNDARY

Lovable has **visually built and owns** these areas. Claude must not preemptively redesign them:

- Design System
- Home
- Inbox
- Conversation
- Message → Order
- POS
- Order Detail
- Customer 360
- Delivery Tracking
- Workspace Switcher
- Team / Staff Invite

**Still reserved for Lovable** (do not touch):

- Product Polish Pass
- Final Landing Page redesign

Claude Code is responsible for: architecture, Supabase/database, migrations, security,
APIs, integrations, tests, production code, refactoring Lovable output, and deployment architecture.

---

## GIT / REPO SAFETY

- **GitHub is source of truth.**
- Respect `AGENTS.md` and Lovable Git integration rules.
- **Do not force-push or rewrite Lovable-published history** without explicit permission.
- Use focused branches and descriptive commit messages for significant engineering changes.
- Branch protection on `main`/production branches must be maintained.
- Never commit `.env` files or production secrets.
- Verify `git status` before any operation that could discard uncommitted work.

---

## COMPLETION GATE

Before declaring any engineering task complete, verify all of the following:

1. `tsc --noEmit` passes (typecheck).
2. Production build succeeds (`vite build` or equivalent).
3. Relevant tests pass where tests exist.
4. Affected routes/features checked for regressions.
5. Report: files changed, migrations added, remaining known issues.

Do not report work as complete based only on code appearing correct. Verify it.

---

## WHAT NOT TO DO

- Do not redesign application UI unilaterally.
- Do not start backend implementation without reading MVP_ROADMAP.md and ARCHITECTURE.md.
- Do not rewrite source documents.
- Do not import or reference anything from Domner.
- Do not use floating-point math for money.
- Do not store inventory as a mutable count field.
- Do not trust `organization_id` from the client as authorization.
- Do not expose service-role keys or long-lived provider tokens to the browser.
- Do not build marketplace, consumer Swipe, own delivery fleet, full accounting, or advanced AI autonomy in MVP.
- Do not migrate frameworks, ORMs, or major dependencies without explicit approval.
