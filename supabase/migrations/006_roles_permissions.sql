-- Migration: 006_roles_permissions
-- Purpose: RBAC foundation — roles, permission keys, role↔permission mapping
-- Tables: roles, permissions, role_permissions
-- Classification:
--   roles: shared reference (system) + tenant-private (custom org roles)
--   permissions: shared reference data (platform-defined keys)
--   role_permissions: shared reference (system) + tenant-private (custom)
-- Indexes: roles(organization_id), permissions(key), role_permissions(role_id, permission_id)
-- Constraints: permissions.key unique; system_role enum
-- Rollback: DROP TABLE public.role_permissions, public.permissions, public.roles CASCADE;

CREATE TYPE public.system_role_key AS ENUM (
  'OWNER',
  'MANAGER',
  'CASHIER',
  'SALES',
  'CUSTOMER_SERVICE'
);

CREATE TYPE public.risk_level AS ENUM ('low', 'medium', 'high', 'critical');

-- Roles: system roles (organization_id IS NULL) serve as templates.
-- Custom org roles have organization_id set.
CREATE TABLE public.roles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  system_role     public.system_role_key,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT roles_system_unique UNIQUE NULLS NOT DISTINCT (organization_id, system_role)
);

CREATE INDEX idx_roles_organization_id ON public.roles(organization_id);
CREATE INDEX idx_roles_system_role ON public.roles(system_role) WHERE organization_id IS NULL;

-- Permission keys — all possible permissions in the system.
-- Naming: domain.action (e.g. orders.refund, inventory.adjust, team.manage)
CREATE TABLE public.permissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  risk_level  public.risk_level NOT NULL DEFAULT 'low',
  CONSTRAINT permissions_key_unique UNIQUE (key),
  CONSTRAINT permissions_key_format CHECK (key ~ '^[a-z_]+\.[a-z_]+$')
);

CREATE INDEX idx_permissions_key ON public.permissions(key);
CREATE INDEX idx_permissions_risk_level ON public.permissions(risk_level);

-- Role ↔ Permission mapping
CREATE TABLE public.role_permissions (
  role_id       UUID NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX idx_role_permissions_permission_id ON public.role_permissions(permission_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

-- System roles (org IS NULL) are readable by any authenticated user.
CREATE POLICY "roles_select_system"
  ON public.roles FOR SELECT
  USING (organization_id IS NULL AND auth.uid() IS NOT NULL);

-- Org-specific roles: active members of that org can read.
CREATE POLICY "roles_select_org_member"
  ON public.roles FOR SELECT
  USING (
    organization_id IS NOT NULL AND
    EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.organization_id = roles.organization_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );

-- Permissions are readable by any authenticated user.
CREATE POLICY "permissions_select_authenticated"
  ON public.permissions FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Role-permission mapping: readable by org members (or any authenticated for system roles).
CREATE POLICY "role_permissions_select_authenticated"
  ON public.role_permissions FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- All writes via service role only.
CREATE POLICY "roles_write_blocked" ON public.roles FOR INSERT WITH CHECK (false);
CREATE POLICY "roles_update_blocked" ON public.roles FOR UPDATE USING (false);
CREATE POLICY "roles_delete_blocked" ON public.roles FOR DELETE USING (false);
CREATE POLICY "permissions_write_blocked" ON public.permissions FOR INSERT WITH CHECK (false);
CREATE POLICY "role_permissions_write_blocked" ON public.role_permissions FOR INSERT WITH CHECK (false);

-- ── Seed: System permission keys ──────────────────────────────────────────────
INSERT INTO public.permissions (key, description, risk_level) VALUES
  -- Orders
  ('orders.read',           'View orders',                                    'low'),
  ('orders.create',         'Create new orders',                              'low'),
  ('orders.update',         'Update order details',                           'medium'),
  ('orders.cancel',         'Cancel orders',                                  'high'),
  ('orders.refund',         'Issue refunds',                                  'critical'),
  ('orders.export',         'Export order data',                              'high'),
  -- Inventory
  ('inventory.read',        'View stock levels',                              'low'),
  ('inventory.adjust',      'Adjust stock (movements)',                       'critical'),
  -- Products
  ('products.read',         'View products',                                  'low'),
  ('products.create',       'Create products',                                'medium'),
  ('products.update',       'Update products and prices',                     'high'),
  ('products.delete',       'Delete/archive products',                        'high'),
  -- Customers
  ('customers.read',        'View customer list and basic info',              'low'),
  ('customers.read_pii',    'View customer phone, address, and PII',          'high'),
  ('customers.create',      'Create new customers',                           'low'),
  ('customers.update',      'Update customer records',                        'medium'),
  ('customers.export',      'Export customer data',                           'critical'),
  -- Payments
  ('payments.read',         'View payment records',                           'low'),
  ('payments.confirm',      'Manually confirm payments',                      'high'),
  ('payments.override',     'Override payment status',                        'critical'),
  -- Deliveries
  ('deliveries.read',       'View delivery status',                           'low'),
  ('deliveries.create',     'Request deliveries',                             'medium'),
  ('deliveries.update',     'Update delivery details',                        'medium'),
  -- Inbox / Conversations
  ('inbox.read',            'View inbox and conversations',                   'low'),
  ('inbox.reply',           'Reply to conversations',                         'low'),
  ('inbox.assign',          'Assign conversations to team members',           'medium'),
  -- Team management
  ('team.read',             'View team members and roles',                    'low'),
  ('team.invite',           'Invite new team members',                        'high'),
  ('team.remove',           'Remove team members',                            'high'),
  ('team.roles_assign',     'Assign roles to team members',                   'critical'),
  -- Organization settings
  ('org.read',              'View organization settings',                     'low'),
  ('org.update',            'Update organization settings',                   'high'),
  -- POS
  ('pos.access',            'Access Point-of-Sale',                           'low'),
  ('pos.discount',          'Apply discounts at POS',                         'medium'),
  -- Analytics / Reports
  ('analytics.read',        'View sales analytics and reports',               'medium'),
  ('analytics.export',      'Export analytics data',                          'high')
ON CONFLICT (key) DO NOTHING;

-- ── Seed: System roles (templates) ────────────────────────────────────────────
INSERT INTO public.roles (id, organization_id, name, system_role) VALUES
  ('00000000-0000-0000-0000-000000000001', NULL, 'Owner',            'OWNER'),
  ('00000000-0000-0000-0000-000000000002', NULL, 'Manager',          'MANAGER'),
  ('00000000-0000-0000-0000-000000000003', NULL, 'Cashier',          'CASHIER'),
  ('00000000-0000-0000-0000-000000000004', NULL, 'Sales',            'SALES'),
  ('00000000-0000-0000-0000-000000000005', NULL, 'Customer Service', 'CUSTOMER_SERVICE')
ON CONFLICT DO NOTHING;

-- ── Seed: OWNER role — all permissions ────────────────────────────────────────
INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT '00000000-0000-0000-0000-000000000001', id FROM public.permissions
ON CONFLICT DO NOTHING;

-- ── Seed: MANAGER role permissions ────────────────────────────────────────────
INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT '00000000-0000-0000-0000-000000000002', p.id
  FROM public.permissions p
  WHERE p.key IN (
    'orders.read', 'orders.create', 'orders.update', 'orders.cancel', 'orders.export',
    'inventory.read', 'inventory.adjust',
    'products.read', 'products.create', 'products.update', 'products.delete',
    'customers.read', 'customers.read_pii', 'customers.create', 'customers.update', 'customers.export',
    'payments.read', 'payments.confirm',
    'deliveries.read', 'deliveries.create', 'deliveries.update',
    'inbox.read', 'inbox.reply', 'inbox.assign',
    'team.read', 'team.invite', 'team.remove',
    'org.read', 'org.update',
    'pos.access', 'pos.discount',
    'analytics.read', 'analytics.export'
  )
ON CONFLICT DO NOTHING;

-- ── Seed: CASHIER role permissions ────────────────────────────────────────────
INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT '00000000-0000-0000-0000-000000000003', p.id
  FROM public.permissions p
  WHERE p.key IN (
    'orders.read', 'orders.create', 'orders.update',
    'products.read',
    'inventory.read',
    'customers.read', 'customers.create',
    'payments.read', 'payments.confirm',
    'pos.access', 'pos.discount',
    'inbox.read'
  )
ON CONFLICT DO NOTHING;

-- ── Seed: SALES role permissions ──────────────────────────────────────────────
INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT '00000000-0000-0000-0000-000000000004', p.id
  FROM public.permissions p
  WHERE p.key IN (
    'orders.read', 'orders.create', 'orders.update',
    'products.read',
    'inventory.read',
    'customers.read', 'customers.read_pii', 'customers.create', 'customers.update',
    'payments.read',
    'deliveries.read', 'deliveries.create',
    'inbox.read', 'inbox.reply', 'inbox.assign',
    'analytics.read'
  )
ON CONFLICT DO NOTHING;

-- ── Seed: CUSTOMER_SERVICE role permissions ────────────────────────────────────
INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT '00000000-0000-0000-0000-000000000005', p.id
  FROM public.permissions p
  WHERE p.key IN (
    'orders.read', 'orders.cancel',
    'customers.read', 'customers.read_pii', 'customers.update',
    'payments.read',
    'deliveries.read', 'deliveries.update',
    'inbox.read', 'inbox.reply', 'inbox.assign'
  )
ON CONFLICT DO NOTHING;
