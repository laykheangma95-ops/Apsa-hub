#!/usr/bin/env bash
# Builds the throwaway integration tree main + PR #121 + PR #128 at the pinned
# commits (pins.env) and copies this harness's tests into it.
#
#   integrate.sh <repo> <out-dir>
#
# HARNESS_SKIP_PR121=1 builds main + PR #128 only: the negative control that
# shows the cross-principal suite fails without PR #121's protections.
#
# <repo> is any clone of Apsa-hub with network access to origin. Nothing is
# pushed, and neither PR branch is touched: the merges happen in a detached
# worktree in <out-dir>, which may be deleted afterwards.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$1" && pwd)"
OUT="$(realpath -m "$2")"
# shellcheck source=pins.env
source "$HERE/pins.env"

git -C "$REPO" fetch --no-tags origin \
  "$MAIN_SHA" \
  "+refs/pull/121/head:refs/remotes/harness/pr-121" \
  "+refs/pull/128/head:refs/remotes/harness/pr-128"

# A PR head that moved is a re-pin decision, never silently tested.
for pr in 121 128; do
  pin_var="PR${pr}_SHA"
  head="$(git -C "$REPO" rev-parse "refs/remotes/harness/pr-${pr}")"
  if [ "$head" != "${!pin_var}" ]; then
    echo "::error::PR #${pr} head is ${head}, pinned ${!pin_var}. Re-pin deliberately." >&2
    exit 1
  fi
done

git -C "$REPO" worktree add --detach "$OUT" "$MAIN_SHA"
cd "$OUT"
export GIT_AUTHOR_NAME=harness GIT_AUTHOR_EMAIL=harness@test.invalid
export GIT_COMMITTER_NAME=harness GIT_COMMITTER_EMAIL=harness@test.invalid

# Known conflicts only (resolve-conflicts.ts); anything else fails the run.
merge() {
  local stage="$1" sha="$2" msg="harness: merge PR #${1#pr} @ $2"
  if ! git merge --no-ff --no-edit -m "$msg" "$sha"; then
    bun "$HERE/resolve-conflicts.ts" "$OUT" "$stage"
    git commit --no-edit -m "$msg (known conflicts resolved)"
  fi
}
required="061_browser_table_authority_hardening 063_order_cancellation_custody_guard"
if [ "${HARNESS_SKIP_PR121:-}" = "1" ]; then
  echo "NEGATIVE CONTROL: PR #121 is NOT merged into this tree"
  git merge --no-ff --no-edit -m "harness: merge PR #128 @ $PR128_SHA (control)" "$PR128_SHA"
else
  merge pr121 "$PR121_SHA"
  merge pr128 "$PR128_SHA"
  required="$required 062_financial_replay_refund_audit_atomicity"
fi

for m in $required; do
  test -f "supabase/migrations/$m.sql" || { echo "::error::missing migration $m" >&2; exit 1; }
done
# One file per migration number: the chain applies in a single, total order.
dupes="$(ls supabase/migrations | grep -oE '^[0-9]+' | sort | uniq -d)"
if [ -n "$dupes" ]; then echo "::error::duplicate migration numbers: $dupes" >&2; exit 1; fi

mkdir -p src/tests/native-pg-integration
cp "$HERE"/*.runtime.ts src/tests/native-pg-integration/
git log --oneline -4
echo "integration tree: $(git rev-parse HEAD) (tree $(git rev-parse 'HEAD^{tree}'))"
