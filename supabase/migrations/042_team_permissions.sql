-- Migration: 042_team_permissions
-- Purpose: Close a gap between the seeded RBAC vocabulary (003_roles_permissions.sql)
--          and PERMISSIONS_MATRIX.md §7 (TEAM & MEMBERSHIP): the matrix marks
--          `team.update_role` as ⚠️ (limited/conditional) for MANAGER, but 003
--          only granted the equivalent `team.roles_assign` permission to OWNER.
--          No new permission key is introduced — `team.roles_assign` already is
--          the "assign a role to a team member" permission; this migration only
--          completes its grant to match the documented role matrix. Manager
--          still cannot grant the OWNER role — that is enforced in application
--          code (src/server/team/service.ts), not by this permission, per
--          PERMISSIONS_MATRIX.md §42 ("must be validated server-side").
-- Tables: role_permissions (data only — no schema change)
-- Rollback: DELETE FROM public.role_permissions
--             WHERE role_id = '00000000-0000-0000-0000-000000000002'
--               AND permission_id = (SELECT id FROM public.permissions WHERE key = 'team.roles_assign');

INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT '00000000-0000-0000-0000-000000000002', p.id
  FROM public.permissions p
  WHERE p.key = 'team.roles_assign'
ON CONFLICT DO NOTHING;
