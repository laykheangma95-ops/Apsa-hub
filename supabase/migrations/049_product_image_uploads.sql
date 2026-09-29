-- Migration: 049_product_image_uploads
-- Purpose: Bound signed-upload issuance and abandoned-upload accumulation for
--          V1 product images (follow-up to 048).
-- Repo-only: NOT applied to any hosted project by this change. Apply through the
-- normal reviewed staging → production path, after 048.
-- Touches: public.product_image_uploads (NEW). No existing object is changed.
--
-- Design
--   * One row per signed upload URL the server has issued: which organization,
--     which product, who asked, the exact server-generated object path, and
--     when the ticket (not the signed URL) expires.
--   * ticket = permission to attach. attachProductImage refuses a path that has
--     no live ticket, and deletes the ticket once the product points at the
--     object. A row therefore exists only while an upload is outstanding.
--   * expires_at is set LONGER than the signed upload token's own lifetime
--     (Supabase: 2 h), so by the time a ticket is expired no upload can still
--     land. The server sweeps expired tickets, oldest first and bounded per
--     call, deleting the object only when NO product references it, then the
--     row. The sweep is what prevents permanent accumulation.
--   * The row is also the durable counter for "outstanding tickets" per member
--     and per organization (the per-window issuance limits live in
--     consume_rate_limit, migration 045).
--
-- Access model: RLS ENABLED, NO policies, every privilege revoked from
-- anon/authenticated. Only the APSA server (service role) reads or writes it;
-- organization_id / issued_by are set by the server from the verified session,
-- never taken from a client. No SECURITY DEFINER function is introduced.

CREATE TABLE public.product_image_uploads (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_id      UUID        NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  issued_by       UUID        NOT NULL,
  object_path     TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  CONSTRAINT product_image_uploads_path_owned CHECK (
    object_path ~ (
      '^' || organization_id::text || '/' || product_id::text ||
      '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
    )
  ),
  CONSTRAINT product_image_uploads_expiry_order CHECK (expires_at > created_at)
);

-- One ticket per object; the path is the lookup key for attach.
CREATE UNIQUE INDEX uniq_product_image_uploads_path
  ON public.product_image_uploads(object_path);

-- Sweep: oldest expired tickets first.
CREATE INDEX product_image_uploads_expires_idx
  ON public.product_image_uploads(expires_at);

-- Outstanding-ticket caps: per organization and per member.
CREATE INDEX product_image_uploads_org_member_idx
  ON public.product_image_uploads(organization_id, issued_by, expires_at);

ALTER TABLE public.product_image_uploads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.product_image_uploads FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.product_image_uploads TO service_role;
