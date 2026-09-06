# APSA — GitHub Engineering Governance Policy

**Status:** Active
**Applies to:** this repository (`Apsa-hub`) only
**Relationship to CLAUDE.md:** this document implements CLAUDE.md's "Completion Gate"
and "Git / Repo Safety" sections in concrete GitHub mechanics. Where they conflict,
`CORRECTIONS.md` → `CLAUDE.md` still wins; this document should never contradict them.

---

## 1. The four things this repo must keep visibly separate

A PR moving through this repo passes through four _independent_ verification
layers. Each one answers a different question, is performed by a different
actor, and passing one implies **nothing** about the others.

| #   | Layer                           | Question it answers                                                                                                                                                                                                                         | Who/what performs it                                                                         | Where it's recorded                                                     |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | **Automated CI verification**   | Does the code compile, build, and pass its automated tests?                                                                                                                                                                                 | GitHub Actions (`.github/workflows/ci.yml`)                                                  | Check runs on the PR                                                    |
| 2   | **Independent code review**     | Is the change _semantically_ correct — tenant isolation intact, money handled as integer minor units, no floating-point finance, no client-trusted `organization_id`, auth/authorization actually enforced server-side, no secrets exposed? | A human, or a separate AI reviewer session (Claude/Codex) that did not write the code        | A review record comment on the PR (§5)                                  |
| 3   | **Hosted/staging verification** | Does the change actually work once deployed to a real, running environment (and, for migrations, once actually applied to a real Postgres instance)?                                                                                        | A human, running the deployed app / running the migration against a staging Supabase project | PR description "Staging status" field                                   |
| 4   | **Production verification**     | Does the change work correctly for real users against production data, after merge and deploy?                                                                                                                                              | A human, post-deploy                                                                         | PR description "Production status" field, and/or `APSA_BUILD_STATUS.md` |

The load-bearing rule:

> **CI VERIFIED ≠ REVIEWED. REVIEWED ≠ MERGED. MERGED ≠ STAGING VERIFIED. STAGING VERIFIED ≠ PRODUCTION VERIFIED.**

Concretely, this means:

- A PR with all green checks can still contain a tenant-isolation bug, a floating-point
  money calculation, or a SECURITY DEFINER function that leaks PUBLIC execute — CI does
  not read the diff for intent, it only runs fixed mechanical checks.
- A PR that passed independent review at commit `abc123` and then received a new commit
  `def456` has **no valid review** until `def456` is reviewed. Re-review is not optional
  busywork; it is the entire point of tying a review to a SHA (§5).
- `main` having a PR merged into it does not mean that code is running anywhere real.
  APSA migrations in particular are frequently written, reviewed, and merged well before
  they are applied to the live Supabase project — `APSA_BUILD_STATUS.md` and
  `supabase/hosted-migrations.lock.json` are the source of truth for what is actually
  hosted, not the state of `main`.
- Staging behaving correctly does not guarantee production does: different data volume,
  different real customer data shapes, different provider webhook traffic.

## 2. APSA PR lifecycle

Every PR description must state one of these stages, and update it as the PR
progresses (see `.github/pull_request_template.md`):

```
IMPLEMENTING
  → CODE COMPLETE
  → REVIEW PASSED
  → PR CREATED
  → READY TO MERGE
  → MERGED
  → STAGING VERIFIED
  → PRODUCTION VERIFIED
```

Notes:

- `REVIEW PASSED` requires a review record (§5) at the PR's current commit SHA — not
  merely green CI.
- `READY TO MERGE` requires: CI green, review record valid for the current SHA, no
  unresolved reviewer comments, and (per §7) whatever branch protection rules are
  configured on `main`.
- `MERGED` is a GitHub fact, not a claim — it means the PR's commits are in `main`.
- `STAGING VERIFIED` / `PRODUCTION VERIFIED` must name what was actually checked (a
  smoke test, a specific manual flow, a migration verification query from
  `supabase/verify-migrations.sql`), not just "looks fine".

## 3. Automated CI (`.github/workflows/ci.yml`)

Jobs, and what each one is (and isn't) proof of:

| Job                | Blocking?                               | What it proves                                                                                                                                                                                                                                                                                                   |
| ------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typecheck`        | Yes                                     | `tsc --noEmit` is clean                                                                                                                                                                                                                                                                                          |
| `build`            | Yes                                     | `vite build` / Nitro build succeeds — also produces `.output` for the bundle-boundary scan                                                                                                                                                                                                                       |
| `lint-changed`     | Yes                                     | ESLint is clean on the files this PR actually touches                                                                                                                                                                                                                                                            |
| `lint-baseline`    | **No** (informational)                  | Whole-repo lint status — see §4 for why                                                                                                                                                                                                                                                                          |
| `test`             | Yes (with one documented exception, §4) | `bun test src/tests/` passes — this includes the domain test suites (order, product, inventory, payment, conversation, delivery, customer), `tenant-isolation.test.ts`, `rpc-security.test.ts`, `bundle-boundary.test.ts` (server/client boundary + built-bundle secret scan), and the Khmer/localization suites |
| `migration-safety` | Yes                                     | See §4 (Migration Safety Check)                                                                                                                                                                                                                                                                                  |
| `secret-scan`      | Yes                                     | Gitleaks finds no committed secrets in the diff                                                                                                                                                                                                                                                                  |

None of these jobs read the code for _intent_. A test suite only catches what
someone thought to write a test for; `tenant-isolation.test.ts` and
`rpc-security.test.ts` are strong signals precisely because they were written
to encode APSA's specific non-negotiables (SECURITY.md), but a new attack
surface added by a PR has, by definition, no pre-existing test. That gap is
exactly what independent review (§5) exists to cover.

## 4. Known, documented baseline exceptions

Per this governance phase's instructions, CI must not become a permanently
failing gate over pre-existing, out-of-scope issues. Two are known today:

1. **Whole-repo `bun run lint`**: currently reports ~400 pre-existing
   prettier/formatting errors across files this governance change does not
   touch (confirmed independently in PR #32's own verification table: "395
   errors / 12 warnings — not worse than main"). Fixing this repo-wide is a
   dedicated cleanup PR, not a side effect of unrelated work. `lint-baseline`
   runs it as `continue-on-error: true` so the trend is visible without
   blocking every PR; `lint-changed` is the actual blocking gate and lints
   only files touched by the PR's diff.
2. **`src/tests/auth-hardening.test.ts`**: its "runs isolated runtime checks
   without mutating the shared test module cache" test spawns a subprocess
   and times out (~5s) on a clean checkout, independent of any feature
   change — also independently confirmed in PR #32. The `test` CI job
   excludes it from the blocking run via `--test-name-pattern` and re-runs it
   separately as `continue-on-error: true`, so a real new failure elsewhere in
   the 1140+ other tests is never masked by this pre-existing flake.

If either of these is ever fixed, remove the corresponding carve-out from
`.github/workflows/ci.yml` in the same PR that fixes it — do not leave stale
exceptions in place.

A third one was found _by_ building the migration-safety check below, and is
now resolved — kept here as a record of what the checker is for:

3. **RESOLVED (2026-09-06).** `supabase/migrations/030_order_conversation_source.sql`
   previously defined a second, 8-argument overload of `public.create_order_v1`
   (alongside migration 024's 7-argument version) and then did
   `COMMENT ON FUNCTION public.create_order_v1 IS ...` with no argument list —
   ambiguous once both overloads exist, and would have failed migration
   application on a fresh database. This governance PR flagged it as a
   `[baseline]` warning (not blocking, since a governance-only PR must not
   modify feature code/migrations) and left it unfixed pending a follow-up.
   PR #32 independently fixed the identical bug pattern on its own branch and
   has since merged into `main`, which — per its description — included
   qualifying this exact `COMMENT ON FUNCTION` with the full signature and
   adding an explicit `REVOKE`/`GRANT EXECUTE`. After rebasing this branch
   onto the post-#32 `main`, `scripts/check-migration-safety.ts` confirms
   check 4 (ambiguous overloaded function references) reports **zero**
   findings — see §4a.

### 4a. Rebase-onto-main follow-ups (2026-09-06)

After PR #32 merged, this branch was rebased onto the new `main` and every
check re-run. Two issues surfaced that were specific to this governance PR's
own new files/workflow, not to the rebase or to feature code — both fixed in
the same push:

- **`secret-scan` false positive**: Gitleaks' default `generic-api-key` rule
  flagged the sha256 digest stored for `001_auth_profiles.sql` in
  `supabase/hosted-migrations.lock.json` (line 7) — a 64-hex-char content hash
  has the same entropy shape as an API key. Confirmed as a false positive (it
  is a hash of already-public migration SQL, not a credential) by running
  Gitleaks locally against the exact failing commit. Fixed by adding
  `.gitleaks.toml`, which extends (not replaces) the default ruleset and adds
  a single path-based allowlist entry for that one generated lock file —
  every other file, including any future edit to the lock file's structure,
  is still scanned normally.
- **`test` job workflow bug**: the `build` job's `actions/upload-artifact@v4`
  step uploaded the `.output` directory with `include-hidden-files` left at
  its default (`false`). Since `.output` is itself a dot-prefixed directory,
  upload-artifact silently uploaded zero files ("No files were found with the
  provided path: .output"), which then made the `test` job's
  `actions/download-artifact@v4` step fail outright ("Artifact not found").
  Fixed by adding `include-hidden-files: true` to the upload step. This was a
  bug in this PR's own `ci.yml`, not caused by the rebase or by anything in
  PR #32 — surfaced only once the workflow actually ran on GitHub, since a
  local `bun run build` doesn't go through `actions/upload-artifact` at all.

## 5. Independent review gate and review record

**Green CI is not independent semantic review.** Before a PR may be marked
`READY TO MERGE`, it requires a review from someone (or some AI session) other
than whoever wrote the change, recorded as a comment on the PR itself, in this
format:

```
## APSA Independent Review

- Reviewer: <name or "Claude" / "Codex" + session identifier>
- Reviewed commit SHA: <full 40-char SHA>
- Result: BLOCK | READY TO MERGE
- Blockers: <list, or "None">
- Residual risks: <list, or "None">
- Timestamp: <ISO 8601>
- Hosted migration status: <e.g. "No migrations in this PR" / "Migrations NOT applied to hosted Supabase — project-owner action required">
```

Rules:

- **A review is valid only for the exact commit SHA it names.** Any new commit
  pushed to the branch makes the prior review stale. Do not carry a stale
  approval forward — repeat the review against the new SHA.
- `BLOCK` means exactly that — it is not a suggestion. The blockers must be
  resolved (or explicitly and separately overridden by the project owner) before
  `READY TO MERGE`.
- This is separate from, and in addition to, GitHub's own PR review feature
  (§7). Where GitHub review is available from a second human collaborator, use
  it too — this record format exists specifically to cover the case where the
  only available "second opinion" is an AI review session rather than a GitHub
  collaborator.

## 6. CODEOWNERS

`.github/CODEOWNERS` is checked in and assigns critical paths (auth/security
migrations, all of `supabase/`, payments, orders, conversations,
`.github/`/deployment config) to `@laykheangma95-ops`, the repository's sole
collaborator.

**Important limitation, stated plainly**: with exactly one collaborator, GitHub
CODEOWNERS cannot force a _second person_ to review before merge — there is no
second person. Enabling "Require review from Code Owners" in branch protection
today would only require the repo owner to approve their own PR, which GitHub
technically permits and which provides no independent check. Until a second
collaborator with write access joins this repository:

- CODEOWNERS still documents which paths are considered critical (useful on
  its own, and it activates the moment a second collaborator exists).
- "Independent review" in practice means the AI review record in §5, performed
  by a separate Claude/Codex session that did not author the change — not a
  second GitHub approval.
- Do not paper over this by adding a placeholder team or a second account that
  isn't a real, actively-used collaborator.

## 7. Branch protection / rulesets for `main`

These require repository admin access and are **not** committed as config
files — GitHub does not support defining branch protection as a file in most
plans used here, and CLAUDE.md/this task both prohibit inventing config that
can't actually take effect. Apply these manually:

**GitHub UI path:** repository → _Settings_ → _Branches_ → _Add branch protection rule_
(or _Settings_ → _Rules_ → _Rulesets_ → _New branch ruleset_, if using the newer
Rulesets UI) → target `main`.

Recommended settings:

- [ ] **Require a pull request before merging** — blocks direct pushes to `main`.
- [ ] **Require approvals** — set to 1. (See §6's limitation: today this can
      only be satisfied by the repo owner's own approval; it still blocks
      merging _without any_ review click, which has value, and becomes a real
      gate the moment a second collaborator joins.)
- [ ] **Dismiss stale pull request approvals when new commits are pushed** —
      enable this. It is the GitHub-native enforcement of §5's "a review is only
      valid for the SHA it names" rule.
- [ ] **Require status checks to pass before merging** — enable, and select:
      `Typecheck`, `Production build`, `Lint (changed files) — blocking`,
      `Test suite (bun test src/tests/)`, `Migration safety check`, `Secret leak scan`.
      Do **not** select `Lint (whole repo) — informational, non-blocking` (§4).
- [ ] **Require branches to be up to date before merging** — enable if the team
      is small enough that this doesn't become a bottleneck; recommended given
      the migration-number-collision risk (§8) of two branches both claiming the
      next migration number.
- [ ] **Require Code Owners review** — optional today given §6's limitation;
      turning it on now costs nothing (self-approval already satisfies "1
      approval" above) but revisit once a second collaborator exists.
- [ ] **Block force pushes** — enable.
- [ ] **Restrict who can push to matching branches** — enable, allow no one
      (all changes go through PRs).

None of the above has been changed by this PR. This section is a checklist
for the project owner to apply by hand in GitHub's settings.

## 8. Migration safety

`scripts/check-migration-safety.ts` (run in CI as the `migration-safety` job,
and runnable locally: `bun run scripts/check-migration-safety.ts`) performs
static checks only:

1. **Duplicate/colliding migration numbers** — always blocking.
2. **Modification of a migration already recorded as hosted/applied** in
   `supabase/hosted-migrations.lock.json` — always blocking. That file locks
   the sha256 of every migration `APSA_BUILD_STATUS.md` records as applied to
   the live Supabase project (currently `001`–`008`). If a bug is found in one
   of those files, the fix is a **new** migration, never an edit to the old one.
3. **SECURITY DEFINER functions with no explicit `REVOKE ... FROM PUBLIC/anon`**
   in the same file — blocking for any migration file new or modified in the
   current PR (diffed against `origin/main`), warning-only for the
   pre-existing baseline (§4 lists what that baseline currently contains).
4. **Ambiguous references to overloaded function names** (a `COMMENT ON
FUNCTION` / `GRANT` / `REVOKE` naming a function with no argument list when
   more than one signature exists) — same enforcement split as #3.

**This is static analysis of SQL text. It proves nothing about a live
Supabase project** — not that RLS is actually enabled, not that a policy
behaves as its name suggests, not that a trigger fires correctly under
concurrency. Live verification is what `supabase/verify-migrations.sql` and
manual staging checks are for (§1, layer 3). Do not treat a clean
`migration-safety` run as evidence a migration is safe to apply to production.

## 9. Security checks beyond migrations

- **Secret scanning**: `secret-scan` CI job runs [Gitleaks](https://github.com/gitleaks/gitleaks)
  (open-source, no paid service) against the PR diff. `.gitleaks.toml` extends
  the default ruleset with one path allowlist entry for
  `supabase/hosted-migrations.lock.json` (§4a) — do not add further entries to
  it without the same standard of proof (reproduce the finding locally,
  confirm it is not a real secret) that entry required.
- **Server-only code entering the client bundle**: `src/tests/bundle-boundary.test.ts`,
  run in the `test` CI job against the real `.output` produced by the `build`
  job, checks for `supabaseAdmin` / `SUPABASE_SERVICE_ROLE_KEY` reachable from
  browser-side code, both at the source level (static imports) and by scanning
  the actual built client bundle.
- **Unsafe RPC grants**: covered by `migration-safety` (#3 above) and by
  `src/tests/rpc-security.test.ts`.
- **Tenant isolation regressions**: `src/tests/tenant-isolation.test.ts`
  exercises the authorization service and DB triggers directly (cross-org
  read/write attempts, guessed IDs, suspended/removed memberships, last-owner
  protection). Its live-DB tests currently skip in CI (no `VITE_SUPABASE_URL`
  / `SUPABASE_SERVICE_ROLE_KEY` configured as CI secrets) — only its unit
  tests (U1–U3) run today. Wiring a dedicated test Supabase project's
  credentials into CI secrets to unskip the live tests is a good follow-up,
  out of scope for this governance phase (it is infrastructure provisioning,
  not a GitHub/CI mechanics change).

## 10. What this governance phase deliberately did not do

- Did not modify any feature code, `src/`, or existing migrations.
- Did not touch PR #32.
- Did not merge anything.
- Did not change any GitHub admin/repository setting (branch protection,
  required reviewers, rulesets) — §7 lists the exact manual steps for the
  project owner instead.
- Did not fix the pre-existing lint baseline, the `auth-hardening.test.ts`
  timeout, or the migration 030 ambiguous-overload bug (§4) — all three are
  named explicitly so they are tracked, not hidden.
