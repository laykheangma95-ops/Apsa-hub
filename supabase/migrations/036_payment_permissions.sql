-- Migration: 036_payment_permissions
-- Purpose: Seed the finer-grained Payment permission vocabulary per
--          PERMISSIONS_MATRIX.md §17 (Payments), which the production
--          Payment domain (src/server/payments/*) requires and which
--          migration 003 explicitly deferred — see src/server/orders/
--          state-machine.ts: "Finer keys (payments.record, payments.mark_cod,
--          payments.override_status from §17) arrive with the Payment
--          Records domain, which is what makes them distinguishable."
--
-- REUSED, NOT RE-CREATED — already seeded by migration 003 and left
-- untouched by this migration:
--   payments.read      — already granted broadly; the Payment domain reuses it
--   payments.confirm   — the Order domain's own payment-axis permission
--                         (src/server/orders/state-machine.ts). Unrelated to
--                         this domain's finer keys; not touched here.
--   payments.override  — legacy key from migration 003, currently unused by
--                         any code path. Left in place (existing custom-role
--                         grants, if any, must not be silently revoked) but
--                         superseded going forward by payments.override_status
--                         below, which is the key PERMISSIONS_MATRIX.md §17
--                         actually names.
--
-- ADDED HERE — defined by PERMISSIONS_MATRIX.md §17 but never seeded, plus
-- three keys the matrix does not name that the Payment domain's finer
-- verification model requires (payments.verify, payments.reverse,
-- payments.reconcile — risk-tiered to match the closest matrix row, see
-- inline rationale below):
--   payments.record               — record a payment (cash/KHQR/bank transfer)
--   payments.manual_confirm        — staff confirms payment received
--   payments.mark_cod              — record a COD settlement payment
--   payments.refund                — refund a payment
--   payments.override_status       — owner-only correction/override authority
--   payments.view_provider_reference — view raw bank/KHQR reference + evidence
--   payments.verify                — manager/bank-level verification escalation
--   payments.reverse               — reverse a payment
--   payments.reconcile             — view reconciliation aggregates
--
-- Matrix rows implemented (✅ = assigned here, ⚠️ = conditional, deliberately
-- NOT granted outright — the same convention as migrations 019, 022, 025, 027):
--   Permission                        OWNER  MANAGER  CASHIER  SALES  CUSTOMER_SERVICE
--   payments.record                     ✅      ✅       ✅       ⚠️         ❌
--   payments.manual_confirm             ✅      ✅       ⚠️       ❌         ❌
--   payments.mark_cod                   ✅      ✅       ✅       ✅         ⚠️
--   payments.refund                     ✅      ⚠️       ❌       ❌         ❌
--   payments.override_status            ✅*     ❌       ❌       ❌         ❌
--   payments.view_provider_reference    ✅      ✅       ⚠️       ❌         ❌
--   payments.verify                     ✅      ✅       ❌       ❌         ❌
--   payments.reverse                    ✅      ❌       ❌       ❌         ❌
--   payments.reconcile                  ✅      ✅       ❌       ❌         ❌
--
-- WHY payments.verify / payments.reverse / payments.reconcile ARE NOT OVER-
-- OR UNDER-GRANTED RELATIVE TO THE MATRIX
--   verify escalates a staff confirmation to manager/bank trust level — the
--   same tier as view_provider_reference (Owner + Manager only; Cashier stays
--   conditional/unassigned pending a future capped scope, exactly like
--   orders.apply_discount in migration 025).
--   reverse undoes a claimed or settled payment outright — the same tier as
--   refund and override_status (Owner only outright; PERMISSIONS_MATRIX.md
--   marks refund's Manager grant ⚠️ conditional, not unconditional, so reverse
--   follows the more conservative posture rather than assuming Manager should
--   have it).
--   reconcile is read-only but exposes org-wide financial position (expected
--   revenue, unresolved payments) — the same tier as financials.revenue
--   (Owner + Manager; Cashier/Sales/Customer Service excluded).
--
-- OWNER is granted explicitly for every key, not inherited: migration 003's
-- "OWNER gets every permission" seed was a one-time INSERT ... SELECT over the
-- permissions that existed then; it does not retroactively pick up keys added
-- by later migrations (see migration 025's identical note).

-- ── Step 1: Insert permission rows ────────────────────────────────────────────

INSERT INTO public.permissions (key, description, risk_level) VALUES
  ('payments.record',                 'Record a payment against an order (cash/KHQR/bank transfer)', 'high'),
  ('payments.manual_confirm',         'Confirm payment received without bank verification',          'high'),
  ('payments.mark_cod',               'Record a cash-on-delivery settlement payment',                 'medium'),
  ('payments.refund',                 'Refund a payment',                                              'critical'),
  ('payments.override_status',        'Owner-level correction/override of a payment record',          'critical'),
  ('payments.view_provider_reference','View raw bank/KHQR reference and payment evidence',             'high'),
  ('payments.verify',                 'Escalate a payment to manager or bank-verified trust level',    'high'),
  ('payments.reverse',                'Reverse a claimed or settled payment',                          'critical'),
  ('payments.reconcile',              'View organization-wide payment reconciliation aggregates',      'high')
ON CONFLICT (key) DO NOTHING;

-- ── Step 2: Assign permissions to system roles ────────────────────────────────

DO $$
DECLARE
  v_owner_id   UUID;
  v_manager_id UUID;
  v_cashier_id UUID;
  v_sales_id   UUID;
  v_perm_id    UUID;
  v_role       UUID;
BEGIN
  SELECT id INTO v_owner_id   FROM public.roles WHERE system_role = 'OWNER'   AND organization_id IS NULL;
  SELECT id INTO v_manager_id FROM public.roles WHERE system_role = 'MANAGER' AND organization_id IS NULL;
  SELECT id INTO v_cashier_id FROM public.roles WHERE system_role = 'CASHIER' AND organization_id IS NULL;
  SELECT id INTO v_sales_id   FROM public.roles WHERE system_role = 'SALES'   AND organization_id IS NULL;

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'System role OWNER not found — ensure migration 003 has been applied.';
  END IF;

  -- payments.record — Owner, Manager, Cashier. Sales/Customer Service stay
  -- unassigned (⚠️/❌): recording a payment at the counter is a Cashier
  -- action, not a field-sales one.
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'payments.record';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id, v_cashier_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- payments.manual_confirm — Owner, Manager. Cashier is ⚠️ in the matrix
  -- (conditional, not granted outright): "Confirm payment received" without
  -- any bank verification is the highest-trust manual action in this domain.
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'payments.manual_confirm';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- payments.mark_cod — Owner, Manager, Cashier, Sales. COD settlement is
  -- routinely collected and recorded by whoever is holding the goods or cash,
  -- which includes field/sales staff — matches the matrix's broad ✅ row.
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'payments.mark_cod';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id, v_cashier_id, v_sales_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- payments.refund — Owner only outright. Manager is ⚠️ in the matrix
  -- (conditional — e.g. capped amount, not implemented yet); granting the
  -- uncapped key now would be strictly more access than the matrix intends,
  -- the same reasoning migration 025 applied to orders.apply_discount.
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'payments.refund';
  INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_owner_id, v_perm_id) ON CONFLICT DO NOTHING;

  -- payments.override_status — Owner only. The matrix marks this OWNER✅*
  -- with an explicit asterisk; no other role gets it.
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'payments.override_status';
  INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_owner_id, v_perm_id) ON CONFLICT DO NOTHING;

  -- payments.view_provider_reference — Owner, Manager. Cashier stays ⚠️
  -- (conditional, not granted outright) per the matrix.
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'payments.view_provider_reference';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- payments.verify — Owner, Manager. Same tier as view_provider_reference.
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'payments.verify';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- payments.reverse — Owner only. Same tier as refund/override_status.
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'payments.reverse';
  INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_owner_id, v_perm_id) ON CONFLICT DO NOTHING;

  -- payments.reconcile — Owner, Manager. Same tier as financials.revenue.
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'payments.reconcile';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;
END;
$$;
