# APSA — Backup, Restore & Rollback Readiness

**Status: NOT VERIFIED.** Nothing in this document has been exercised against a
hosted project. No backup has been taken, inspected or restored as part of this
repository's work. Treat every box below as open until someone records evidence
next to it. Contains no secrets. Safe to commit.

Staging is declared **disposable** (docs/STAGING_BOOTSTRAP.md §11): it needs no
backup to be safe. This document is about the project that will hold **real
merchant data** (Internal Alpha onward), and about proving the restore procedure
on a disposable copy first.

---

## 1. Ownership

| Role | Who | Responsibility |
|---|---|---|
| Recovery owner | Project owner | Decides to restore / roll back; approves any production data operation |
| Operator | Engineer on call | Executes the documented steps; records evidence |
| Reviewer | Second person | Confirms restored data before traffic returns |

No automated process may restore or roll back production data without the
recovery owner's explicit approval.

## 2. What must be true before real merchant data exists

Record the date, who checked, and the evidence (dashboard screenshot link or
CLI output with project ref redacted) for each:

- [ ] **Backups enabled** on the production Supabase project, and the plan's
      retention period is known and written here: `____ days`.
- [ ] **Point-in-time recovery (PITR)** — enabled, or an explicit owner decision
      recorded here that daily backups are acceptable for Alpha (with the
      resulting maximum data loss: `____ hours`).
- [ ] **A backup is listed** in the dashboard with a timestamp after the latest
      migration was applied.
- [ ] **Restore drill completed** into a DISPOSABLE project (§3), with the
      checks in §3.4 passing. Date: `____`. Operator: `____`.
- [ ] **Recovery time measured** in that drill: `____ minutes` from decision to
      verified restored project.
- [ ] **Storage objects** (payment evidence, product images, if any bucket is in
      use) — backup coverage confirmed or recorded as a known gap.
- [ ] **Auth users** are included in the restore (Supabase restores the whole
      database, including the `auth` schema) — confirmed in the drill.
- [ ] **Secrets are not in the backup plan**: service keys, provider tokens are
      rotated from their own source, not restored from a dump.

Until every box is ticked, the launch-readiness status for backups is
**REQUIRES STAGING PROOF** (APSA_BUILD_STATUS.md).

## 3. Restore drill (disposable project only)

Never restore INTO production as a drill. Never download production data to a
laptop for a drill.

1. **Create a disposable project** (same region, same Postgres major version).
   Name it `apsa-restore-drill-YYYYMMDD`.
2. **Restore** the chosen backup into it using the Supabase dashboard's restore to
   a new project (or `pg_dump`/`pg_restore` of a *staging* database when drilling
   the procedure only). Record the backup timestamp used.
3. **Point tooling at it** as if it were staging:
   `STAGING_SUPABASE_URL` / `STAGING_SUPABASE_ANON_KEY` /
   `STAGING_SUPABASE_SERVICE_ROLE_KEY` = the drill project; production witness =
   the real production URL (so the tools' safety gate proves it is not production).
4. **Verify** — all must pass:
   1. `bun run verify:readiness` → `EXPECTED` = `HOSTED`, every called RPC present,
      `apsa_schema_level() = 45`.
   2. `bun run verify:staging` → RLS / unauthenticated-RPC / tenant checks pass.
   3. Row counts for `organizations`, `memberships`, `orders`, `payments`,
      `inventory_movements`, `audit_logs` match the source at the backup
      timestamp (counts only — never export rows).
   4. Money invariants: for a sample of orders, `total_minor` = subtotal −
      discount + delivery; `order_payment_totals` agree with payment events.
   5. Inventory invariant: stock per variant = sum of movements (no drift).
   6. A QA member can sign in to a deployment pointed at the drill project.
5. **Delete the disposable project** after recording results. It holds real data.

## 4. Rollback decision points

| Situation | First action | Data restore? |
|---|---|---|
| Bad application deploy (errors spike, feature broken) | Roll back to the previous deployment in the hosting dashboard | **No** — application rollback only |
| Bad migration, caught before real traffic | Stop; write a forward-fix migration; re-verify on staging | No |
| Bad migration, after real traffic | Owner decision. Prefer a **forward-fix migration**; a restore loses every order/payment since the backup | Only with owner approval, after quantifying lost writes |
| Accidental data deletion / corruption in one tenant | Contain (stop the screen / feature), quantify from `audit_logs` and history tables | PITR restore to a **separate** project and targeted repair via the application, not a whole-database restore |
| Suspected compromise | Rotate secrets, revoke sessions (docs/INCIDENT_RUNBOOK.md §8) | Only if integrity loss is proven |

Rules:

- A whole-database restore **rewinds every tenant**. It is the last resort.
- Money and stock are repaired through the application (reversal, refund,
  correction, manual adjustment — all audited), never by editing rows.
- Migrations are never "rolled back" by editing a hosted migration file; hosted
  migrations are immutable (`supabase/hosted-migrations.lock.json`).

## 5. What this repository can and cannot prove

| Claim | Provable from the repo? |
|---|---|
| Schema can be rebuilt from migrations | Yes — all migrations run in order through PGlite in CI tests |
| Backups exist / retention / PITR | **No** — dashboard evidence only |
| A restore works and is complete | **No** — only the drill in §3 proves it |
| Recovery time | **No** — measured in the drill |
