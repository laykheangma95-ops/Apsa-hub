-- Payment is the sole Order financial authority. Apply after 039 commits.
-- No hosted application in this phase. Existing financial events are immutable.
--
-- Lock order: Order BEFORE Payment for every financial RPC. Each aggregate read
-- follows the Order lock in a separate SQL statement (fresh READ COMMITTED
-- snapshot); concurrent split payments cannot publish a stale aggregate.
-- At stronger isolation PostgreSQL may require transaction retry.

CREATE UNIQUE INDEX payment_one_created_event
  ON public.payment_events(payment_id) WHERE event_type = 'created';
ALTER TABLE public.payment_events ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX payment_refund_idempotency
  ON public.payment_events(organization_id,payment_id,idempotency_key)
  WHERE event_type='refund' AND idempotency_key IS NOT NULL;

-- Principal and refunds come from the event ledger. A reversal/mismatch
-- invalidates unrefunded settlement, but never erases an actual refund.
CREATE VIEW public.order_payment_totals WITH (security_invoker = true) AS
WITH ledger AS (
  SELECT p.organization_id, p.order_id, p.status,
    COALESCE(MAX(e.amount_minor) FILTER (WHERE e.event_type = 'created'), 0) AS principal,
    COALESCE(SUM(e.amount_minor) FILTER (WHERE e.event_type = 'refund'), 0) AS refunded
  FROM public.payments p
  LEFT JOIN public.payment_events e
    ON e.payment_id = p.id AND e.organization_id = p.organization_id
  GROUP BY p.id
), totals AS (
  SELECT o.id AS order_id, o.organization_id, o.total_minor, o.currency,
    COALESCE(SUM(CASE WHEN l.status IN ('paid', 'refunded')
      THEN l.principal ELSE l.refunded END), 0)::bigint AS received_minor,
    COALESCE(SUM(l.refunded), 0)::bigint AS refunded_minor,
    COALESCE(BOOL_OR(l.status = 'pending'), false) AS has_pending,
    COALESCE(BOOL_OR(l.status = 'failed'), false) AS has_failed
  FROM public.orders o
  LEFT JOIN ledger l ON l.order_id = o.id AND l.organization_id = o.organization_id
  GROUP BY o.id
)
SELECT *,
  received_minor - refunded_minor AS net_minor,
  (CASE
    WHEN received_minor > 0 AND received_minor >= total_minor THEN 'paid'
    WHEN received_minor > 0 OR has_pending THEN 'pending'
    WHEN has_failed THEN 'failed'
    ELSE 'unpaid'
  END)::public.order_payment_status AS payment_status,
  (CASE
    WHEN refunded_minor = 0 THEN 'none'
    WHEN refunded_minor >= received_minor THEN 'full'
    ELSE 'partial'
  END)::public.order_refund_status AS refund_status
FROM totals;
REVOKE ALL ON public.order_payment_totals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.order_payment_totals TO service_role;

CREATE FUNCTION public.sync_order_payment_state(
  p_organization_id uuid, p_order_id uuid, p_actor uuid, p_reason text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE old_order record; derived record;
BEGIN
  SELECT * INTO old_order FROM public.orders
    WHERE id = p_order_id AND organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  SELECT * INTO STRICT derived FROM public.order_payment_totals
    WHERE order_id = p_order_id AND organization_id = p_organization_id;
  IF old_order.payment_status IS DISTINCT FROM derived.payment_status THEN
    INSERT INTO public.order_status_history
      (organization_id, order_id, axis, from_status, to_status, changed_by, reason)
    VALUES (p_organization_id, p_order_id, 'payment', old_order.payment_status::text,
      derived.payment_status::text, p_actor, p_reason);
  END IF;
  IF old_order.refund_status IS DISTINCT FROM derived.refund_status THEN
    INSERT INTO public.order_status_history
      (organization_id, order_id, axis, from_status, to_status, changed_by, reason)
    VALUES (p_organization_id, p_order_id, 'refund', old_order.refund_status::text,
      derived.refund_status::text, p_actor, p_reason);
  END IF;
  UPDATE public.orders
    SET payment_status = derived.payment_status, refund_status = derived.refund_status
    WHERE id = p_order_id AND
      (payment_status IS DISTINCT FROM derived.payment_status
       OR refund_status IS DISTINCT FROM derived.refund_status);
END;
$$;
REVOKE ALL ON FUNCTION public.sync_order_payment_state(uuid,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Financial identity is immutable, including against direct service writes.
CREATE FUNCTION public.guard_payment_principal() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, auth AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payment history cannot be deleted'; END IF;
  IF (NEW.organization_id,NEW.order_id,NEW.currency,NEW.amount_minor,NEW.method,NEW.id)
     IS DISTINCT FROM
     (OLD.organization_id,OLD.order_id,OLD.currency,OLD.amount_minor,OLD.method,OLD.id)
  THEN RAISE EXCEPTION 'Payment principal and identity are immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_principal_immutable BEFORE UPDATE OR DELETE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_payment_principal();

-- TRUNCATE bypasses row triggers, so append-only protection also needs a
-- statement guard. This protects privileged accidental maintenance SQL too.
CREATE FUNCTION public.block_payment_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, auth AS $$
BEGIN
  RAISE EXCEPTION 'Payment history is append-only: TRUNCATE % is forbidden', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER payments_no_truncate BEFORE TRUNCATE ON public.payments
  FOR EACH STATEMENT EXECUTE FUNCTION public.block_payment_truncate();
CREATE TRIGGER payment_events_no_truncate BEFORE TRUNCATE ON public.payment_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.block_payment_truncate();
CREATE TRIGGER payment_evidence_no_truncate BEFORE TRUNCATE ON public.payment_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION public.block_payment_truncate();

-- All same-tenant links additionally prove currency, including direct DB writes.
CREATE OR REPLACE FUNCTION public.check_payment_cross_tenant_refs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.orders
    WHERE id=NEW.order_id AND organization_id=NEW.organization_id AND currency=NEW.currency)
  THEN RAISE EXCEPTION 'cross_tenant_order or payment currency mismatch'; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.check_payment_cross_tenant_refs()
  FROM PUBLIC, anon, authenticated, service_role;

-- Keep historical bodies/signatures private; wrappers retain API compatibility.
ALTER FUNCTION public.record_payment_v1(uuid,uuid,uuid,text,bigint,text,text,text)
  RENAME TO record_payment_before_order_v1;
ALTER FUNCTION public.verify_payment_v1(uuid,uuid,uuid,text,text,text,jsonb)
  RENAME TO verify_payment_before_order_v1;
ALTER FUNCTION public.reverse_payment_v1(uuid,uuid,uuid,text)
  RENAME TO reverse_payment_before_order_v1;
ALTER FUNCTION public.refund_payment_v1(uuid,uuid,uuid,bigint,text)
  RENAME TO refund_payment_before_order_v1;
REVOKE ALL ON FUNCTION public.record_payment_before_order_v1(uuid,uuid,uuid,text,bigint,text,text,text),
  public.verify_payment_before_order_v1(uuid,uuid,uuid,text,text,text,jsonb),
  public.reverse_payment_before_order_v1(uuid,uuid,uuid,text),
  public.refund_payment_before_order_v1(uuid,uuid,uuid,bigint,text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.lock_payment_order(p_org uuid, p_payment uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE target uuid;
BEGIN
  SELECT order_id INTO target FROM public.payments
    WHERE id=p_payment AND organization_id=p_org;
  IF target IS NULL THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.orders WHERE id=target AND organization_id=p_org FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN target;
END;
$$;
REVOKE ALL ON FUNCTION public.lock_payment_order(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.record_payment_v1(
  p_organization_id uuid, p_order_id uuid, p_recorded_by uuid,
  p_method text, p_amount_minor bigint, p_reference text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE result jsonb;
BEGIN
  PERFORM 1 FROM public.orders
    WHERE id=p_order_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','not_found'); END IF;
  result := public.record_payment_before_order_v1(p_organization_id,p_order_id,
    p_recorded_by,p_method,p_amount_minor,p_reference,p_idempotency_key,p_note);
  IF result->>'status' = 'success' THEN
    -- A retry key cannot silently attach an existing payment to another Order.
    IF NOT EXISTS (SELECT 1 FROM public.payments
      WHERE id=(result->>'payment_id')::uuid AND order_id=p_order_id
        AND organization_id=p_organization_id AND amount_minor=p_amount_minor
        AND method::text=p_method)
    THEN RAISE EXCEPTION 'Payment idempotency key conflicts with original request'; END IF;
    PERFORM public.sync_order_payment_state(p_organization_id,p_order_id,p_recorded_by,'Payment recorded');
  END IF;
  RETURN result;
END;
$$;

CREATE FUNCTION public.verify_payment_v1(
  p_organization_id uuid, p_payment_id uuid, p_actor uuid,
  p_expected_from text, p_to text, p_reason text DEFAULT NULL, p_metadata jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE target uuid; result jsonb;
BEGIN
  target := public.lock_payment_order(p_organization_id,p_payment_id);
  IF target IS NULL THEN RETURN jsonb_build_object('status','not_found'); END IF;
  IF NOT COALESCE(CASE p_expected_from
    WHEN 'unverified' THEN p_to IN ('staff_confirmed','bank_verified','mismatch')
    WHEN 'staff_confirmed' THEN p_to IN ('manager_verified','bank_verified','mismatch')
    WHEN 'manager_verified' THEN p_to IN ('bank_verified','mismatch')
    WHEN 'bank_verified' THEN p_to = 'mismatch'
    WHEN 'mismatch' THEN p_to = 'unverified'
    WHEN 'duplicate_suspected' THEN p_to IN ('unverified','staff_confirmed','manager_verified','mismatch')
    ELSE false END, false)
  THEN RETURN jsonb_build_object('status','invalid_transition'); END IF;
  result := public.verify_payment_before_order_v1(p_organization_id,p_payment_id,p_actor,
    p_expected_from,p_to,p_reason,p_metadata);
  IF result->>'status' = 'success' THEN
    PERFORM public.sync_order_payment_state(p_organization_id,target,p_actor,
      COALESCE(p_reason,'Payment verification'));
  END IF;
  RETURN result;
END;
$$;

CREATE FUNCTION public.reverse_payment_v1(
  p_organization_id uuid, p_payment_id uuid, p_actor uuid, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE target uuid; result jsonb;
BEGIN
  target := public.lock_payment_order(p_organization_id,p_payment_id);
  IF target IS NULL THEN RETURN jsonb_build_object('status','not_found'); END IF;
  result := public.reverse_payment_before_order_v1(p_organization_id,p_payment_id,p_actor,p_reason);
  IF result->>'status' = 'success' THEN
    PERFORM public.sync_order_payment_state(p_organization_id,target,p_actor,p_reason);
  END IF;
  RETURN result;
END;
$$;

CREATE FUNCTION public.refund_payment_v1(
  p_organization_id uuid, p_payment_id uuid, p_actor uuid, p_amount_minor bigint, p_reason text,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE target uuid; payment record; previous record; refunded bigint;
  key text := NULLIF(trim(p_idempotency_key),'');
BEGIN
  target := public.lock_payment_order(p_organization_id,p_payment_id);
  IF target IS NULL THEN RETURN jsonb_build_object('status','not_found'); END IF;
  SELECT * INTO STRICT payment FROM public.payments WHERE id=p_payment_id FOR UPDATE;
  IF key IS NOT NULL THEN
    SELECT * INTO previous FROM public.payment_events
      WHERE organization_id=p_organization_id AND payment_id=p_payment_id
        AND event_type='refund' AND idempotency_key=key;
    IF FOUND THEN
      IF previous.amount_minor IS DISTINCT FROM p_amount_minor OR previous.reason IS DISTINCT FROM p_reason THEN
        RAISE EXCEPTION 'Refund idempotency key conflicts with original request';
      END IF;
      RETURN previous.metadata || jsonb_build_object('replayed',true);
    END IF;
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RETURN jsonb_build_object('status','invalid_amount');
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason))=0 THEN
    RETURN jsonb_build_object('status','reason_required');
  END IF;
  IF payment.status NOT IN ('paid','refunded') THEN
    RETURN jsonb_build_object('status','invalid_state','current',payment.status);
  END IF;
  SELECT COALESCE(SUM(amount_minor),0) INTO refunded FROM public.payment_events
    WHERE payment_id=p_payment_id AND event_type='refund';
  IF refunded + p_amount_minor > payment.amount_minor THEN
    RETURN jsonb_build_object('status','invalid_amount','reason','exceeds_paid_amount',
      'already_refunded',refunded,'payment_amount',payment.amount_minor);
  END IF;
  refunded := refunded + p_amount_minor;
  INSERT INTO public.payment_events
    (organization_id,payment_id,event_type,amount_minor,currency,actor_user_id,reason,idempotency_key,metadata)
  VALUES (p_organization_id,p_payment_id,'refund',p_amount_minor,payment.currency,p_actor,p_reason,key,
    jsonb_build_object('status','success','refunded_total',refunded,
      'fully_refunded',refunded=payment.amount_minor));
  IF refunded=payment.amount_minor THEN
    UPDATE public.payments SET status='refunded' WHERE id=p_payment_id;
  END IF;
  PERFORM public.sync_order_payment_state(p_organization_id,target,p_actor,p_reason);
  RETURN jsonb_build_object('status','success','refunded_total',refunded,
    'fully_refunded',refunded=payment.amount_minor);
END;
$$;

REVOKE ALL ON FUNCTION public.record_payment_v1(uuid,uuid,uuid,text,bigint,text,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_payment_v1(uuid,uuid,uuid,text,text,text,jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reverse_payment_v1(uuid,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_payment_v1(uuid,uuid,uuid,bigint,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_payment_v1(uuid,uuid,uuid,text,bigint,text,text,text),
  public.verify_payment_v1(uuid,uuid,uuid,text,text,text,jsonb),
  public.reverse_payment_v1(uuid,uuid,uuid,text),
  public.refund_payment_v1(uuid,uuid,uuid,bigint,text,text) TO service_role;
REVOKE INSERT,UPDATE,DELETE ON public.payments,public.payment_events,public.payment_evidence
  FROM service_role;
REVOKE TRUNCATE ON public.payments,public.payment_events,public.payment_evidence
  FROM PUBLIC,anon,authenticated,service_role;

-- Deprecate the old payment axis without changing lifecycle/stock/fulfillment.
ALTER FUNCTION public.transition_order_status_v1(uuid,uuid,text,text,text,uuid,text)
  RENAME TO transition_order_before_payment_authority_v1;
REVOKE ALL ON FUNCTION public.transition_order_before_payment_authority_v1(uuid,uuid,text,text,text,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.transition_order_status_v1(
  p_organization_id uuid,p_order_id uuid,p_axis text,p_expected_from text,p_to text,
  p_changed_by uuid DEFAULT NULL,p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,auth AS $$
BEGIN
  IF p_axis IN ('payment','refund') THEN
    RETURN jsonb_build_object('status','payment_domain_required');
  END IF;
  RETURN public.transition_order_before_payment_authority_v1(
    p_organization_id,p_order_id,p_axis,p_expected_from,p_to,p_changed_by,p_reason);
END;
$$;
REVOKE ALL ON FUNCTION public.transition_order_status_v1(uuid,uuid,text,text,text,uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.transition_order_status_v1(uuid,uuid,text,text,text,uuid,text)
  TO service_role;

-- Audit existing rows as they move to Payment authority. Do not invent Payment
-- events to support a legacy paid claim without Payment evidence.
DO $$
DECLARE target record;
BEGIN
  FOR target IN SELECT id,organization_id FROM public.orders ORDER BY id LOOP
    PERFORM public.sync_order_payment_state(target.organization_id,target.id,NULL,
      'Migration 040: recomputed from Payment ledger');
  END LOOP;
END;
$$;

CREATE FUNCTION public.guard_order_financial_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,auth AS $$
DECLARE derived record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.payment_status <> 'unpaid' OR NEW.refund_status <> 'none' THEN
      RAISE EXCEPTION 'Order financial state requires Payment domain';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments WHERE order_id=OLD.id) AND
    (NEW.id,NEW.organization_id,NEW.currency,NEW.total_minor) IS DISTINCT FROM
    (OLD.id,OLD.organization_id,OLD.currency,OLD.total_minor)
  THEN RAISE EXCEPTION 'Order financial identity is immutable after Payment recording'; END IF;
  SELECT * INTO STRICT derived FROM public.order_payment_totals WHERE order_id=OLD.id;
  IF NEW.payment_status IS DISTINCT FROM derived.payment_status
    OR NEW.refund_status IS DISTINCT FROM derived.refund_status
  THEN RAISE EXCEPTION 'Order financial state requires Payment domain'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER order_financial_authority BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_financial_state();
REVOKE ALL ON FUNCTION public.guard_order_financial_state()
  FROM PUBLIC, anon, authenticated, service_role;

-- Direct privileged Payment writes cannot commit inconsistent Order axes.
CREATE FUNCTION public.assert_payment_order_consistency() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,auth AS $$
DECLARE target uuid; invalid boolean;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN target := NEW.order_id;
  ELSE SELECT order_id INTO target FROM public.payments WHERE id=NEW.payment_id; END IF;
  SELECT o.payment_status IS DISTINCT FROM t.payment_status
    OR o.refund_status IS DISTINCT FROM t.refund_status INTO invalid
  FROM public.orders o JOIN public.order_payment_totals t ON t.order_id=o.id
  WHERE o.id=target;
  IF invalid THEN RAISE EXCEPTION 'Payment and Order financial state must commit together'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER payment_order_consistency
  AFTER INSERT OR UPDATE ON public.payments DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_payment_order_consistency();
CREATE CONSTRAINT TRIGGER payment_event_order_consistency
  AFTER INSERT ON public.payment_events DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_payment_order_consistency();
REVOKE ALL ON FUNCTION public.assert_payment_order_consistency()
  FROM PUBLIC, anon, authenticated, service_role;
