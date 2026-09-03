## Data and mock layer

- Extend `src/lib/mock/shop.ts`: give each shop a workspace type and the current user's role in it; add a second staff-with-status set including one `pending` member (Chan — Cashier, invited).
- Extend the `Staff` type with `status: "active" | "pending"`, optional `email`/`phone`, and `shopId`.
- New mock API calls in `src/lib/api/index.ts`, matching the existing async-delay pattern: `getWorkspaces()`, `switchWorkspace(id)`, `getTeam()`, `inviteStaff({name, contact, role})`, `changeStaffRole(id, role)`, `removeStaff(id)`, `resendInvite(id)`, `cancelInvite(id)`. All in-memory, no network. Protected-owner attempts reject with an existing-style sentinel (`PERMISSION_DENIED`) that the UI turns into an informational message.

## Files

Created
- `src/routes/app.team.tsx` — Team screen, `/app/team`, with its own `head()` metadata.
- `src/components/team/WorkspaceSwitcherSheet.tsx`
- `src/components/team/InviteStaffSheet.tsx`
- `src/components/team/StaffDetailSheet.tsx`
- `src/components/team/StaffRow.tsx`, `src/components/team/RoleOption.tsx`

Edited
- `src/lib/mock/shop.ts`, `src/lib/api/index.ts`, `src/types/index.ts`
- `src/locales/en.json`, `src/locales/km.json` — new `team` namespace, Khmer first-class
- `src/design-system/BottomNav.tsx` — the currently inert "More" slot becomes a working Team link (no visual redesign)
- `src/routes/app.index.tsx` — the existing `onShopSwitch` no-op opens the workspace switcher

## Reuse

`AppHeader`, `BottomSheet` (half snap, expandable), `StatusChip` for active/pending, `OperationalState` for loading/empty/error on this operational screen, `ListSkeleton`, existing `Button`/`Input`/`Label`, `localName`, `permissionsFor`. No new dependencies, no new tokens or colours, no Apsi in Team or workspace UI.

## States covered

- Switcher: current workspace, multiple workspaces, switching (optimistic tick + toast-free inline confirm), single-workspace variant.
- Team: loading skeleton, normal list, owner-only list, pending invite row, permission-restricted view for roles without team management, error with retry.
- Invite: valid, missing field, invalid phone/email (Cambodian phone or basic email shape), owner-role blocked, mock success that appends a pending row and closes the sheet.

## Accessibility and responsive

44px minimum targets on every row and action; focus rings kept; sheets already trap and restore focus; status conveyed by icon + label, not colour; role options are a labelled radio group with descriptions tied via `aria-describedby`. Verified at 320/360/390/430/1280 for overflow, Khmer wrapping, and one-handed reach, then typecheck, build, console and a regression pass over Home, Inbox, POS, Order Detail, Customer 360 and Delivery.
