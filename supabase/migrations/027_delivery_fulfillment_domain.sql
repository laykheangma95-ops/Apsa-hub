-- Migration: 027_delivery_fulfillment_domain
-- Production Delivery/Fulfillment domain. Forward-only; merged Order/Inventory
-- migrations are intentionally unchanged.

CREATE TYPE public.delivery_status AS ENUM (
  'pending', 'preparing', 'ready', 'in_transit', 'delivered', 'failed', 'cancelled'
);

-- Optional tenant-owned provider identity. V1 also supports a provider-name
-- snapshot directly on deliveries for manual provider mode.
CREATE TABLE public.delivery_providers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider_key    TEXT NOT NULL CHECK (length(trim(provider_key)) > 0),
  name            TEXT NOT NULL CHECK (length(trim(name)) > 0),
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider_key)
);

CREATE TRIGGER delivery_providers_set_updated_at
  BEFORE UPDATE ON public.delivery_providers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.deliveries (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  order_id                 UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  location_id              UUID REFERENCES public.locations(id) ON DELETE RESTRICT,
  provider_id              UUID REFERENCES public.delivery_providers(id) ON DELETE RESTRICT,
  provider_key             TEXT,
  provider_name            TEXT NOT NULL CHECK (length(trim(provider_name)) > 0),
  external_tracking_number TEXT,
  -- Operational reference only. This is not a payment record and never drives
  -- orders.payment_status or COD settlement state.
  cod_amount_minor         BIGINT CHECK (cod_amount_minor >= 0),
  cod_currency             TEXT CHECK (cod_currency IN ('USD', 'KHR')),
  status                   public.delivery_status NOT NULL DEFAULT 'pending',
  created_by               UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT deliveries_cod_pair CHECK (
    (cod_amount_minor IS NULL AND cod_currency IS NULL)
    OR (cod_amount_minor IS NOT NULL AND cod_currency IS NOT NULL)
  )
);

CREATE INDEX idx_deliveries_org_created
  ON public.deliveries(organization_id, created_at DESC);
CREATE INDEX idx_deliveries_org_order
  ON public.deliveries(organization_id, order_id);
CREATE INDEX idx_deliveries_org_status
  ON public.deliveries(organization_id, status);

-- Serialised by the parent-order FOR UPDATE lock in create_delivery_v1, and
-- backed by a unique constraint so even a future write path cannot race it.
CREATE UNIQUE INDEX uniq_deliveries_active_order
  ON public.deliveries(organization_id, order_id)
  WHERE status IN ('pending', 'preparing', 'ready', 'in_transit');

CREATE TRIGGER deliveries_set_updated_at
  BEFORE UPDATE ON public.deliveries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.delivery_status_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  delivery_id     UUID NOT NULL REFERENCES public.deliveries(id) ON DELETE RESTRICT,
  -- NULL denotes creation; every later row has a real prior state.
  from_status     public.delivery_status,
  to_status       public.delivery_status NOT NULL,
  changed_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_history_changed CHECK (
    from_status IS NULL OR from_status <> to_status
  )
);

CREATE INDEX idx_delivery_history_delivery
  ON public.delivery_status_history(delivery_id, created_at DESC);
CREATE INDEX idx_delivery_history_org
  ON public.delivery_status_history(organization_id, created_at DESC);

-- Database-level tenant integrity, including service-role writes.
CREATE OR REPLACE FUNCTION public.check_delivery_cross_tenant_refs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = NEW.order_id AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'cross_tenant_order: delivery order must belong to organization';
  END IF;

  IF NEW.location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.locations
    WHERE id = NEW.location_id AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'cross_tenant_location: delivery location must belong to organization';
  END IF;

  IF NEW.provider_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.delivery_providers
    WHERE id = NEW.provider_id AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'cross_tenant_provider: delivery provider must belong to organization';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_cross_tenant_refs_check
  BEFORE INSERT OR UPDATE ON public.deliveries
  FOR EACH ROW EXECUTE FUNCTION public.check_delivery_cross_tenant_refs();

CREATE OR REPLACE FUNCTION public.check_delivery_history_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.deliveries
    WHERE id = NEW.delivery_id AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'cross_tenant_delivery: history organization must match delivery';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_history_integrity_check
  BEFORE INSERT ON public.delivery_status_history
  FOR EACH ROW EXECUTE FUNCTION public.check_delivery_history_integrity();

-- Create delivery + initial history + coarse Order fulfillment in one transaction.
CREATE OR REPLACE FUNCTION public.create_delivery_v1(
  p_organization_id          UUID,
  p_order_id                 UUID,
  p_created_by               UUID DEFAULT NULL,
  p_location_id              UUID DEFAULT NULL,
  p_provider_id              UUID DEFAULT NULL,
  p_provider_key             TEXT DEFAULT NULL,
  p_provider_name            TEXT DEFAULT NULL,
  p_external_tracking_number TEXT DEFAULT NULL,
  p_cod_amount_minor         BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_order         RECORD;
  v_provider      RECORD;
  v_location_id   UUID;
  v_provider_key  TEXT;
  v_provider_name TEXT;
  v_delivery_id   UUID;
BEGIN
  -- This lock serializes duplicate-create attempts for the same order.
  SELECT id, organization_id, location_id, currency, lifecycle_status, fulfillment_status
    INTO v_order
  FROM public.orders
  WHERE id = p_order_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'order_not_found'); END IF;
  IF v_order.lifecycle_status <> 'confirmed' THEN
    RETURN jsonb_build_object('status', 'order_not_confirmed');
  END IF;
  IF v_order.fulfillment_status IN ('fulfilled', 'cancelled') THEN
    RETURN jsonb_build_object('status', 'order_fulfillment_terminal');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.deliveries
    WHERE organization_id = p_organization_id AND order_id = p_order_id
      AND status IN ('pending', 'preparing', 'ready', 'in_transit')
  ) THEN
    RETURN jsonb_build_object('status', 'duplicate_active');
  END IF;

  v_location_id := COALESCE(p_location_id, v_order.location_id);
  IF v_location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.locations
    WHERE id = v_location_id AND organization_id = p_organization_id
  ) THEN
    RETURN jsonb_build_object('status', 'location_not_found');
  END IF;

  IF p_provider_id IS NOT NULL THEN
    SELECT provider_key, name, active INTO v_provider
    FROM public.delivery_providers
    WHERE id = p_provider_id AND organization_id = p_organization_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 'provider_not_found'); END IF;
    IF NOT v_provider.active THEN RETURN jsonb_build_object('status', 'provider_inactive'); END IF;
    v_provider_key := v_provider.provider_key;
    v_provider_name := v_provider.name;
  ELSE
    v_provider_key := NULLIF(trim(p_provider_key), '');
    v_provider_name := NULLIF(trim(p_provider_name), '');
    IF v_provider_name IS NULL THEN
      RETURN jsonb_build_object('status', 'provider_required');
    END IF;
  END IF;

  IF p_cod_amount_minor IS NOT NULL AND p_cod_amount_minor < 0 THEN
    RETURN jsonb_build_object('status', 'invalid_cod_amount');
  END IF;

  INSERT INTO public.deliveries (
    organization_id, order_id, location_id, provider_id, provider_key, provider_name,
    external_tracking_number, cod_amount_minor, cod_currency, status, created_by
  ) VALUES (
    p_organization_id, p_order_id, v_location_id, p_provider_id,
    v_provider_key, v_provider_name, NULLIF(trim(p_external_tracking_number), ''),
    p_cod_amount_minor, CASE WHEN p_cod_amount_minor IS NULL THEN NULL ELSE v_order.currency END,
    'pending', p_created_by
  ) RETURNING id INTO v_delivery_id;

  INSERT INTO public.delivery_status_history (
    organization_id, delivery_id, from_status, to_status, changed_by, reason
  ) VALUES (
    p_organization_id, v_delivery_id, NULL, 'pending', p_created_by, 'Delivery created'
  );

  -- pending maps to processing. Do not duplicate Order history if an existing
  -- manual fulfillment action had already moved the Order to processing.
  IF v_order.fulfillment_status = 'unfulfilled' THEN
    UPDATE public.orders SET fulfillment_status = 'processing' WHERE id = p_order_id;
    INSERT INTO public.order_status_history (
      organization_id, order_id, axis, from_status, to_status, changed_by, reason
    ) VALUES (
      p_organization_id, p_order_id, 'fulfillment', 'unfulfilled', 'processing',
      p_created_by, 'Delivery created'
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'success', 'delivery_id', v_delivery_id, 'order_fulfillment', 'processing'
  );
END;
$$;

-- Narrow application handlers call this single transactional primitive. The
-- expected-from value plus FOR UPDATE protects concurrent and replayed calls.
CREATE OR REPLACE FUNCTION public.transition_delivery_status_v1(
  p_organization_id UUID,
  p_delivery_id     UUID,
  p_expected_from   TEXT,
  p_to              TEXT,
  p_changed_by      UUID DEFAULT NULL,
  p_reason          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_delivery          RECORD;
  v_order             RECORD;
  v_current           TEXT;
  v_order_fulfillment public.order_fulfillment_status;
  v_allowed           BOOLEAN := false;
BEGIN
  SELECT id, order_id, status INTO v_delivery
  FROM public.deliveries
  WHERE id = p_delivery_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;

  v_current := v_delivery.status::TEXT;
  IF v_current <> p_expected_from THEN
    RETURN jsonb_build_object('status', 'stale', 'current', v_current);
  END IF;
  IF v_current = p_to THEN
    RETURN jsonb_build_object('status', 'no_change', 'current', v_current);
  END IF;
  IF v_current IN ('delivered', 'failed', 'cancelled') THEN
    RETURN jsonb_build_object('status', 'terminal', 'current', v_current);
  END IF;

  v_allowed := CASE v_current
    WHEN 'pending'    THEN p_to IN ('preparing', 'cancelled')
    WHEN 'preparing'  THEN p_to IN ('ready', 'cancelled')
    WHEN 'ready'      THEN p_to IN ('in_transit', 'cancelled')
    WHEN 'in_transit' THEN p_to IN ('delivered', 'failed')
    ELSE false
  END;
  IF NOT v_allowed THEN RETURN jsonb_build_object('status', 'invalid_transition'); END IF;

  SELECT id, lifecycle_status, fulfillment_status INTO v_order
  FROM public.orders
  WHERE id = v_delivery.order_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_order.lifecycle_status IN ('completed', 'cancelled') THEN
    RETURN jsonb_build_object('status', 'order_terminal');
  END IF;

  v_order_fulfillment := CASE
    WHEN p_to IN ('preparing', 'ready', 'in_transit') THEN 'processing'::public.order_fulfillment_status
    WHEN p_to = 'delivered' THEN 'fulfilled'::public.order_fulfillment_status
    WHEN p_to = 'cancelled' THEN 'cancelled'::public.order_fulfillment_status
    WHEN p_to = 'failed' THEN 'unfulfilled'::public.order_fulfillment_status
    ELSE NULL
  END;

  -- Never overwrite an independently terminal Order fulfillment state.
  IF v_order.fulfillment_status IN ('fulfilled', 'cancelled')
     AND v_order.fulfillment_status <> v_order_fulfillment THEN
    RETURN jsonb_build_object('status', 'order_fulfillment_terminal');
  END IF;

  UPDATE public.deliveries SET status = p_to::public.delivery_status
  WHERE id = p_delivery_id;
  INSERT INTO public.delivery_status_history (
    organization_id, delivery_id, from_status, to_status, changed_by, reason
  ) VALUES (
    p_organization_id, p_delivery_id, v_current::public.delivery_status,
    p_to::public.delivery_status, p_changed_by, NULLIF(trim(p_reason), '')
  );

  IF v_order.fulfillment_status <> v_order_fulfillment THEN
    UPDATE public.orders SET fulfillment_status = v_order_fulfillment WHERE id = v_order.id;
    INSERT INTO public.order_status_history (
      organization_id, order_id, axis, from_status, to_status, changed_by, reason
    ) VALUES (
      p_organization_id, v_order.id, 'fulfillment',
      v_order.fulfillment_status::TEXT, v_order_fulfillment::TEXT,
      p_changed_by, 'Delivery status: ' || p_to
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'success', 'from', v_current, 'to', p_to,
    'order_fulfillment', v_order_fulfillment::TEXT
  );
END;
$$;

-- Permission-specific server reads and all mutations use service_role. Bare
-- membership must never become a second authorization path.
ALTER TABLE public.delivery_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_status_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "delivery_providers_select_blocked" ON public.delivery_providers FOR SELECT USING (false);
CREATE POLICY "delivery_providers_insert_blocked" ON public.delivery_providers FOR INSERT WITH CHECK (false);
CREATE POLICY "delivery_providers_update_blocked" ON public.delivery_providers FOR UPDATE USING (false);
CREATE POLICY "delivery_providers_no_delete" ON public.delivery_providers FOR DELETE USING (false);

CREATE POLICY "deliveries_select_blocked" ON public.deliveries FOR SELECT USING (false);
CREATE POLICY "deliveries_insert_blocked" ON public.deliveries FOR INSERT WITH CHECK (false);
CREATE POLICY "deliveries_update_blocked" ON public.deliveries FOR UPDATE USING (false);
CREATE POLICY "deliveries_no_delete" ON public.deliveries FOR DELETE USING (false);

CREATE POLICY "delivery_status_history_select_blocked" ON public.delivery_status_history FOR SELECT USING (false);
CREATE POLICY "delivery_status_history_insert_blocked" ON public.delivery_status_history FOR INSERT WITH CHECK (false);
CREATE POLICY "delivery_status_history_no_update" ON public.delivery_status_history FOR UPDATE USING (false);
CREATE POLICY "delivery_status_history_no_delete" ON public.delivery_status_history FOR DELETE USING (false);

-- Reconcile the three already-canonical delivery permissions to the current
-- matrix. Conditional grants stay unassigned until APSA has the condition they
-- depend on; granting them outright would silently make them unconditional.
DO $$
DECLARE
  v_read_id   UUID;
  v_create_id UUID;
  v_update_id UUID;
BEGIN
  SELECT id INTO v_read_id FROM public.permissions WHERE key = 'delivery.read';
  SELECT id INTO v_create_id FROM public.permissions WHERE key = 'delivery.create';
  SELECT id INTO v_update_id FROM public.permissions WHERE key = 'delivery.update';

  IF v_read_id IS NULL OR v_create_id IS NULL OR v_update_id IS NULL THEN
    RAISE EXCEPTION 'Canonical delivery permissions missing; apply migration 010 first';
  END IF;

  -- Remove only over-broad system-role assignments. Custom-role grants remain
  -- organization-owned and untouched.
  DELETE FROM public.role_permissions rp
  USING public.roles r
  WHERE rp.role_id = r.id
    AND r.organization_id IS NULL
    AND r.system_role IN ('CASHIER', 'SALES', 'CUSTOMER_SERVICE')
    AND rp.permission_id = v_update_id;

  DELETE FROM public.role_permissions rp
  USING public.roles r
  WHERE rp.role_id = r.id
    AND r.organization_id IS NULL
    AND r.system_role = 'CUSTOMER_SERVICE'
    AND rp.permission_id = v_create_id;

  -- read: all built-ins; create: Owner/Manager/Cashier/Sales; update/manual
  -- transition (including cancellation): Owner/Manager only.
  INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, v_read_id FROM public.roles r
    WHERE r.organization_id IS NULL
      AND r.system_role IN ('OWNER', 'MANAGER', 'CASHIER', 'SALES', 'CUSTOMER_SERVICE')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, v_create_id FROM public.roles r
    WHERE r.organization_id IS NULL
      AND r.system_role IN ('OWNER', 'MANAGER', 'CASHIER', 'SALES')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, v_update_id FROM public.roles r
    WHERE r.organization_id IS NULL
      AND r.system_role IN ('OWNER', 'MANAGER')
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.delivery_providers FROM anon, authenticated;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.deliveries FROM anon, authenticated;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.delivery_status_history FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.create_delivery_v1(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.transition_delivery_status_v1(UUID, UUID, TEXT, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_delivery_v1(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_delivery_status_v1(UUID, UUID, TEXT, TEXT, UUID, TEXT)
  TO service_role;
