# Owner-run read-only SQL

## `apsa_staging_061_preflight.sql`

The reviewed staging-061 read-only preflight, stored byte-for-byte as reviewed.
Do not edit, reformat or regenerate it; any change is a new file and a new review.

- **Staging only.** Run it only against the confirmed staging project, as `postgres`.
  Never run it against production.
- **Exact hash.** Run it only if this prints `OK`:

  ```sh
  echo "2392d5a610b235b670bb608e85a1457a787bf167f61c07314e1a66f778bbc53c  scripts/sql/apsa_staging_061_preflight.sql" | sha256sum -c -
  ```

- **Run it with psql**, the whole file in one session, so that the complete report is
  captured. Supply the connection through the environment (for example `PGHOST`,
  `PGUSER`, a service file or `.pgpass`), never on the command line, and write the
  output outside the repository:

  ```sh
  psql -X -q -v ON_ERROR_STOP=1 --csv -f scripts/sql/apsa_staging_061_preflight.sql -o <outside-repo>/preflight.csv
  ```

  The run is valid only with exit status 0 and exactly one `99.01` row in the output.

- **Supabase SQL Editor's "Success" is not a pass.** The editor can show only the last
  statement's status (`ROLLBACK`), not the report. An error, empty output or a missing
  `99.01` row is never a pass.
- **§8b stop conditions apply.** On staging the result is judged only by
  `docs/RELEASE_CHECKLIST.md` §8b step 1, which requires the exact expected
  blocked result. Any deviation is a stop. No result of this file authorizes
  migration 061 by itself.
