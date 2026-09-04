-- Migration: 020_product_cross_tenant_integrity
-- Purpose: Enforce at DB level that products.workspace_id and products.category_id
--          reference rows belonging to the SAME organization as the product.
--
-- The existing FK constraints only check that the referenced rows exist; they do
-- NOT prevent Org A from referencing Org B's workspace or category.
--
-- This migration adds a BEFORE INSERT OR UPDATE trigger on products that:
--   1. Rejects workspace_id pointing to a workspace in a different org.
--   2. Rejects category_id pointing to a category in a different org.
--
-- The trigger fires for both INSERT and UPDATE so that:
--   - createProduct with a cross-org workspace_id/category_id is blocked.
--   - updateProduct patching workspace_id/category_id to a cross-org value is blocked.
--
-- Never edit already-applied migrations. This is the forward migration.

CREATE OR REPLACE FUNCTION public.check_product_cross_tenant_refs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Reject workspace_id that belongs to a different organization.
  IF NEW.workspace_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM   public.workspaces
      WHERE  id              = NEW.workspace_id
        AND  organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION
        'product workspace_id must belong to the same organization as the product (cross_tenant_workspace)';
    END IF;
  END IF;

  -- Reject category_id that belongs to a different organization.
  IF NEW.category_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM   public.product_categories
      WHERE  id              = NEW.category_id
        AND  organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION
        'product category_id must belong to the same organization as the product (cross_tenant_category)';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER product_cross_tenant_refs_check
  BEFORE INSERT OR UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.check_product_cross_tenant_refs();
