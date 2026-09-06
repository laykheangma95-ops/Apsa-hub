-- Additive schema preparation. Commit before 040 uses the new history enum value.
CREATE TYPE public.order_refund_status AS ENUM ('none', 'partial', 'full');
ALTER TYPE public.order_status_axis ADD VALUE 'refund';
ALTER TABLE public.orders
  ADD COLUMN refund_status public.order_refund_status NOT NULL DEFAULT 'none';
COMMENT ON COLUMN public.orders.refund_status IS
  'Payment-derived refund axis. Partial/full refunds preserve paid receipt status. Never client-writable.';
