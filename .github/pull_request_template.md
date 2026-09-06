<!--
APSA PR template. Fill in every section — do not delete sections you find
inconvenient. See docs/GITHUB_GOVERNANCE.md for what each gate means and why
"green CI" is not the same thing as "reviewed", "merged", "staging verified"
or "production verified".
-->

## Domain / feature

<!-- e.g. Orders, Inventory, Conversations, Auth, Payments, Delivery, CI/governance -->

## Branch

<!-- head branch name -->

## Commit SHA

<!-- the exact commit this PR is being reviewed at. Update this field on every push —
     a review recorded against an older SHA is stale (see docs/GITHUB_GOVERNANCE.md §5). -->

## Files changed

<!-- short summary, not a full diff dump: which files/areas, and why -->

## Migrations added / modified

<!-- list migration filenames, or "None". If modifying a migration already listed in
     supabase/hosted-migrations.lock.json, stop — hosted migrations are immutable;
     write a new migration instead. -->

## Tests run

<!-- exact commands run locally and their result, e.g.:
     bun test src/tests/  → 1140 pass, 1 known-baseline fail (auth-hardening.test.ts, see below) -->

## Typecheck

- [ ] `bun run typecheck` passes

## Lint

- [ ] `bun run lint` on changed files passes (whole-repo `bun run lint` currently has a
      pre-existing baseline of formatting errors unrelated to any single PR — see
      docs/GITHUB_GOVERNANCE.md; do not attempt to fix unrelated files in this PR)

## Build

- [ ] `bun run build` succeeds

## Bundle / security checks

- [ ] `bun test src/tests/bundle-boundary.test.ts` passes against a real build (run
      `bun run build` first — the test skips silently without a build output)
- [ ] `bun run scripts/check-migration-safety.ts --base=origin/main` reports 0 blocking findings
- [ ] No secrets, service-role keys, or provider tokens added to client-reachable code

## Known risks

<!-- anything a reviewer should specifically scrutinize; "None" is a valid answer but
     must be a deliberate statement, not an empty section -->

## Hosted migration status

- [ ] No hosted/applied migration file was modified
- [ ] Any new migration's hosted/production application status is stated explicitly (e.g.
      "NOT APPLIED — pending project-owner action" or "N/A, no migrations in this PR")

## Independent review status

<!-- Green CI is NOT independent review. Paste the review record here once done —
     see docs/GITHUB_GOVERNANCE.md §5 for the required format (reviewer, reviewed SHA,
     result, blockers, residual risks, timestamp, hosted migration status). A review is
     valid only for the exact commit SHA above; a new commit makes it stale. -->

- [ ] Independent review recorded on this PR, valid for the commit SHA above

## Staging status

<!-- e.g. "Not deployed yet" / "Deployed to <url>, smoke-tested <date>" -->

## Production status

<!-- e.g. "N/A — not merged" / "Deployed <date>, verified <what was checked>" -->

## Lifecycle status

<!-- one of: IMPLEMENTING → CODE COMPLETE → REVIEW PASSED → PR CREATED →
     READY TO MERGE → MERGED → STAGING VERIFIED → PRODUCTION VERIFIED -->

Current status:
