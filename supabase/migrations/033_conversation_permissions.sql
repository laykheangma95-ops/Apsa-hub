-- Migration: 033_conversation_permissions
-- Purpose: Insert the remaining messages.* permission keys per
--          PERMISSIONS_MATRIX.md §10 (Inbox/Conversations) and assign them to
--          system roles.
--
-- NOTE: messages.read, messages.reply and messages.assign ALREADY EXIST and
-- are already correctly assigned to system roles — they were canonicalized
-- from the old inbox.* keys in migration 010 (which copied role_permissions
-- from migration 003's original inbox.read/inbox.reply/inbox.assign grants).
-- This migration only adds the keys migration 010 did not cover.
--
-- Permission keys added here:
--   messages.reassign_self       — take an unassigned/other conversation for yourself
--   messages.mark_followup       — mark a conversation as needing follow-up
--   messages.close_conversation  — close a conversation
--   messages.view_all_team       — see conversations assigned to other staff (not yet
--                                  enforced in the service layer this phase — see
--                                  src/server/conversations/service.ts's own note;
--                                  seeded now so the permission vocabulary is complete
--                                  and ready when that restriction ships)
--   messages.delete_local_note   — delete a staff-only local note on a conversation
--                                  (no local-note feature exists yet; seeded for the
--                                  same reason as messages.view_all_team above)
--
-- Matrix (✅ = full, ⚠️ = conditional / application-layer extra check — granted
-- at the DB level the same as ✅, per the existing customers.update_basic precedent
-- in migration 016):
--   Permission                   OWNER  MANAGER  CASHIER  SALES  CUSTOMER_SERVICE
--   messages.reassign_self         ✅      ✅       ❌       ✅        ✅
--   messages.mark_followup         ✅      ✅       ⚠️       ✅        ✅
--   messages.close_conversation    ✅      ✅       ⚠️       ✅        ✅
--   messages.view_all_team         ✅      ✅       ❌       ⚠️        ⚠️
--   messages.delete_local_note     ✅      ✅       ⚠️       ⚠️        ⚠️

-- ── Step 1: Insert permission rows ────────────────────────────────────────────

INSERT INTO public.permissions (key, description, risk_level) VALUES
  ('messages.reassign_self',      'Take an unassigned or another staff member''s conversation', 'low'),
  ('messages.mark_followup',      'Mark a conversation as needing follow-up',                    'low'),
  ('messages.close_conversation', 'Close a conversation',                                        'low'),
  ('messages.view_all_team',      'View conversations assigned to other staff members',          'medium'),
  ('messages.delete_local_note',  'Delete a staff-only local note on a conversation',             'medium')
ON CONFLICT (key) DO NOTHING;

-- ── Step 2: Assign permissions to system roles ────────────────────────────────

DO $$
DECLARE
  v_owner_id   UUID;
  v_manager_id UUID;
  v_cashier_id UUID;
  v_sales_id   UUID;
  v_cs_id      UUID;
  v_perm_id    UUID;
  v_role       UUID;
BEGIN
  SELECT id INTO v_owner_id   FROM public.roles WHERE system_role = 'OWNER'            AND organization_id IS NULL;
  SELECT id INTO v_manager_id FROM public.roles WHERE system_role = 'MANAGER'          AND organization_id IS NULL;
  SELECT id INTO v_cashier_id FROM public.roles WHERE system_role = 'CASHIER'          AND organization_id IS NULL;
  SELECT id INTO v_sales_id   FROM public.roles WHERE system_role = 'SALES'            AND organization_id IS NULL;
  SELECT id INTO v_cs_id      FROM public.roles WHERE system_role = 'CUSTOMER_SERVICE' AND organization_id IS NULL;

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'System role OWNER not found — ensure migration 003 has been applied.';
  END IF;

  -- messages.reassign_self — Owner, Manager, Sales, Customer Service (not Cashier)
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'messages.reassign_self';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id, v_sales_id, v_cs_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- messages.mark_followup — all roles (Cashier conditional, app layer extra check)
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'messages.mark_followup';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id, v_cashier_id, v_sales_id, v_cs_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- messages.close_conversation — all roles (Cashier conditional, app layer extra check)
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'messages.close_conversation';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id, v_cashier_id, v_sales_id, v_cs_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- messages.view_all_team — Owner, Manager, Sales, Customer Service (not Cashier)
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'messages.view_all_team';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id, v_sales_id, v_cs_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- messages.delete_local_note — all roles (Cashier/Sales/CS conditional, app layer extra check)
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'messages.delete_local_note';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id, v_cashier_id, v_sales_id, v_cs_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;
END;
$$;
