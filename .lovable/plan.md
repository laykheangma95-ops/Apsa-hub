# APSA — Phase 1: Design System + Landing + Business Home

Build the APSA foundation exactly to the knowledge file, adapted to this project's stack (TanStack Start + Tailwind v4). Scope stops after `/design`, `/` (landing) and `/app` (Business Home).

## Stack adaptation

The brief assumes React Router v6 and `tailwind.config.ts`. This project uses TanStack Router file routes and Tailwind v4 (CSS-first tokens). Same URLs, same tokens, different plumbing:

- `src/routes/index.tsx` → landing, `src/routes/design.tsx` → design reference, `src/routes/app.tsx` (layout with bottom nav) + `src/routes/app.index.tsx` → Business Home.
- All colour/type/motion tokens go in `src/styles.css` under `:root` and are mapped through `@theme inline` so Tailwind utilities (`bg-surface-page`, `text-text-secondary`, `bg-action-primary`) exist. No `tailwind.config.ts`, no hex in components.
- Fonts Inter + Kantumruy Pro loaded via `<link>` in `__root.tsx` (Tailwind v4 cannot `@import` remote URLs).
- No backend, no auth, mock data only.

## Foundations

- Full colour token set (brand, action, surface, text, border, status, channel, companion), structured so a `[data-theme="dark"]` block can be added later without touching components.
- Type scale utilities (`text-display` … `text-data`) with `tnum` on financial styles, plus `.font-khmer` applying the +1px / ×1.18 line-height Khmer rules. No uppercase anywhere.
- Motion tokens and a `prefers-reduced-motion` override.
- `src/lib/money.ts` — `Money` integer minor units, `KHR_PER_USD = 4100` single constant, KHR exponent 0, KHR rounded to nearest 100. All formatting lives here.
- `src/types/` domain types (Customer, Product, Order, Conversation, Message, Courier, Address, Money, statuses).
- `src/lib/mock/` seed data verbatim from the brief (shop, owner, staff, 7 customers, 5 products, 4 couriers, 12+ conversations across all 3 channels, Dara Sok's exact Khmer thread) and `src/lib/api/` as the only data boundary components import.
- i18n with i18next, Khmer default, `src/locales/km.json` + `en.json` complete for everything built. No hard-coded strings.

## Components (all 17, in `src/design-system/` with a barrel export)

BottomSheet, BottomNav, AppHeader, StatusChip (all 19 status keys, icon + label never colour alone), ChannelBadge, Money, CurrencyInput, QuantityStepper, ConversationRow, MessageBubble, MetricTile, CustomerSummaryCard, ApsiIllustration (with CSS blob fallback holding exact layout space), EmptyState, ErrorState, SyncIndicator, ListSkeleton.

shadcn primitives are themed, never rebuilt. Framer Motion only for bottom sheets and success moments.

## Screens

1. `/design` — reference page: every token swatch, type specimen (KH + EN), and every component in all states, with a KH/EN toggle to sanity-check Khmer layouts.
2. `/` — landing: gradient hero (only allowed gradient besides Home header), Apsi hero illustration, wordmark, tagline "One inbox. Every customer.", value props tied to the MESSAGE → ORDER → DELIVERY workflow, one primary CTA into `/app`.
3. `/app` — Business Home: gradient greeting header, needs-attention-first list (not charts), MetricTiles, recent conversations, 5-slot bottom nav with raised centre [+] opening the create sheet (New sale, New order, Add product, Scan barcode), safe-area inset.

Each screen ships loading, empty and error states.

## Quality bar

Mobile-first at 320px, 44px/48px tap targets, focus rings never removed, semantic HTML, no layout shift, 4.5:1 body contrast.

## Not in this phase

Inbox, Conversation, Message→Order sheet, POS, Order Detail, Customer 360, Delivery Tracking, Team, Workspace Switcher, and the DECISIONS.md / HANDOFF.md files. Those come in the next pass once you have reviewed `/design`.
