# PR #126 verification (verification only, do not merge as a feature)

`.github/workflows/pr126-verification.yml` runs PR #126's committed native
PostgREST gate and mobile harness, unchanged, at one fixed commit:

- target: `5042656b8acf1f8389ed0ba8a6ff06bdf324e41e` (checked out by SHA and
  verified before any test; `47c8627e48bf179d0309d84fc06e3ba3d18f3f21` must be
  its ancestor)
- trigger: `workflow_dispatch`, or `pull_request` on PR #133 only (same-repo
  branch `claude/verify-pr126-ci-evidence` into `main`; the `scope` job skips
  every other pull request); never `pull_request_target`; token
  `contents: read`, `pull-requests: read`; no secrets, no environment, no
  hosted database
- scripts: checked out at #133's head commit (not the merge ref) and verified;
  the application checkout is the target SHA above. Both are recorded.

## Jobs

| Job                      | What runs                                                                                                                             | Artifact                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `gate-caps`              | `scripts/run-catalog-postgrest-gate.ts --caps 40,150,1000`, then `embed-probe.ts`                                                     | `pr126-gate-caps`              |
| `gate-negative-controls` | the same gate `--caps 40 --negative-controls` in its own runner and checkout; records whether the checkout was restored               | `pr126-gate-negative-controls` |
| `mobile`                 | `scripts/products-mobile-harness.ts` (production build, `/app/products`, km/en × 320/360/390/430) through `tooling/font-observer.mjs` | `pr126-mobile`                 |
| `summary`                | `summarize.ts` over the three artifacts; also written to the run's summary page                                                       | `pr126-summary`                |

Every job uploads its evidence with `if: always()`. Each test step keeps its
command's real exit code. `summarize.ts` gives three separate verdicts, each
passing only when the content matches too, and the overall result is PASS
only when all three pass:

- **Native PostgREST gate:** 14/14 cases with 0 skips at each cap, and 8/8
  controls caught with the checkout restored.
- **Authorization:** the 3 PRINCIPAL-AUTHZ cases at each cap, and the
  org-scope, `products.read` and `products.view_cost` controls. Embedded-
  permission truncation is listed as a finding.
- **Mobile:** 162 checks, all passing, with 0 console errors. A failure the
  harness marks as pre-existing on main still fails the verdict and is named.
  Fonts must be settled and loaded, with a Kantumruy Pro face on Khmer text,
  at every measurement.

## Runner setup (`setup-runner.sh`)

- PostgreSQL 16 from the `ubuntu-24.04` image. It listens on `localhost`
  only. `pg_hba` holds `peer` for the local OS superuser and `scram-sha-256`
  for 127.0.0.1/::1, with no `trust` rule. The password is random per run and
  masked. The script checks that a wrong password and a missing one are both
  refused, and that nothing listens beyond loopback.
- PostgREST 12.2.12 (`postgrest-v12.2.12-linux-static-x86-64.tar.xz`). It is
  checked against a pinned SHA-256, and against GitHub's release-API digest
  where one is published, then `--version`.
- `tooling/`: `playwright-core` 1.56.1, installed from a committed lockfile
  with its registry integrity hash via `npm ci --ignore-scripts`. Its Chromium
  comes from `playwright-core install --with-deps chromium`.

## Fonts

The harness does not wait for web fonts. `font-observer.mjs` is the module the
harness loads as `APSA_PLAYWRIGHT_CORE`. It wraps the real `playwright-core`
and, before every `page.evaluate` and screenshot, waits up to 15 s for the
Khmer web font (when the page shows Khmer) and `document.fonts.ready`. It then
records the wait, `document.fonts.status` and the Kantumruy Pro / Plus Jakarta
Sans face states to `fonts.jsonl`, plus the browser version. It changes no page
state and no assertion; it only delays. Run 39348541760 showed the harness
measuring before the font had loaded without this wait. At each
`*-list.png` screenshot it also repeats the harness's long-Khmer-name check,
read-only, with the font state at that moment. This is a supplemental table
and changes no verdict.

## Authorization coverage of the gate's 14 cases

- FIXTURE (8): `ctxFor(org)` — `require()` no-op, `can()` always true. These
  cover paging and search over real PostgREST, **not** authorization.
- RAW (1): the cap itself.
- PRINCIPAL-AUTHZ (3): the real `resolveActiveOrganizationId` +
  `AuthorizationService` through PostgREST: the principal path, deep matches
  with a neighbouring org, and roles.
- PRINCIPAL-CONTEXT (2): the real principal, asserting paging only.

All reads use a service_role JWT, as the server does, so RLS is not exercised.
The session/cookie layer before `principal()` is not exercised either.
`embed-probe.ts` independently measures `db-max-rows` truncation of the
membership read's embedded permission keys at each cap.

## Dispatch

GitHub only offers `workflow_dispatch` for workflows whose file is on the
default branch. Until this file is on `main`, the workflow cannot be
dispatched from this branch; it runs instead on each push to PR #133.
