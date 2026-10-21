# Native PostgreSQL integration harness — PR #121 + PR #128

Verification only. It changes no production code, migration, or PR branch.

It builds a **throwaway** integration tree of `main` + PR #121 + PR #128 at the
commits pinned in [`pins.env`](./pins.env). On disposable PostgreSQL databases,
it applies the complete migration chain (001 → 061, 062, 063) and proves:

| Suite | What it shows |
|---|---|
| `cancellation-races-pg.runtime.ts` | Real two-session races: cancellation vs courier handoff, vs delivery completion, vs counter handoff, and simultaneous cancellations (held lock + a 12-way burst). Both lock orders for each pair. The waiting backend is **observed** blocked (`wait_event_type = 'Lock'`, holder in `pg_blocking_pids`). Afterwards it checks order axes, the inventory ledger (per order and per variant), deliveries, and order and delivery status history. |
| `cross-principal-pg.runtime.ts` | A → B → A (organization switch and member switch) through the integrated **production services** (orders, deliveries, the real `AuthorizationContext`, audit writer and rate limiter). While B, every request is refused `409 principal_changed` and the whole write surface stays identical: orders, items, ledger, history, deliveries, payments, `audit_logs`, `rate_limit_buckets`. Back as A, the request runs once, attributed to A. Also covers IDOR (honest B naming A's ids → 404, nothing written), a missing principal (428), and the custody refusals mapped by the service. |

Only the Supabase admin client is replaced, by a thin PostgREST-shaped
transport over the throwaway database. Audit rows and rate-limit tokens are
real rows in it. No Supabase project, Vercel project, or secret is used.

## Negative controls (run in CI)

A suite that cannot fail proves nothing, so the workflow also runs:

- **races without migration 063**: the custody races must fail (they do: 6 of 11, every custody race plus the chain check; the controls still pass).
- **cross-principal without PR #121** (main + #128 only): the principal refusals must fail (they do: 8 of 9; only the pre-existing tenant-isolation case passes).

A passing control fails the job.

## Known integration conflicts

main + PR #121 merges cleanly (#121's pinned head already contains the pinned
main); a conflict there fails the run. The PR #128 merge has known conflicts.
[`resolve-conflicts.ts`](./resolve-conflicts.ts) resolves only these, and fails
on anything else:

- Three migration-head pin tests (#121 ↔ #128, predicted in #128's description): takes #128's side (head = 063).

## Reproduce locally

You need Bun 1.4.2, git, and a disposable PostgreSQL 16 or 17 with trust auth.
**Never** point it at a hosted database: each suite creates and drops its own
database on that server.

```bash
# 1. a throwaway server (example: Docker)
docker run --rm -d --name apsa-harness-pg -p 55432:5432 \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17

# 2. the integration tree (refuses to run if a PR head moved from its pin)
ci/native-pg-integration/integrate.sh . /tmp/apsa-integ
(cd /tmp/apsa-integ && bun install --frozen-lockfile)

# 3. the suites (logs + JUnit in /tmp/apsa-logs; nonzero exit on any failure)
APSA_TEST_PG_URL=postgres://postgres@localhost:55432/postgres \
  ci/native-pg-integration/run-suites.sh /tmp/apsa-integ /tmp/apsa-logs

# negative controls
APSA_TEST_PG_URL=postgres://postgres@localhost:55432/postgres APSA_HARNESS_WITHHOLD_MIGRATION=063 \
  ci/native-pg-integration/run-suites.sh /tmp/apsa-integ /tmp/apsa-logs/no-063 races      # must fail
HARNESS_SKIP_PR121=1 ci/native-pg-integration/integrate.sh . /tmp/apsa-integ-no121
ln -s /tmp/apsa-integ/node_modules /tmp/apsa-integ-no121/node_modules
APSA_TEST_PG_URL=postgres://postgres@localhost:55432/postgres \
  ci/native-pg-integration/run-suites.sh /tmp/apsa-integ-no121 /tmp/apsa-logs/no-121 cross-principal  # must fail

# 4. clean up
git worktree remove --force /tmp/apsa-integ; git worktree remove --force /tmp/apsa-integ-no121
docker stop apsa-harness-pg
```

## Re-pinning

When either PR gets new commits, `integrate.sh` stops with
`PR #N head is …, pinned …`. Update `pins.env` deliberately. If the conflicts
change, `resolve-conflicts.ts` fails and needs a human resolution.

## Scope limits

- The server's own derivation of the principal (session cookie → member →
  active organization) is not exercised. The suites construct the
  `AuthorizationContext` the server would derive, and test everything from
  the service boundary down.
- Browser and mounted-UI behaviour (PR #121's React suites) runs in the
  `integrated-ci` job's full test suite, not here.
