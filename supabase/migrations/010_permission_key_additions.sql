-- Migration: 010_permission_key_additions
-- Purpose: Add missing permission keys from PERMISSIONS_MATRIX.md that are absent
--          from migration 003_roles_permissions.sql.
--
-- Background (Blocker 8 — Permission Key Drift):
--   Migration 003 seeded 37 permission keys using a compact naming scheme
--   (e.g. inbox.*, org.*, deliveries.*).
--   PERMISSIONS_MATRIX.md uses a richer naming scheme in some domains
--   (e.g. messages.*, organization.*, delivery.*).
--
-- Resolution:
--   The migration 003 keys are the IMPLEMENTATION truth — they are what the
--   application authorization layer (src/server/auth/) currently checks, and
--   they are already seeded. We do NOT rename or delete them here because that
--   would break backward compatibility on live projects.
--
--   This migration adds only the permissions that PERMISSIONS_MATRIX.md lists
--   which have NO equivalent in 003. The naming drift between inbox.* / messages.*,
--   org.* / organization.*, and deliveries.* / delivery.* is flagged in
--   APSA_BUILD_STATUS.md and must be resolved in a dedicated permissions audit
--   before the first production tenant is onboarded.
--
-- New keys added (not present in 003):
--   organization.delete, organization.transfer_ownership
--   workspace.manage, location.manage
--   team.update_role, team.disable_member
--   roles.manage, permissions.manage
--   messages.mark_followup, messages.close_conversation, messages.view_all_team
--   consent.record, consent.revoke
--   products.update_price, products.view_cost, products.archive
--   orders.approve_high_value
--   payments.void, payments.reconcile
--   analytics.view_staff_performance

INSERT INTO public.permissions (key, description, risk_level) VALUES
  -- Organization (high-risk actions not covered by org.update)
  ('organization.delete',            'Delete the organization (irreversible)',         'critical'),
  ('organization.transfer_ownership','Transfer ownership to another user',             'critical'),
  -- Workspace & Location management (fine-grained)
  ('workspace.manage',               'Create, archive, and configure workspaces',      'high'),
  ('location.manage',                'Create and close locations',                     'high'),
  -- Team granular operations
  ('team.update_role',               'Change a team member''s role',                   'critical'),
  ('team.disable_member',            'Suspend a team member''s access',                'high'),
  -- Role & permission management
  ('roles.manage',                   'Create and modify custom roles',                  'critical'),
  ('permissions.manage',             'Assign permissions to roles',                    'critical'),
  -- Inbox extended operations
  ('messages.mark_followup',         'Mark conversations for follow-up',               'low'),
  ('messages.close_conversation',    'Close a conversation',                           'low'),
  ('messages.view_all_team',         'View conversations assigned to other team members','medium'),
  -- Customer consent
  ('consent.record',                 'Record customer marketing consent',              'medium'),
  ('consent.revoke',                 'Revoke customer marketing consent',              'high'),
  -- Product price / cost
  ('products.update_price',          'Change product selling price',                   'high'),
  ('products.view_cost',             'View product cost price',                        'medium'),
  ('products.archive',               'Archive a product',                              'high'),
  -- Orders extended
  ('orders.approve_high_value',      'Approve orders above the high-value threshold',  'high'),
  -- Payments extended
  ('payments.void',                  'Void a payment record',                          'critical'),
  ('payments.reconcile',             'Mark payments as reconciled',                    'high'),
  -- Analytics
  ('analytics.view_staff_performance','View per-staff performance metrics',            'medium')
ON CONFLICT (key) DO NOTHING;

-- Grant new high-risk operations to OWNER (all permissions).
-- 003 already grants OWNER all permissions via: SELECT id FROM permissions.
-- Re-run the grant using INSERT…SELECT to pick up the new rows.
INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT '00000000-0000-0000-0000-000000000001', id
  FROM public.permissions
  WHERE key IN (
    'organization.delete', 'organization.transfer_ownership',
    'workspace.manage', 'location.manage',
    'team.update_role', 'team.disable_member',
    'roles.manage', 'permissions.manage',
    'messages.mark_followup', 'messages.close_conversation', 'messages.view_all_team',
    'consent.record', 'consent.revoke',
    'products.update_price', 'products.view_cost', 'products.archive',
    'orders.approve_high_value',
    'payments.void', 'payments.reconcile',
    'analytics.view_staff_performance'
  )
ON CONFLICT DO NOTHING;

-- Grant operational subset to MANAGER.
INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT '00000000-0000-0000-0000-000000000002', p.id
  FROM public.permissions p
  WHERE p.key IN (
    'workspace.manage', 'location.manage',
    'team.update_role', 'team.disable_member',
    'messages.mark_followup', 'messages.close_conversation', 'messages.view_all_team',
    'consent.record', 'consent.revoke',
    'products.update_price', 'products.view_cost', 'products.archive',
    'orders.approve_high_value',
    'payments.reconcile',
    'analytics.view_staff_performance'
  )
ON CONFLICT DO NOTHING;

-- Grant conversational subset to SALES.
INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT '00000000-0000-0000-0000-000000000004', p.id
  FROM public.permissions p
  WHERE p.key IN (
    'messages.mark_followup', 'messages.close_conversation',
    'consent.record'
  )
ON CONFLICT DO NOTHING;

-- Grant support subset to CUSTOMER_SERVICE.
INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT '00000000-0000-0000-0000-000000000005', p.id
  FROM public.permissions p
  WHERE p.key IN (
    'messages.mark_followup', 'messages.close_conversation',
    'consent.record', 'consent.revoke'
  )
ON CONFLICT DO NOTHING;

-- ── Remaining drift — tracked, not silently renamed ───────────────────────────
-- The following key groups are used consistently in application code (003) but
-- differ from PERMISSIONS_MATRIX.md naming. They are NOT renamed here to avoid
-- breaking existing server-side permission checks. A dedicated permissions audit
-- must be run before first merchant onboarding:
--
--   Application key       → Matrix key (aspirational)
--   inbox.read            → messages.read
--   inbox.reply           → messages.reply
--   inbox.assign          → messages.assign
--   org.read              → organization.read
--   org.update            → organization.update_basic
--   deliveries.read       → delivery.read
--   deliveries.create     → delivery.create
--   deliveries.update     → delivery.update
--   team.roles_assign     → team.update_role (added above as new key)
--
-- Until the audit resolves this, use the APPLICATION key in all server-side
-- permission checks (src/server/auth/authorization.ts and API handlers).
