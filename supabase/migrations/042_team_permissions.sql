-- Migration: 042_team_permissions
-- Purpose: Close a gap between the seeded RBAC vocabulary (003_roles_permissions.sql)
--          and PERMISSIONS_MATRIX.md §7 (TEAM & MEMBERSHIP): the matrix marks
--          `team.update_role` as ⚠️ (limited/conditional) for MANAGER, but 003
--          only granted the equivalent `team.roles_assign` permission to OWNER.
--          No new permission key is introduced — `team.roles_assign` already is
--          the "assign a role to a team member" permission; this migration only
--          completes its grant to match the documented role matrix.
--
--          This grant is a coarse permission BIT ONLY — "Manager may call
--          team.roles_assign at all" — not "Manager may assign any role to
--          anyone". CORRECTION-001 (CORRECTIONS.md, owner-approved 2026-09-10)
--          resolves the matrix's ⚠️ to: Manager may assign/change only roles
--          strictly BELOW Manager (Cashier/Sales/Customer Service), and may
--          never assign Manager or modify a membership that is currently
--          Manager or Owner. That cap is enforced in application code
--          (src/server/team/service.ts assertRoleAuthority()), the same
--          layered pattern as the pre-existing OWNER-role prohibition below —
--          the permission system here is not fine-grained enough to express
--          "below your own role" as a DB-level grant.
-- Tables: role_permissions (data only — no schema change)
-- Rollback: DELETE FROM public.role_permissions
--             WHERE role_id = '00000000-0000-0000-0000-000000000002'
--               AND permission_id = (SELECT id FROM public.permissions WHERE key = 'team.roles_assign');

INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT '00000000-0000-0000-0000-000000000002', p.id
  FROM public.permissions p
  WHERE p.key = 'team.roles_assign'
ON CONFLICT DO NOTHING;
