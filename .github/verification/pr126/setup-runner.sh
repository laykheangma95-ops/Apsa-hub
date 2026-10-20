#!/usr/bin/env bash
# Disposable-runner setup for the PR #126 verification workflow.
#
#   setup-runner.sh <evidence dir>
#
# - Native PostgreSQL 16 from the runner image, reachable only on loopback,
#   TCP logins by scram-sha-256 password only (no trust lines), with a random
#   password generated for this run. Nothing here is a Supabase project.
# - PostgREST 12.2.12 (the version PR #126 reports), its release asset checked
#   against a pinned SHA-256 and, where GitHub publishes one, the release API's
#   own asset digest.
#
# Exports APSA_TEST_PG_URL and APSA_TEST_POSTGREST_BIN through $GITHUB_ENV and
# writes what it checked to <evidence dir>/runner-setup.txt.
set -euo pipefail

out="${1:?evidence dir}"
mkdir -p "$out"
report="$out/runner-setup.txt"
: >"$report"
note() { echo "$*" | tee -a "$report"; }

POSTGREST_VERSION="12.2.12"
POSTGREST_ASSET="postgrest-v${POSTGREST_VERSION}-linux-static-x86-64.tar.xz"
# Observed over TLS from github.com's release download on 2026-10-20.
POSTGREST_SHA256="5de4092f1719da3353c40bf96c8dec6913f2254a7cd0b61cc05f233153b557d5"

# ── PostgreSQL 16 ────────────────────────────────────────────────────────────
pw="$(openssl rand -hex 24)"
echo "::add-mask::$pw"

sudo systemctl start postgresql.service
if ! pg_lsclusters --no-header | awk '$1 == 16 && $2 == "main"' | grep -q .; then
  sudo pg_createcluster 16 main
fi
conf_dir=/etc/postgresql/16/main
# Loopback only; scram for every TCP login; the OS superuser keeps peer on the socket.
sudo tee "$conf_dir/conf.d/apsa-verification.conf" >/dev/null <<'CONF'
listen_addresses = 'localhost'
port = 5432
password_encryption = 'scram-sha-256'
max_connections = 200
CONF
sudo tee "$conf_dir/pg_hba.conf" >/dev/null <<'HBA'
# PR #126 verification runner: no trust, no remote hosts.
local   all   postgres                 peer
host    all   all       127.0.0.1/32   scram-sha-256
host    all   all       ::1/128        scram-sha-256
HBA
sudo pg_ctlcluster 16 main stop 2>/dev/null || true
sudo pg_ctlcluster 16 main start
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -v pw="$pw" <<'SQL'
ALTER ROLE postgres PASSWORD :'pw';
SQL

url="postgres://postgres:${pw}@127.0.0.1:5432/postgres"
server_version="$(PGPASSWORD="$pw" psql -h 127.0.0.1 -U postgres -w -Atc 'show server_version')"
note "postgres.server_version=$server_version"
[[ "$server_version" == 16.* ]] || { note "FAIL: expected PostgreSQL 16"; exit 1; }
note "postgres.listen_addresses=$(PGPASSWORD="$pw" psql -h 127.0.0.1 -U postgres -w -Atc 'show listen_addresses')"
note "postgres.password_encryption=$(PGPASSWORD="$pw" psql -h 127.0.0.1 -U postgres -w -Atc 'show password_encryption')"
hba="$(PGPASSWORD="$pw" psql -h 127.0.0.1 -U postgres -w -Atc \
  "select type||' '||array_to_string(database,',')||' '||array_to_string(user_name,',')||' '||coalesce(address,'')||' '||auth_method from pg_hba_file_rules order by line_number")"
note "postgres.hba:"
note "$hba"
if grep -qw trust <<<"$hba"; then note "FAIL: a trust rule is present"; exit 1; fi
# A wrong password and no password must both be refused over TCP.
if PGPASSWORD="wrong-$pw" psql -h 127.0.0.1 -U postgres -w -Atc 'select 1' >/dev/null 2>&1; then
  note "FAIL: a wrong password was accepted"; exit 1
fi
if env -u PGPASSWORD psql -h 127.0.0.1 -U postgres -w -Atc 'select 1' >/dev/null 2>&1; then
  note "FAIL: a passwordless TCP login was accepted"; exit 1
fi
note "postgres.wrong_or_missing_password=refused"
listeners="$(sudo ss -Hltn 'sport = :5432' | awk '{print $4}' | sort -u | tr '\n' ' ')"
note "postgres.listeners=$listeners"
for address in $listeners; do
  case "$address" in 127.0.0.1:5432 | "[::1]:5432") ;; *) note "FAIL: listening on $address"; exit 1 ;; esac
done

# ── PostgREST ────────────────────────────────────────────────────────────────
bin_dir="$RUNNER_TEMP/postgrest"
mkdir -p "$bin_dir"
curl -fsSL --retry 3 -o "$bin_dir/$POSTGREST_ASSET" \
  "https://github.com/PostgREST/postgrest/releases/download/v${POSTGREST_VERSION}/${POSTGREST_ASSET}"
echo "$POSTGREST_SHA256  $bin_dir/$POSTGREST_ASSET" | sha256sum -c - | tee -a "$report"
api_digest="$(gh api "repos/PostgREST/postgrest/releases/tags/v${POSTGREST_VERSION}" \
  --jq ".assets[] | select(.name == \"${POSTGREST_ASSET}\") | .digest // \"\"" 2>/dev/null || true)"
if [[ -n "$api_digest" ]]; then
  note "postgrest.release_api_digest=$api_digest"
  [[ "$api_digest" == "sha256:$POSTGREST_SHA256" ]] || { note "FAIL: release API digest differs from the pin"; exit 1; }
else
  note "postgrest.release_api_digest=not published (pinned SHA-256 only)"
fi
tar -xJf "$bin_dir/$POSTGREST_ASSET" -C "$bin_dir" postgrest
postgrest_version="$("$bin_dir/postgrest" --version)"
note "postgrest.version=$postgrest_version"
[[ "$postgrest_version" == *"$POSTGREST_VERSION"* ]] || { note "FAIL: unexpected PostgREST version"; exit 1; }

{
  echo "APSA_TEST_PG_URL=$url"
  echo "APSA_TEST_POSTGREST_BIN=$bin_dir/postgrest"
  # For scrubbing evidence files before upload; masked in logs above.
  echo "APSA_VERIFY_PG_PASSWORD=$pw"
} >>"$GITHUB_ENV"
note "APSA_TEST_PG_URL=postgres://postgres:***@127.0.0.1:5432/postgres"
