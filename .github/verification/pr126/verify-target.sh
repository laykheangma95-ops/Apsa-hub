#!/usr/bin/env bash
# Verifies a PR #126 checkout before any test runs, and records provenance.
#
#   verify-target.sh <checkout> <evidence dir>
#
# Fails unless the checkout is exactly $TARGET_SHA, clean, and descends from
# $EXPECTED_MAIN. Where main and #126's head are now is recorded, not enforced:
# the evidence is about $TARGET_SHA.
set -euo pipefail

checkout="${1:?checkout}"
out="${2:?evidence dir}"
mkdir -p "$out"
provenance="$out/provenance.txt"
note() { echo "$*" | tee -a "$provenance"; }

head="$(git -C "$checkout" rev-parse HEAD)"
note "target.expected=$TARGET_SHA"
note "target.checked_out=$head"
if [[ "$head" != "$TARGET_SHA" ]]; then note "FAIL: checkout is not the target SHA"; exit 1; fi
if [[ -n "$(git -C "$checkout" status --porcelain)" ]]; then note "FAIL: checkout is not clean"; exit 1; fi
if ! git -C "$checkout" merge-base --is-ancestor "$EXPECTED_MAIN" "$TARGET_SHA"; then
  note "FAIL: $EXPECTED_MAIN is not an ancestor of the target"; exit 1
fi
note "target.merge_base_with_expected_main=$(git -C "$checkout" merge-base "$EXPECTED_MAIN" "$TARGET_SHA")"
note "main.expected=$EXPECTED_MAIN"
note "main.now=$(git -C "$checkout" rev-parse origin/main 2>/dev/null || echo unknown)"
note "pr126.head_now=$(gh api "repos/$GITHUB_REPOSITORY/pulls/126" --jq .head.sha 2>/dev/null || echo unknown)"
note "workflow.sha=$GITHUB_SHA"
note "workflow.ref=$GITHUB_REF"
note "workflow.run=$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT"
note "runner.image=${ImageOS:-unknown} ${ImageVersion:-unknown}"
note "runner.os=$(. /etc/os-release && echo "$PRETTY_NAME")"
