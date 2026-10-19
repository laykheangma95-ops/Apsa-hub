#!/usr/bin/env bash
# Runs the native PostgreSQL suites inside an integration tree and keeps their
# logs (plain + JUnit) in <log-dir>.
#
#   APSA_TEST_PG_URL=postgres://postgres@localhost:5432/postgres \
#     run-suites.sh <integration-tree> <log-dir> [races|cross-principal ...]
#
# Exit status is nonzero when any suite fails.
set -uo pipefail

TREE="$(realpath "$1")"
LOGS="$(realpath -m "$2")"
shift 2
[ $# -gt 0 ] || set -- races cross-principal
: "${APSA_TEST_PG_URL:?APSA_TEST_PG_URL is required}"
mkdir -p "$LOGS"

status=0
for suite in "$@"; do
  case "$suite" in
    races) file=cancellation-races-pg.runtime.ts ;;
    cross-principal) file=cross-principal-pg.runtime.ts ;;
    *) echo "unknown suite: $suite" >&2; exit 2 ;;
  esac
  echo "::group::$suite"
  (cd "$TREE" && bun test "./src/tests/native-pg-integration/$file" \
    --timeout 120000 \
    --reporter=junit --reporter-outfile="$LOGS/$suite.junit.xml") 2>&1 | tee "$LOGS/$suite.log"
  rc=${PIPESTATUS[0]}
  echo "::endgroup::"
  echo "$suite: exit $rc" | tee -a "$LOGS/summary.txt"
  [ "$rc" -eq 0 ] || status=1
done
exit "$status"
