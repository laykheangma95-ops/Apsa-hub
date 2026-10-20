# PR #126 verification (verification only, do not merge as a feature)

`.github/workflows/pr126-verification.yml` runs PR #126's committed native
PostgREST gate and mobile harness, unchanged, at one fixed commit:

- target: `f42c4ff2d5e4ae80479f6712daf677fb367698e9` (checked out by SHA and
  verified before any test; `47c8627e48bf179d0309d84fc06e3ba3d18f3f21` must be
  its ancestor)
- trigger: `workflow_dispatch` only; token `contents: read`,
  `pull-requests: read`; no secrets, no environment, no hosted database

## Jobs

| Job                      | What runs                                                                                                                             | Artifact                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `gate-caps`              | `scripts/run-catalog-postgrest-gate.ts --caps 40,150,1000`, then `embed-probe.ts`                                                     | `pr126-gate-caps`              |
| `gate-negative-controls` | the same gate `--caps 40 --negative-controls` in its own runner and checkout; records whether the checkout was restored               | `pr126-gate-negative-controls` |
| `mobile`                 | `scripts/products-mobile-harness.ts` (production build, `/app/products`, km/en × 320/360/390/430) through `tooling/font-observer.mjs` | `pr126-mobile`                 |
| `summary`                | `summarize.ts` over the three artifacts; also written to the run's summary page                                                       | `pr126-summary`                |

Every job uploads its evidence with `if: always()`. Each test step keeps its
command's real exit code, and `summarize.ts` passes a section only when the
content matches too: 14/14 cases with 0 skips at each cap, 8/8 controls
caught with the checkout restored, and 162 mobile checks with only
harness-marked pre-existing failures and 0 console errors. It also requires
`document.fonts` to be loaded, with a Kantumruy Pro face loaded on Khmer
text, at every observed measurement.

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
and, before every `page.evaluate` and screenshot, records `document.fonts.status`
and the Kantumruy Pro / Plus Jakarta Sans face states to `fonts.jsonl`. It also
records the browser version. It observes only and never waits.

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
dispatched from this branch. See the PR description.
