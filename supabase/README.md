# APSA — Supabase Migrations

This directory contains APSA's database migrations.
APSA uses its own dedicated Supabase project — never shared with Domner.

## Migration Order

| File | Purpose |
|---|---|
| `001_auth_profiles.sql` | User profiles extending Supabase Auth |
| `002_organizations.sql` | Root tenant entity |
| `003_workspaces.sql` | Logical grouping within an org (INBOX / BUSINESS) |
| `004_locations.sql` | Physical/virtual locations |
| `005_memberships.sql` | User ↔ Organization membership + roles |
| `006_roles_permissions.sql` | RBAC: roles, permission keys, seed data |
| `007_audit_logs.sql` | Append-only audit log (immutable by trigger) |

## Setup Steps (Project Owner)

1. Create a new Supabase project at https://supabase.com
   - Name: APSA (or your preferred name)
   - Region: closest to Cambodia (Singapore `ap-southeast-1`)
   - Password: use a strong password, save it somewhere safe

2. Copy `.env.example` to `.env.local` and fill in:
   - `VITE_SUPABASE_URL` — from Supabase Dashboard → Project Settings → API → Project URL
   - `VITE_SUPABASE_ANON_KEY` — from Project Settings → API → Project API keys → anon/public
   - `SUPABASE_SERVICE_ROLE_KEY` — from Project Settings → API → Project API keys → service_role (secret)
   - `SUPABASE_JWT_SECRET` — from Project Settings → API → JWT Settings → JWT Secret

3. Install Supabase CLI: `npm install -g supabase`

4. Link the project: `supabase link --project-ref <your-project-ref>`

5. Apply migrations: `supabase db push`
   OR run them in order via Supabase Dashboard → SQL Editor

6. Regenerate TypeScript types:
   `supabase gen types typescript --local > src/lib/supabase/types.ts`
   (This replaces the hand-authored types.ts)

7. Enable Row-Level Security: migrations already apply RLS — verify in
   Supabase Dashboard → Authentication → Policies

## Security Notes

- `SUPABASE_SERVICE_ROLE_KEY` is NEVER committed to git
- `SUPABASE_SERVICE_ROLE_KEY` is NEVER exposed via VITE_ prefix (browser)
- All RLS policies are version-controlled in these migration files
- The audit_logs table has a trigger preventing UPDATE and DELETE
