# APSA — Staging Verification Runbook

This runbook describes how APSA is verified against a **real, hosted Supabase
staging project**. It contains no secrets and is safe to commit.

> **CI VERIFIED ≠ STAGING VERIFIED.** A green CI run proves the code compiles,
> builds and passes its automated tests. It proves nothing about RLS, migration
> parity, or authenticated multi-organization behavior on a live project.
> See `docs/GITHUB_GOVERNANCE.md` §1.

---

## 1. What each tool proves

| Tool                                         | Connects to a DB?      | Proves                                                                                                                                                   |
| -------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run check:migration-safety`             | No                     | Static SQL safety: duplicate numbers, edits to hosted migrations, unrevoked `SECURITY DEFINER`, ambiguous overload references.                           |
| `bun run check:staging-readiness`            | No                     | Whether this checkout is _ready_ for a staging attempt: migration inventory, hosted parity, generated-type freshness, staging credential presence.       |
| `bun run verify:staging`                     | **Yes — staging only** | How the hosted staging project actually behaves: schema parity, RLS, unauthenticated RPC denial, tenant isolation, session revocation, role enforcement. |
| `bun test src/tests/bundle-boundary.test.ts` | No                     | No `supabaseAdmin` / service-role key reaches the client bundle.                                                                                         |

`check:staging-readiness` and `verify:staging` **never apply a migration and
never change hosted configuration.** Applying migrations is a separate,
owner-approved step (§5).

---

## 2. Reporting contract

Both scripts report exactly one verdict per check:

| Verdict          | Meaning                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `PASS`           | The check ran and the expected behavior held.                     |
| `FAIL`           | The check ran and the expected behavior did **not** hold.         |
| `PENDING`        | Known outstanding work — e.g. a migration not yet applied hosted. |
| `INCONCLUSIVE`   | The check ran but the result proves neither pass nor fail.        |
| `NOT CONFIGURED` | A prerequisite is absent, so the check did not run.               |

`INCONCLUSIVE` and `NOT CONFIGURED` are **never** counted as passes.
`verify:staging` exits non-zero if any check is inconclusive or unconfigured,
so a partial run can never be recorded as "staging verified".

---

## 3. Prerequisites the project owner must provide

Staging verification **cannot run** until these exist. Nothing here should be
committed — put them in `.env.staging.local` (git-ignored) or your shell.

### 3.1 A dedicated staging Supabase project

A **separate** Supabase project from production.

| Variable                            | Where to find it                                                           |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `STAGING_SUPABASE_URL`              | Staging project → Settings → API → Project URL                             |
| `STAGING_SUPABASE_ANON_KEY`         | Staging project → Settings → API → anon/public key                         |
| `STAGING_SUPABASE_SERVICE_ROLE_KEY` | Staging project → Settings → API → service_role key (**server-side only**) |

#### The production URL witness is mandatory

`verify:staging` **refuses to run at all** unless a production URL witness is
set — `VITE_SUPABASE_URL` or `PRODUCTION_SUPABASE_URL`. This is not optional
convenience: without a production URL to compare against, "is this staging?" is
a question nobody answered, and an unset variable would let every hosted probe
run against whatever `STAGING_SUPABASE_URL` happens to point at.

The comparison is made on **normalized** URLs, so `https://Abc.supabase.co/` and
`https://abc.supabase.co` are recognized as the same project rather than as two
different ones.

The gate refuses, before any client is constructed and before any network
request is made, when:

| Refusal code                 | Condition                                                            |
| ---------------------------- | -------------------------------------------------------------------- |
| `staging_url_missing`        | `STAGING_SUPABASE_URL` is unset                                      |
| `anon_key_missing`           | `STAGING_SUPABASE_ANON_KEY` is unset                                 |
| `service_key_missing`        | `STAGING_SUPABASE_SERVICE_ROLE_KEY` is unset                         |
| `production_witness_missing` | Neither `VITE_SUPABASE_URL` nor `PRODUCTION_SUPABASE_URL` is set     |
| `staging_is_production`      | Staging and production normalize to the same project                 |
| `keys_identical`             | The anon and service-role keys hold the same value                   |
| `anon_slot_privileged`       | The anon slot holds a `service_role`/`sb_secret_` key (swapped keys) |
| `service_slot_public`        | The service slot holds an `anon`/`sb_publishable_` key               |
| `org_ids_identical`          | `STAGING_ORG_A_ID` equals `STAGING_ORG_B_ID`                         |

The key-role check reads only the `role` claim of a key and never logs, returns
or echoes key material. It is a confusion check, not authentication — a
privileged key in the anon slot would silently turn every RLS check into a false
pass.

**`--allow-write-probes` does not relax any of the above.** The gate is
evaluated at the top of the script, before any Supabase client exists and before
any flag affects control flow, and a refusal exits with code 2.

#### Bounded execution

| Variable                     | Default  | Effect             |
| ---------------------------- | -------- | ------------------ |
| `STAGING_REQUEST_TIMEOUT_MS` | `15000`  | Per hosted request |
| `STAGING_GLOBAL_TIMEOUT_MS`  | `300000` | For the whole run  |

An unreachable staging project ends the run with a reported timeout instead of
hanging, and a timed-out run is never recorded as verified.

### 3.2 Two organizations and four accounts on staging

Required for tenant-isolation, role and session checks. Without them those
checks report `NOT CONFIGURED` — they are not silently skipped.

| Variable                                | Purpose                                         |
| --------------------------------------- | ----------------------------------------------- |
| `STAGING_ORG_A_ID`, `STAGING_ORG_B_ID`  | Two organizations with **no** shared membership |
| `STAGING_OWNER_A_EMAIL` / `_PASSWORD`   | Owner of Org A                                  |
| `STAGING_MANAGER_A_EMAIL` / `_PASSWORD` | Manager of Org A                                |
| `STAGING_STAFF_A_EMAIL` / `_PASSWORD`   | Staff/Cashier of Org A                          |
| `STAGING_OWNER_B_EMAIL` / `_PASSWORD`   | Owner of Org B                                  |

All four accounts must have **verified emails** — `verify:staging` fails the run
if an unverified account can sign in, because that would mean email verification
is not being enforced.

Each account must contain only disposable staging data. Never point these at a
real customer record.

### 3.3 A deployed staging URL

Needed for the deployed-bundle scan in §4.5. Not required by the scripts.

---

## 4. The verification sequence

Run in this order. Do not continue past a `FAIL`.

### 4.1 Offline readiness

```
bun run check:migration-safety
bun run check:staging-readiness
```

`check:staging-readiness` prints the exact list of migrations that are **pending**
— present locally, not recorded as applied hosted. Use `--require-parity` to
make any pending migration a hard failure once staging is expected to be level
with `main`, and `--require-staging-env` to fail closed when credentials are
absent.

### 4.2 Hosted verification

```
bun run verify:staging
```

Covers, on the live staging project:

1. **Schema parity** — every table the local migrations define exists on staging.
2. **RLS** — an anonymous client reads zero rows from every table the service
   role can see rows in.

   A zero-row anonymous read is only evidence when there was something to read.
   On an **empty** table, "RLS blocked the read" and "the table was empty"
   produce identical output, so an empty table is reported `INCONCLUSIVE` and is
   **never** counted toward the RLS-proven total. The script will not insert a
   canary row to manufacture a result — seed representative rows in each
   organization on staging and re-run.

3. **Unauthenticated RPC** — each RPC granted to `authenticated` is probed for
   anonymous denial, with two honest limits:

   - **Default mode invokes only RPCs this checkout can statically prove
     read-only** (declared `STABLE`/`IMMUTABLE` with no write statement in the
     body). An RPC that mutates, or whose definition cannot be parsed, is **not
     called** and is reported `INCONCLUSIVE`. The script cannot promise that no
     mutating RPC can ever execute — whether a function runs for an anonymous
     caller is decided by the hosted project's grants, not by this tool. What it
     guarantees is that it never asks a function to run unless that function is
     provably read-only. Use `--allow-write-probes` against a disposable staging
     project to probe the rest, or audit the grants directly.
   - Each RPC is called with **type-correct placeholder arguments** derived from
     its declared signature (the nil UUID, empty string, zero, false, the epoch),
     so a function with required parameters reaches the authorization decision.
     Probing everything with `{}` made any such function answer `PGRST202`
     regardless of its permissions, which reads as inconclusive forever and
     hides a genuinely exposed function.
   - `PGRST202`/`PGRST203` are always `INCONCLUSIVE`, never a pass: PostgREST
     reports a missing function and an unmatched signature identically, so
     neither can stand in for "the anonymous caller was denied".

4. **Hosted migration history** — compared against the local inventory when
   `supabase_migrations.schema_migrations` is readable; otherwise reported
   `INCONCLUSIVE` (confirm from the dashboard and record in
   `supabase/hosted-migrations.lock.json`).
5. **Authenticated behavior** —
   - verified-email sign-in succeeds; unverified sign-in fails the run;
   - an Org A member reads **zero** Org B rows across every tenant-scoped table,
     using the real Org B UUID (the IDOR case);
   - the access token is rejected **after** sign-out (revocation enforced
     server-side, not just cleared client-side);
   - a structurally invalid token never authenticates;
   - User A → sign-out → User B yields a **distinct** identity, proving no
     principal is cached across the transition;
   - a Staff account cannot read `audit_logs`.

#### What counts as proof

Only an explicit **authorization** refusal — `42501`, `PGRST301` or `PGRST302` —
proves a denial. A malformed id (`22P02`), a trigger error (`P0001`), a check or
not-null violation (`235xx`) or any other error means the request never reached
the authorization decision. Those are reported `INCONCLUSIVE`; none is ever
recorded as a successful refusal.

#### Write probes

Writes are **off by default**. `--allow-write-probes` additionally attempts a
cross-tenant `UPDATE` that must be refused **by authorization**. Run it against
staging only.

The probe is chosen and shaped so its result means something:

- the target is tenant-scoped and **not trigger-protected**, because a trigger
  can raise before authorization is reached and its refusal would prove nothing.
  If every tenant-scoped table carries a trigger, the check reports
  `NOT CONFIGURED` rather than inventing a target;
- the update is a **no-op by value** — it sets `organization_id` to the same
  value it filters on — so even in the failing case where the write is accepted,
  no column changes;
- a refusal that is not an authorization code leaves write isolation `UNPROVEN`.

### 4.3 Full automated suite

```
bun run typecheck && bun run lint && bun test src/tests/ && bun run build
```

### 4.4 Client bundle boundary

```
bun run build && bun test src/tests/bundle-boundary.test.ts
```

Asserts no `supabaseAdmin`, no `SUPABASE_SERVICE_ROLE_KEY`, and no server-only
permission module reaches the browser bundle.

### 4.5 Deployed bundle scan

Against the deployed staging URL, confirm the served JavaScript contains no
service-role key and no admin client. For each script the staging page loads:

```
curl -s "<staging-url>/<asset>.js" | grep -c -E 'service_role|supabaseAdmin|SUPABASE_SERVICE_ROLE_KEY'
```

Every result must be `0`. Never paste the key itself into a grep — match on the
identifier names above, not on a secret value.

---

## 5. Applying pending migrations (owner-approved only)

`check:staging-readiness` reports pending migrations; it never applies them.
Before any apply:

1. Record the **exact ordered list** from `check:staging-readiness`.
2. Confirm `check:migration-safety` reports **0 blocking findings**.
3. Confirm none of the pending migrations edits a file already in
   `supabase/hosted-migrations.lock.json` — hosted migrations are immutable.
4. Apply **to staging first**, in numeric order, never to production.
5. Re-run `verify:staging` and confirm schema parity now passes.
6. Regenerate types:
   ```
   supabase gen types typescript --project-id <staging-ref> --schema public > src/lib/supabase/types.ts
   ```
7. Update `supabase/hosted-migrations.lock.json` with the newly applied files
   and their sha256, and set `last_verified`.

Each migration file carries rollback instructions in its header comment. Roll
back in reverse numeric order.

---

## 6. What must never be printed

Neither script prints, logs, or returns:

- any key, token, cookie or session value;
- any customer PII — name, phone, email, address;
- any message content;
- any row content from a tenant table.

Failures report **table names, error codes and counts only**. Environment
handling is presence-only: `checkEnvPresence()` returns booleans, never values.
If you extend these scripts, preserve that boundary.

---

## 7. Recording the result

Only record `STAGING VERIFIED` on a PR when `verify:staging` exited **0** — every
check passed, with nothing inconclusive or unconfigured. Name what was actually
checked and against which staging project ref. A run with `NOT CONFIGURED` lines
is an incomplete run, not a pass.
