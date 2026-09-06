# Apsi reusable emotion system

## Goal
Extend the existing Apsi mascot architecture into one reusable, restrained emotion API based on the attached official emotion pack. Preserve Apsi’s current 3D design and keep dense operational screens mascot-free.

## Implementation
- Create a centralized 16-state emotion registry covering default, waving, assistant wink, grateful, thinking, typing, laughing, excited, success, surprised, confused, listening, sleepy, supportive, approved, and merge.
- Keep existing pose/state call sites compatible while adding the requested `<Apsi emotion="…" size="…" animation="…" />` API.
- Add responsive named sizes, intrinsic aspect-ratio protection, accessible decorative/labeled modes, media-type metadata, graceful loading/failure behavior, and subtle emotion-specific motion that fully disables under reduced-motion preferences.
- Use approved Apsi artwork only. Map states to the closest official existing art initially; generate or add distinct reference-matched emotion artwork only where the source pack supports it, without inventing a new character design.
- Update the existing onboarding, assistant insight, empty-state, and success-moment wrappers to use semantic emotions. Do not add Apsi to dense Inbox, Conversation, POS, Orders, Products, Customer, or Delivery operational views.
- Expand the mascot reference page to display all supported emotions, motion intent, use-case guidance, companions, and asset readiness from the centralized registry.

## Technical details
- Main files: `src/design-system/mascot/*`, compatibility wrappers in `src/design-system/*`, `src/styles.css`, and the existing mascot reference route.
- Asset records remain centralized and include a delivery kind (`image`, `animated-webp`, `lottie`, `rive`, `video`, or `3d`) so future media swaps do not change screen code.
- Preserve current imports and legacy `MascotState`/`ApsiIllustration` behavior while introducing aliases for the new emotion vocabulary.
- Validate typecheck, targeted tests/build signal, reduced-motion CSS, image loading, and layout at 320, 768, and 1280 widths.

## Out of scope
No backend, authentication, database, payments, orders, inventory, delivery, or unrelated product changes. No product-wide redesign and no mascot placement on every screen.
