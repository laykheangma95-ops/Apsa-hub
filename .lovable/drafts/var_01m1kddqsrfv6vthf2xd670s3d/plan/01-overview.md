# APSA Product Polish Pass

A tight refinement pass over the already-built product. No rebrand, no new modules, no landing page, no backend. Existing flows stay intact; only presentation and hierarchy change.

## The 10 highest-impact improvements

1. **Elevation and depth tokens.** There are no shadow tokens today — `BottomNav` carries a hardcoded `rgba(...)` shadow, the only raw colour left in the app. Add `--elevation-1/2/3` plus one `--surface-glass` (blur + translucent porcelain) in `src/styles.css`, and use them only on sheets, floating nav and overlays.
2. **A spacing rhythm scale.** Replace ad-hoc paddings with a fixed rhythm: 20px section gap, 12px intra-group gap, 16px card padding, 24px screen bottom padding above sticky bars. Applied through a shared `Section` wrapper so every screen breathes the same way.
3. **De-nest cards.** Order Detail, Customer 360 and Delivery Tracking each stack 5–7 bordered containers. Convert inner containers to divider-separated rows inside one card, with a quiet section label above. Card counts roughly halve.
4. **One dominant action per screen.** Audit each screen so only one filled `action-primary` button exists at a time; demote the rest to outline/ghost. Affects Order Detail (payment/return/refund/delivery all currently compete), Delivery Tracking and Customer 360.
5. **Number and status emphasis.** Money and key metrics move to `text-financial` / `text-financial-lg` with tabular numerals consistently; status chips get a single size and weight, keeping icon+label so status is never colour-alone.
6. **Sticky action bars, deliberately.** Standardise a `StickyActionBar` (safe-area padding, glass surface, top hairline) used by Conversation composer, POS cart, Order Detail and Delivery Tracking, instead of three variations.
7. **Header unification.** `AppHeader` gets a consistent operational variant: title/subtitle rhythm, optional context line (order number, channel, courier), gradient reserved for Home only.
8. **Chips and filters as one system.** Inbox filters, POS categories, variant chips and payment-method chips share one chip primitive with identical height, radius, selected treatment and Khmer-safe wrapping (`chip-text`, no truncation).
9. **Motion discipline.** All transitions move onto `--dur-fast/base` with `--ease-out`; `--ease-spring` reserved for success confirmations only. Sheets, chip selection and status changes get one shared transition recipe; `prefers-reduced-motion` already handled.
10. **Khmer-first pass at 320px.** Re-check every chip, button, tab and metric label in Khmer at 320/360/430 — no clipping, no fixed-width labels, 48px targets in Khmer mode.
