/**
 * The known textual conflicts of the pinned integration (pins.env), resolved
 * deterministically for the throwaway integration tree. Nothing here is pushed
 * to either PR, and no production code is chosen differently from its PR.
 *
 * Stage "pr121" (main + PR #121):
 *   src/routes/app.orders.$id.tsx — main changed `back` to keep the list
 *   filter; PR #121 added its principal-reset layout effects just above the
 *   old `back`. Kept both: #121's block, then main's `back`.
 *
 * Stage "pr128" (+ PR #128): the migration-head pins PR #128 itself predicts
 * will conflict ("Merge order with PR #121"). Both sides only move the pin;
 * once 062 and 063 are both present, PR #128's side (head = 063) is the
 * correct one.
 *
 * Any other conflicted file, or a different conflict shape, fails the run: a
 * re-pin that changes the conflicts must be resolved by a human.
 *
 * Usage: bun ci/native-pg-integration/resolve-conflicts.ts <tree> <pr121|pr128>
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [tree, stage] = process.argv.slice(2);
if (!tree || (stage !== "pr121" && stage !== "pr128")) {
  throw new Error("usage: resolve-conflicts.ts <tree> <pr121|pr128>");
}

type Resolver = (ours: string, theirs: string) => string;

const ORDERS_BACK = [
  "  // Back to the list the merchant came from, filter included.",
  '  const back = () => navigate({ to: "/app/orders", search: (prev) => prev });',
].join("\n");
const PR121_BACK = '  const back = () => navigate({ to: "/app/orders" });';

const keepPr121EffectsAndMainBack: Resolver = (ours, theirs) => {
  if (ours.trim() !== ORDERS_BACK.trim()) throw new Error("unexpected main side");
  if (!theirs.trimEnd().endsWith(PR121_BACK)) throw new Error("unexpected PR #121 side");
  return `${theirs.trimEnd().slice(0, -PR121_BACK.length)}${ORDERS_BACK}`;
};

const takePr128MigrationHead: Resolver = (ours, theirs) => {
  // PR #121 pins the head at its 062; PR #128 at 063.
  if (!/PR #121/.test(ours)) throw new Error("unexpected PR #121 pin side");
  if (!/063/.test(theirs)) throw new Error("unexpected PR #128 pin side");
  return theirs;
};

const KNOWN: Record<string, Record<string, Resolver>> = {
  pr121: { "src/routes/app.orders.$id.tsx": keepPr121EffectsAndMainBack },
  pr128: {
    "src/tests/customer-search.test.ts": takePr128MigrationHead,
    "src/tests/payments-operations-ui.test.ts": takePr128MigrationHead,
    "src/tests/product-catalog-ui.test.ts": takePr128MigrationHead,
  },
};

const expected = KNOWN[stage]!;
const conflicted = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
  cwd: tree,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean)
  .sort();
if (JSON.stringify(conflicted) !== JSON.stringify(Object.keys(expected).sort())) {
  throw new Error(`Unexpected conflicted files for ${stage}: ${JSON.stringify(conflicted)}`);
}

const pattern = /<<<<<<< [^\n]*\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> [^\n]*\n/g;
for (const [name, resolve] of Object.entries(expected)) {
  const file = path.join(tree, name);
  const text = readFileSync(file, "utf8");
  const hunks = [...text.matchAll(pattern)];
  if (hunks.length !== 1) throw new Error(`${name}: expected 1 conflict hunk, ${hunks.length}`);
  const [, ours, theirs] = hunks[0]!;
  const resolved = text.replace(pattern, () => `${resolve(ours!, theirs!)}\n`);
  if (/^(<<<<<<<|=======|>>>>>>>)( |$)/m.test(resolved)) {
    throw new Error(`${name}: conflict markers remain`);
  }
  writeFileSync(file, resolved);
  execFileSync("git", ["add", name], { cwd: tree });
  console.log(`resolved ${name} (${stage})`);
}
