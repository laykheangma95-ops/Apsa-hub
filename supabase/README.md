# APSA — Supabase Migrations

This directory contains APSA's database migrations.
APSA uses its own dedicated Supabase project — never shared with Domner or any other application.

**Do NOT create a new Supabase project.** APSA already has its own project in **Seoul (ap-northeast-2)**.  
GitHub: `laykheangma95-ops/Apsa-hub` | Production branch: `main`

---

## Migration Order

Migrations must be applied in **this exact sequence** on a fresh project.
Each migration is self-contained and has no forward references.

| # | File | Purpose | Depends on |
|---|------|---------|------------|
| 1 | `001_auth_profiles.sql` | User profiles extending Supabase Auth; `update_updated_at_column` function | `auth.users` (always present) |
| 2 | `002_organizations.sql` | Root tenant entity; slug-unique constraint | `auth.users` |
| 3 | `003_roles_permissions.sql` | RBAC roles, 37 permission keys, system role seed data | `002_organizations` |
| 4 | `004_workspaces.sql` | Logical workspace groupings (INBOX/BUSINESS) | `002_organizations` |
| 5 | `005_locations.sql` | Branch/warehouse/virtual locations; cross-org workspace trigger | `002_organizations`, `004_workspaces` |
| 6 | `006_memberships.sql` | User↔Org membership + role; cross-org role trigger; last-owner trigger | `001_profiles`, `002_organizations`, `003_roles` |
| 7 | `007_rls_deferred_member_policies.sql` | Adds membership-based SELECT RLS to orgs/workspaces/locations/roles/role_permissions | `006_memberships` |
| 8 | `008_audit_logs.sql` | Append-only audit log; org.read-gated SELECT RLS | `002_organizations`, `001_profiles`, `007_rls_deferred` |

**Why the split?** Migrations 002–005 create tables whose SELECT RLS policies reference the
`memberships` table. Since `memberships` doesn't exist until migration 006, those policies
cannot be added inline. Migration 007 adds them after `memberships` exists.

---

## Setup Steps (Project Owner)

1. **Open APSA's existing Supabase project** — Seoul region, `laykheangma95-ops/Apsa-hub`.
   Do NOT create a new project.

2. **Copy `.env.example` to `.env.local`** and fill in:
   - `VITE_SUPABASE_URL` — Dashboard → Project Settings → API → Project URL
   - `VITE_SUPABASE_ANON_KEY` — Project Settings → API → anon/public key
   - `SUPABASE_SERVICE_ROLE_KEY` — Project Settings → API → service_role key (keep server-side only)

   **Note:** `SUPABASE_JWT_SECRET` is NOT required. Session validation uses
   `supabase.auth.getUser()` via the Supabase SDK, which does not need the raw JWT secret.

3. **Install Supabase CLI**: `npm install -g supabase`

4. **Link the project**: `supabase link --project-ref <your-project-ref>`

5. **Apply migrations in order**:
   ```
   supabase db push
   ```
   Or run them via Supabase Dashboard → SQL Editor, one file at a time, in numbered order.

6. **Regenerate TypeScript types** after migrations are applied:
   ```
   supabase gen types typescript --local > src/lib/supabase/types.ts
   ```
   The current `src/lib/supabase/types.ts` is hand-authored scaffolding.
   **Replace it with generated types** once migrations are live against the real APSA project.
   Hand-authored types are temporary and will drift from the actual schema.

7. **Verify RLS** in Supabase Dashboard → Authentication → Policies.
   Every table should show active policies.

---

## Security Notes

- `SUPABASE_SERVICE_ROLE_KEY` is NEVER committed to git
- `SUPABASE_SERVICE_ROLE_KEY` is NEVER exposed via a `VITE_` prefix (browser)
- All RLS policies are version-controlled in these migration files
- The `audit_logs` table has triggers preventing UPDATE and DELETE (append-only)
- The `memberships` table has a trigger enforcing last-owner protection
- The `locations` table has a trigger enforcing cross-tenant workspace integrity
- The `memberships` table has a trigger enforcing cross-tenant role integrity

---

## Integration Tests

The integration test suite (`src/tests/tenant-isolation.test.ts`) reads the same environment
variables used by the server client. To run live DB tests, configure a **dedicated APSA
test/staging Supabase project** — never the production project — and set:

```
VITE_SUPABASE_URL=https://<your-test-project>.supabase.co
VITE_SUPABASE_ANON_KEY=<test-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<test-service-role-key>
```

Store these in `.env.test.local` (never committed). Then run:

```
bun test src/tests/tenant-isolation.test.ts
```

**Important:**
- Use a dedicated test/staging Supabase project, not the production project.
- Apply the same migrations (001–008) to the test project before running tests.
- Never run destructive or security integration tests against production data.
- When the environment variables are absent, unit tests (U1–U3) still run; DB-dependent
  tests are skipped automatically with a clear `[SKIP]` warning.

---

## Reverting Migrations

Each migration file includes rollback instructions in the header comment.
Apply rollbacks in **reverse order** (008 → 007 → 006 → ... → 001).
