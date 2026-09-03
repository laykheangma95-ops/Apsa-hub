## Screens needing the most attention

- **Order Detail** — the densest screen (~476 lines, most nested bordered blocks and four competing actions). Biggest single win.
- **Customer 360** — five nested containers plus four tabs; tabs and section rhythm need restraint.
- **Delivery Tracking** — six nested containers; progress step row and COD/settlement block need clearer separation.
- **Business Home** — gradient header, metric tiles and quick actions need one consistent rhythm; Apsi insight card stays but gets calmer framing.

## Moderate attention

- **POS** — cart and sticky checkout bar adopt the shared sticky bar and chip system; product grid spacing tightened.
- **Unified Inbox** — filter chip row height/Khmer wrapping, row density, and a cleaner divider treatment instead of card-per-row feel.
- **Conversation** — composer + Create Order bar merged into one deliberate sticky stack; bubble spacing rhythm.
- **App shell / BottomNav** — replace the hardcoded shadow with the elevation token, apply the glass surface.

## Minimally touched

- **Message → Order sheet** — the 4-tap ceiling is a hard rule; only chip styling, spacing and the success motion easing are touched. Tap count stays at 3–4.
- **Workspace Switcher, Team / Staff Invite** — token and spacing alignment only, no structural change.
- **Landing page, design reference route** — untouched apart from token knock-on.

## How the references are used

**Image 1 (brand authority)** confirms what stays fixed: APSA Blue `#3478F6`, Sky `#73B7FF`, Navy Ink `#1B2B59`, Porcelain `#F7FAFF`, and the companion accents (Mint = success/payment, Vela purple = AI/automation, Gold = opportunity, Pink = engagement) — all already present as tokens. Its soft-3D / liquid-glass language is applied narrowly: sheets, floating nav, overlays and success moments only. Apsi keeps her existing slots (onboarding, help, success, empty states, AI summary) and stays out of every operational screen; her visual treatment is not finalised in this pass.

**Image 2 (product UI quality)** drives composition: a calm header, one hero number per screen, compact list rows separated by hairlines rather than cards, chip filter rows, and a single confident primary action at the bottom. Neither reference is copied — no borrowed layouts, icons, or artwork.

## Shared components refined globally

`src/styles.css` (elevation + glass tokens, spacing rhythm), `AppHeader`, `BottomNav`, `BottomSheet`, `StatusChip`, `MetricTile`, `QuickActionGrid`, `CustomerSummaryCard`, `Timeline`, `OperationalState`, plus a new `Section`, `Chip` and `StickyActionBar` primitive in the design system. Refining these carries most of the improvement into every screen at once.

## Technical notes

- All new values are tokens in `src/styles.css`; no hex or rgba enters a component. The one existing raw `rgba(...)` shadow in `BottomNav` is removed.
- New primitives live in `src/design-system/` and are exported from its index; existing components are edited in place, not forked.
- No route files are added or removed, no data/API/mock or money logic changes, no dependencies added.
- Verification: typecheck, build, and a Playwright pass at 320/360/390/430/1280 in both Khmer and English checking overflow, chip clipping and hydration.

## Workflow-affecting changes (explicit call-outs)

1. **Demoting secondary actions on Order Detail.** Record payment, return, refund and arrange delivery currently look equally weighted. Proposal: one primary (the contextually correct next step) and the rest in a secondary row. Same actions, same reachability — one extra glance, not an extra tap.
2. **Conversation composer + Create Order bar merged into one sticky stack.** Create Order remains a single tap; it just no longer floats as a separate bar.
3. **Customer 360 tabs.** If Khmer labels crowd at 320px, tabs become a scrollable chip row rather than shrinking text. Navigation semantics unchanged.

Nothing else alters a working flow.

## Estimated credit usage

15–18 credits: tokens and new primitives ~4, the three heavy operational screens ~7, moderate screens ~4, verification pass ~2.
