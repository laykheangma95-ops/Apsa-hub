# CLAUDE.md — APSA Operating Constitution

This file is the operating constitution for Claude Code in this repository.
Read it before touching any code, configuration, or documentation.

---

## PROJECT IDENTITY

- This repository is **APSA only**.
- APSA is completely separate from Domner / Travel-app.
- Never read, import, copy, modify, or commit Domner / Travel-app code.
- Repo: `laykheangma95-ops/Apsa-hub`
- APSA is a Cambodian Business Operating System — a unified social-commerce platform for Cambodian sellers.

---

## CURRENT STACK

| Layer | Technology |
|---|---|
| Build | Vite |
| Routing / Meta-framework | TanStack Start + TanStack Router (file-based routes) |
| UI | React 18 + TypeScript |
| Styling | Tailwind v4 (CSS-first tokens in `src/styles.css`) |
| Components | shadcn/ui + Radix UI primitives |
| Motion | Framer Motion (bottom sheets and success moments only) |
| i18n | i18next |
| Data fetching | TanStack Query |

Do not migrate frameworks, styling systems, or routing libraries without an explicit architectural decision recorded in ARCHITECTURE.md (once that document exists).

---

## SOURCE PRIORITY

When the following documents are eventually added to this repository, read them before implementation in this order:

1. `CORRECTIONS.md` — overrides all older conflicting documentation
2. `APSA_MASTER_PLAN.md`
3. `ARCHITECTURE.md`
4. `SECURITY.md`
5. `MVP_ROADMAP.md`
6. `DATA_MODEL.md`
7. `API_AND_EVENTS.md`
8. `PERMISSIONS_MATRIX.md`
9. `UX_FLOWS.md`
10. `APSA_BUILD_STATUS.md` — current build state (this repo)
11. `.lovable/plan.md` — phase design brief (lowest authority; informational only)

`CORRECTIONS.md` overrides conflicting older documentation.

Until those documents are added:
- Never pretend they exist.
- Never reconstruct them as if they were original source documents.
- Clearly flag any architecture decisions that require confirmation before implementing.

---

## LOVABLE / CLAUDE CODE RESPONSIBILITY

Lovable is the visual authority for unfinished Lovable work.

### Already visually built by Lovable (do not redesign)

- Design system (tokens, typography, all 17+ `src/design-system/` components)
- Business Home (`/app`)
- Unified Inbox (`/app/inbox`)
- Conversation thread (`/app/inbox/$id`)
- Message → Order sheet
- POS (`/app/pos`)
- Order Detail (`/app/orders/$id`)
- Customer 360 (`/app/customers/$id`)
- Delivery Tracking (`/app/deliveries/$id`)
- Landing Page (current version — temporary, reserved for Lovable redesign)

### Still reserved for Lovable (do not begin before Lovable finishes)

- Phase 5: Workspace Switcher + Staff Invite / Team basics
- Product Polish Pass
- Final Landing Page redesign

Do not begin these areas before Lovable completes them. Do not redesign working Lovable screens without an explicit instruction.

---

## BRAND

Approved APSA brand direction:
- Premium Cambodian Business Operating System
- APSA Blue / Navy Ink / Porcelain foundation (see token values in `src/styles.css`)
- Restrained soft-depth / liquid-glass influence
- Professional, calm, approachable
- **No** generic AI-SaaS visual redesign
- **No** excessive gradients — only two gradient locations permitted: Home header and landing hero
- **One** primary filled action per screen maximum

### Apsi (brand mascot)

Apsi is the emotional brand mascot.

Appropriate contexts: onboarding, empty states, help, success moments, marketing.

**Forbidden in:** Inbox list, active Conversation, POS, Orders, Products, operational tables, any dense operational screen.

---

## FRONTEND RULES

- **Reuse existing design-system components first** — check `src/design-system/` before building anything new.
- No hard-coded hex values in components. All colour must come from CSS tokens defined in `src/styles.css`.
- No hard-coded user-facing strings. All UI strings through i18next (`src/locales/km.json` + `en.json`).
- Khmer is first-class and default (`lang="km"` on `<html>`). English is the secondary locale.
- No `text-transform: uppercase` anywhere.
- Do not truncate Khmer text inside fixed-width chips — Khmer glyphs are taller and wider than Latin.
- Maintain visible focus states. Never `outline: none` without an accessible replacement.
- Minimum tap targets: `44px × 44px` (mobile). Use the `.tap-target` utility.
- Status must never rely on colour alone — always paired with an icon or label (`StatusChip`).
- Do not introduce visual changes merely for personal preference or aesthetic taste.
- Do not introduce layout shift.
- Minimum contrast: 4.5:1 for body text.

---

## APPLICATION BOUNDARY

- React components must not become the business / domain layer.
- UI data access goes through `src/lib/api/` (or future application interfaces when a backend exists).
- Domain types live in `src/types/index.ts` — keep them independent from React.
- Provider-specific implementation details (courier APIs, payment SDKs, messaging webhooks) must not leak through the entire UI layer.
- Prefer modular-monolith architecture. Avoid premature microservices.
- When the real backend arrives, only the bodies of functions in `src/lib/api/` should change — not component call sites.

---

## MONEY

- Use `src/lib/money.ts` as the single authority for all financial formatting and arithmetic.
- `KHR_PER_USD = 4100` is defined once in `money.ts`. Never repeat or invent this constant elsewhere.
- Never introduce floating-point financial calculations directly in UI components.
- All amounts are integer minor units: USD = cents, KHR = riel (exponent 0).
- KHR always rounds to the nearest 100 (`KHR_ROUNDING = 100`).
- Use `formatMoney()` for display; `usd()` / `khr()` constructors for creation.

---

## SECURITY

These rules apply even in mock / prototype phase:
- Client-provided organization identity must never become authorization truth.
- No secrets, API keys, or service-role credentials in browser code.
- No hidden admin or backdoor accounts.
- Tenant isolation is non-negotiable — one shop must never see another shop's data.
- Sensitive actions (refunds, cancellations, high-value approvals) eventually require server-side authorization and audit logging — mock checks are not production security.
- Do not claim mock permission checks (`src/lib/permissions.ts`) are production security. The comment in that file is accurate: real projects resolve role from the session server-side.
- `currentRole` hardcoded in `src/lib/api/index.ts` is a mock artefact, not an auth mechanism.

---

## LOVABLE GIT SAFETY

Respect `AGENTS.md` and the existing Lovable Git integration rules:
- Do not force-push or rewrite Lovable-published history unless explicitly required and reviewed.
- Do not amend or squash commits that have already been pushed — Lovable tracks history on its side.
- Keep the connected branch in a working (passing build) state at all times.

---

## COMPLETION RULE

Before declaring any implementation work complete:

1. Run TypeScript typecheck: `bun run tsc --noEmit` (or project equivalent)
2. Run build: `bun run build`
3. Run tests where they exist
4. Inspect relevant regressions in nearby features
5. Report clearly: what changed, what is still open, and any remaining known issues

Do not mark work complete if the build is broken or typecheck fails.
