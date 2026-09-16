# APSA — Staging Environment Bootstrap

**Purpose of this document:** stand up APSA's dedicated **non-production** staging
environment so the controlled migration rehearsal **009 → 043** can later be run
safely, against a project that is provably not production.

This document is the *setup* runbook. `docs/STAGING_VERIFICATION.md` is the
*verification* runbook — what the tooling proves once this bootstrap is done.

It contains **no secrets** and is safe to commit.

> **This document does not apply migrations 009–043.** The rehearsal is a separate,
> explicitly approved phase. Bootstrap ends the moment `verify:staging` passes.

---

## 0. Baseline recorded at bootstrap time

| Item | Value |
|---|---|
| Repository | `laykheangma95-ops/Apsa-hub` |
| `origin/main` SHA | `8a4952a051c3af83a96b63a8383a0bc29acc35a1` |
| Migration range on disk | `001` … `043`, 41 files (numbering gaps at 028, 029 — never-created numbers, not deletions) |
| Recorded as applied to hosted Supabase | `001` … `008` (8 files, `supabase/hosted-migrations.lock.json`, last verified 2026-09-06) |
| Pending (rehearsal scope) | 33 migrations, `009` … `043` |
| Supabase projects known | one live APSA project, Seoul / `ap-northeast-2` |
| Dedicated staging Supabase project | **does not exist yet** |
| `STAGING_*` credentials | **not configured** |
| Vercel project linked to `Apsa-hub` | **none** |

---

## 1. Target architecture

Two Supabase projects. They are peers in tooling only — never in data.

| | **PRODUCTION** | **STAGING** |
|---|---|---|
| Project name | `apsa-production` (the existing Seoul project) | `apsa-staging` |
| Tenants | real merchants | QA merchants only |
| Data | real business data | fabricated QA data |
| Auth users | real owners and staff | staging-only test accounts |
| Secrets | production anon + service-role | staging anon + service-role |
| Deployment | production app | staging app |

They **must not share**: database, storage buckets, service-role key, anon key,
Auth user pool, OAuth client secrets (where a separate client is practical), or
any merchant/customer record.

The only value that legitimately crosses the boundary is the **production project
URL** — and only as a read-only *witness* used to prove staging ≠ production. A
URL is not a credential.

---

## 2. Create the staging Supabase project (owner, manual)

This step requires dashboard access and cannot be automated from this repository.

1. Supabase Dashboard → **New project**, in the **same organization** as the
   existing APSA project.
2. **Name:** `apsa-staging`
3. **Region:** `Northeast Asia (Seoul)` / `ap-northeast-2` — same as production,
   so latency and regional behaviour match.
4. **PostgreSQL version:** the **same major version** as the production project.
   Check production at *Settings → Infrastructure → Postgres version* first and
   match it. A rehearsal on a different major version does not predict the
   production rollout.
5. Set a strong database password and store it in the owner's password manager —
   never in this repository, never in a session transcript.

**Do NOT create a second APSA *production* project.** This project's sole,
explicit purpose is:

> **NON-PRODUCTION MIGRATION REHEARSAL + QA**

Consider naming it so in the project description.

### Record after creation

Fill this table in and commit it (none of these are secrets):

| Field | Value |
|---|---|
| Staging project name | `apsa-staging` |
| Staging project ref | _(to be recorded — the `<ref>` in `https://<ref>.supabase.co`)_ |
| Staging region | _(expected: `ap-northeast-2`)_ |
| Staging PostgreSQL version | _(to be recorded — must match production major)_ |
| Creation date | _(to be recorded)_ |
| Purpose | Non-production migration rehearsal + QA |
| Production project ref (witness) | _(to be recorded — identity only, no keys)_ |

---

## 3. Credentials

Four values are needed. Their names are already scaffolded in `.env.example`.

| Variable | Where it comes from | Exposure |
|---|---|---|
| `STAGING_SUPABASE_URL` | staging project → Settings → API → Project URL | not a secret |
| `STAGING_SUPABASE_ANON_KEY` | staging project → Settings → API → anon/public key | browser-safe |
| `STAGING_SUPABASE_SERVICE_ROLE_KEY` | staging project → Settings → API → service_role key | **server/CLI only** |
| `PRODUCTION_SUPABASE_URL` | production project → Settings → API → Project URL | not a secret |

Hard rules:

- **Never** use the production service-role key for staging. Not once, not "just
  to check".
- **Never** prefix a service-role key with `VITE_`. A `VITE_`-prefixed variable is
  compiled into the browser bundle by Vite; that would publish a key that bypasses
  every RLS policy APSA has.
- `PRODUCTION_SUPABASE_URL` is the *witness only*. No production key is ever set
  alongside it for staging work.

---

## 4. Local secret file

Put the real values in **`.env.staging.local`** at the repository root.

Confirm it is ignored *before* writing anything into it:

```
git check-ignore -v .env.staging.local
```

Expected output (already true on `main`):

```
.gitignore:22:.env.*.local	.env.staging.local
```

If that command prints nothing, **stop** — the file would be committable. Fix
`.gitignore` first.

Contents:

```
STAGING_SUPABASE_URL=
STAGING_SUPABASE_ANON_KEY=
STAGING_SUPABASE_SERVICE_ROLE_KEY=
PRODUCTION_SUPABASE_URL=
```

Later, once QA identities exist (§8), add `STAGING_ORG_A_ID`, `STAGING_ORG_B_ID`
and the staging test-account credentials listed in `.env.example`.

**Do not fill placeholder or fake values to make a check pass.** Both checkers
fail closed by design; a fabricated value converts an honest "not configured"
into a false pass, which is worse than being blocked.

---

## 5. Proving staging ≠ production

This is mandatory and is enforced in code, not by convention:
`evaluateProbeGate()` in `scripts/lib/staging-readiness.ts`, called by
`scripts/verify-staging.ts` before any hosted request is made.

`verify:staging` refuses to issue a single request when:

| Refusal code | Meaning |
|---|---|
| `staging_url_missing` | no staging project to probe |
| `anon_key_missing` / `service_key_missing` | credential slot empty |
| `production_witness_missing` | no production URL to compare against — "is this staging?" is unanswered |
| `staging_is_production` | staging URL and production witness normalize to the **same project** |
| `keys_identical` | the anon and service-role slots hold the same value |
| `anon_slot_privileged` | a privileged key is sitting in the anon slot (keys swapped) — would report false RLS passes |
| `service_slot_public` | a public key is sitting in the service-role slot (keys swapped) |

If the staging URL and the production witness resolve to the same project, the
correct outcome is:

> **BLOCKED — STAGING POINTS TO PRODUCTION**

and no database mutation of any kind follows. The gate is never to be bypassed,
and `--allow-write-probes` does not relax it.

---

## 6. Staging Auth configuration

Configure the **staging project's** Auth independently of production
(Dashboard → Authentication).

| Setting | Staging value |
|---|---|
| Email/password provider | enabled |
| Confirm email | enabled — staging accounts must be verifiable the same way production ones are |
| Site URL | `http://localhost:3000` initially; the dedicated APSA staging domain once it exists |
| Additional redirect URLs | `http://localhost:3000/**`, plus the staging domain |
| Password policy | match production's minimum length and strength |
| JWT expiry / refresh rotation | match production, so session-expiry behaviour rehearses truthfully |

**Do not** set the production application domain as the staging Site URL. A
staging auth link that redirects into production is a live cross-environment
leak, not a convenience.

---

## 7. Google OAuth — FOLLOW-UP, not a blocker

Google login is **not** exercised by the migration rehearsal, which is database
and RLS work. Treat it as follow-up:

- Do **not** modify the production Google OAuth client during this phase.
- When staging Google login is needed, create a **separate** OAuth client with
  staging redirect URIs only (`https://<staging-ref>.supabase.co/auth/v1/callback`
  and the staging app domain).

Status for this bootstrap: **FOLLOW-UP — deferred, not blocking.**

---

## 8. QA identities

Create these in the staging project **only after** the baseline schema is applied
(§10), since organizations and memberships are what migrations `002`–`006` define.

**Organization A — `QA-STAGING Shop A`**

| Role | Purpose | Env slot |
|---|---|---|
| Owner | full-permission baseline | `STAGING_OWNER_A_EMAIL` / `_PASSWORD` |
| Manager | elevated but not owner | `STAGING_MANAGER_A_EMAIL` / `_PASSWORD` |
| Cashier / staff | least-privilege; proves permission gates deny | `STAGING_STAFF_A_EMAIL` / `_PASSWORD` |

**Organization B — `QA-STAGING Shop B`**

| Role | Purpose | Env slot |
|---|---|---|
| Owner | the cross-tenant counterparty; must never see Org A data | `STAGING_OWNER_B_EMAIL` / `_PASSWORD` |

Rules:

- Organizations A and B share **no** membership. That is the whole point — tenant
  isolation is proven against two genuinely separate tenants with real UUIDs.
- Use staging-only email addresses (e.g. a dedicated QA mailbox or plus-addressing).
  Never a real merchant's address.
- All four accounts must have **verified** emails.
- Record the two organization UUIDs into `STAGING_ORG_A_ID` and `STAGING_ORG_B_ID`
  in `.env.staging.local`.

---

## 9. QA data policy

**Allowed in staging**

- `QA-STAGING Shop A`, `QA-STAGING Shop B` and similar clearly-prefixed businesses
- Fabricated customers (e.g. `QA-STAGING Customer Dara`)
- Reserved/fake phone numbers and invented addresses
- Fabricated products, inventory movements, orders, payments, conversations

**Never in staging**

- Real APSA merchant records
- Real customer names, phone numbers, or addresses
- Production order exports or payment records
- Any production database dump, snapshot, or PITR restore into staging

Every QA business name carries the literal prefix `QA-STAGING` so that a row in
the wrong place is visible at a glance.

---

## 10. Starting database state for the rehearsal

The staging database starts **empty** — no production clone, no PII import.

The goal of staging is **not** "make staging reach 043". It is to prove APSA can
move from *the state production is actually in today* to 043. Staging must
therefore reproduce the production baseline before the pending sequence runs.

Production is recorded at migrations `001`–`008` in
`supabase/hosted-migrations.lock.json`. For a fresh project the two candidate
approaches collapse into one:

**Chosen approach: apply `001`–`008` exactly as they exist in this checkout, verify,
then rehearse `009` → `043` as a separate approved phase.**

Rationale:

- `check:migration-safety` hash-pins `001`–`008` against the lock file, so
  "the files in this checkout" and "what production ran" are the *same bytes*,
  content-verified rather than assumed.
- The rehearsal then executes the identical 33-migration sequence that production
  will later execute, from the identical starting schema — which is the only
  arrangement that actually predicts the production rollout.
- A cloned production baseline would add PII risk without adding schema fidelity.

Order of operations:

1. Apply `001`–`008` to staging, in numeric order.
2. Verify: `bun run check:staging-readiness --require-staging-env` and
   `bun run verify:staging` both pass.
3. Create QA identities (§8).
4. **Stop.** The `009` → `043` rehearsal is a separate, explicitly approved phase.

---

## 11. Backup / lifecycle policy

**Declared policy for this staging project: DISPOSABLE.**

- Staging holds no data that cannot be recreated: schema comes from
  version-controlled migrations, and every row is fabricated QA data.
- Reset, rebuild-from-scratch, or full project re-creation is acceptable at any
  time and requires no approval.
- A failed `009` → `043` rehearsal is therefore recoverable by rebuilding, which
  is exactly what makes the rehearsal safe to attempt.
- No backup configuration is required before the first rehearsal.

If staging is later promoted to **persistent QA** — for example because it holds
long-lived QA fixtures the team relies on — that decision must be recorded here
and backup capability confirmed **before** the next destructive rehearsal.

---

## 12. Vercel / staging deployment

There is currently **no Vercel project linked to `laykheangma95-ops/Apsa-hub`**.
(The account holds `travel-app`, `apsara`, `domner-official`, `domner-copilot`,
`domner-copilot-new` — none linked to this repository. The Domner projects are a
separate application and must stay entirely separate from APSA.)

A staging deployment is **not required** for the database bootstrap, and deploying
after the database work is the safer order. When it is wanted:

1. Vercel → **Add New Project** → import `laykheangma95-ops/Apsa-hub`.
2. Name it `apsa-staging`. Set the production branch to a staging branch, **not**
   `main`, so a staging deploy can never become the production deploy.
3. Environment variables (Preview + the staging environment only):
   - `VITE_SUPABASE_URL` → the **staging** project URL
   - `VITE_SUPABASE_ANON_KEY` → the **staging** anon key
   - `VITE_APP_URL` → the staging domain
   - `VITE_KHR_PER_USD` → staging rate
   - `SUPABASE_SERVICE_ROLE_KEY` → the **staging** service-role key, server-side
     scope only, never a `VITE_` name
   - Do **not** set `NODE_ENV=development` in any deploy environment.
4. No production value is ever entered into the staging project, and no staging
   value into a production project.

**Do not deploy production as part of this bootstrap.**

---

## 13. The safety gate

Once credentials are in `.env.staging.local`:

```
bun run check:staging-readiness --require-staging-env
bun run verify:staging
```

Expected on success:

- staging URL, anon key and service-role key all present
- production witness present
- staging ≠ production proven
- credential slots hold the roles they claim (no swapped keys)
- no production safety violation reported

Both are fail-closed. `NOT CONFIGURED` is never counted as a pass, and a `FAIL` is
never downgraded to a skip. **Do not bypass the gate** — not with fabricated
values, not with `--allow-write-probes`, not by editing the gate.

---

## 14. Definition of done

Bootstrap is complete only when **all** of the following hold:

1. Dedicated `apsa-staging` Supabase project exists
2. Staging identity (ref, region, Postgres version, creation date) recorded in §2
3. Production identity recorded separately, as a witness only
4. staging ≠ production proven by `evaluateProbeGate()`, not by assertion
5. `STAGING_*` configuration present in `.env.staging.local`
6. That file confirmed git-ignored; no secret committed
7. Staging Auth configured per §6
8. No production PII copied into staging
9. Backup/disposable policy declared (§11 — currently **DISPOSABLE**)
10. `bun run check:staging-readiness --require-staging-env` passes
11. `bun run verify:staging` passes
12. No migration beyond the approved `001`–`008` baseline has been applied

Then, and only then, the `009` → `043` rehearsal may be requested as a separate
controlled phase.
