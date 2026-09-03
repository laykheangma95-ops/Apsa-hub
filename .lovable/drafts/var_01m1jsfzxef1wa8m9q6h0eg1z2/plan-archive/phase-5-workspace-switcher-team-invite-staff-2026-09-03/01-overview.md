# Phase 5 — Workspace Switcher, Team, Invite Staff

Small, focused phase. No completed screen is redesigned; the only touch outside new files is wiring the header's existing shop-switch hook and a Team entry point in navigation.

## What gets built

1. **Workspace Switcher** — a bottom sheet opened from the header title (the `onShopSwitch` hook already exists on `AppHeader` and is currently a no-op on Home). Lists the merchant's workspaces with business name, workspace type ("Business"), city, the user's role in each, and an active tick. Actions: Switch, and a disabled "Workspace settings" placeholder. Single-workspace case shows the current workspace with a quiet "You only manage one business today" line instead of a list.
2. **Team screen at `/app/team`** — mobile-first card rows (avatar initial, name, role chip, status), not a table. On `lg+` the same rows widen into a clean two-column list with role and status aligned right. Primary action: Invite staff.
3. **Invite Staff sheet** — Name, Phone or Email, Role. Role options render as selectable cards with a one-line plain-language description. Owner is not offered.
4. **Owner protection** — Owner row is visually distinct and carries no destructive action; attempting a protected action surfaces a clear informational message rather than an error.
5. **Staff detail sheet** — name, role, status, workspace, role description; Change role / Remove access for non-owners only.
6. **Pending invite** — one mock pending member with Resend / Cancel invite.
