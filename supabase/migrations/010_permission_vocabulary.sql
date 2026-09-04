-- Migration: 010_permission_vocabulary
-- Purpose: Canonicalize permission keys to match PERMISSIONS_MATRIX.md.
--
-- Migration 003 seeded permission keys using abbreviated domain prefixes that differ
-- from the canonical vocabulary defined in PERMISSIONS_MATRIX.md:
--   inbox.*        → messages.*
--   deliveries.*   → delivery.*
--   org.*          → organization.*
--
-- This migration:
--   1. Inserts canonical permission rows.
--   2. Copies role_permission mappings from old keys to new canonical keys.
--   3. Deletes old permission rows (cascades to old role_permissions via FK).
--
-- ASSUMPTION: migrations 001–008 are live; migration 010 is NOT live yet.
-- Verify with: SELECT key FROM permissions WHERE key LIKE 'inbox.%' OR key LIKE 'org.%' OR key LIKE 'deliveries.%';
-- If no rows returned, this migration has already been applied — do NOT re-run.
--
-- Rollback: re-seed the original keys and their role_permissions, then delete canonical rows.
--   (Because the original role_permissions are removed, rollback requires knowing the original mapping.)
--   Keep a backup of role_permissions before applying if rollback may be needed.

-- ── Step 1: Insert canonical permission keys ──────────────────────────────────

INSERT INTO public.permissions (key, description, risk_level) VALUES
  -- messages.* (canonical for Inbox/Conversations — replaces inbox.*)
  ('messages.read',             'View inbox and conversations',                'low'),
  ('messages.reply',            'Reply to conversations',                      'low'),
  ('messages.assign',           'Assign conversations to team members',        'medium'),
  -- delivery.* (canonical for Delivery — replaces deliveries.*)
  ('delivery.read',             'View delivery status',                        'low'),
  ('delivery.create',           'Request deliveries',                          'medium'),
  ('delivery.update',           'Update delivery details',                     'medium'),
  -- organization.* (canonical for Org settings — replaces org.*)
  ('organization.read',         'View organization settings and audit logs',   'low'),
  ('organization.update',       'Update organization settings',                'high')
ON CONFLICT (key) DO NOTHING;

-- ── Step 2: Copy role_permissions from old keys to canonical keys ─────────────
--
-- For each old→new key pair, insert role_permissions for the canonical key
-- for every role that had the old key.

DO $$
DECLARE
  v_renames TEXT[][] := ARRAY[
    ARRAY['inbox.read',       'messages.read'],
    ARRAY['inbox.reply',      'messages.reply'],
    ARRAY['inbox.assign',     'messages.assign'],
    ARRAY['deliveries.read',  'delivery.read'],
    ARRAY['deliveries.create','delivery.create'],
    ARRAY['deliveries.update','delivery.update'],
    ARRAY['org.read',         'organization.read'],
    ARRAY['org.update',       'organization.update']
  ];
  v_pair        TEXT[];
  v_old_perm_id UUID;
  v_new_perm_id UUID;
BEGIN
  FOREACH v_pair SLICE 1 IN ARRAY v_renames LOOP
    SELECT id INTO v_old_perm_id FROM public.permissions WHERE key = v_pair[1];
    SELECT id INTO v_new_perm_id FROM public.permissions WHERE key = v_pair[2];

    IF v_old_perm_id IS NOT NULL AND v_new_perm_id IS NOT NULL THEN
      -- Copy every role_permission from old key to canonical key.
      INSERT INTO public.role_permissions (role_id, permission_id)
        SELECT rp.role_id, v_new_perm_id
        FROM public.role_permissions rp
        WHERE rp.permission_id = v_old_perm_id
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END;
$$;

-- ── Step 3: Delete old (non-canonical) permission rows ────────────────────────
--
-- Deleting from permissions cascades to role_permissions (FK ON DELETE CASCADE).
-- This removes the old role_permission rows; canonical rows were already inserted above.

DELETE FROM public.permissions
WHERE key IN (
  'inbox.read', 'inbox.reply', 'inbox.assign',
  'deliveries.read', 'deliveries.create', 'deliveries.update',
  'org.read', 'org.update'
);
