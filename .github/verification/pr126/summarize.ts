/**
 * Builds the PR #126 verification summary from the jobs' evidence artifacts.
 *
 *   bun run summarize.ts <artifacts dir> <output dir>
 *
 * Writes summary.md and summary.json. A section is PASS only when its command
 * exited 0 AND its content shows what was expected (counts, names, no skips);
 * a command that merely finished is not a pass. Exits 1 unless every section
 * is PASS.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- font-log entries are free-form JSON */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [inDir, outDir] = process.argv.slice(2);
if (!inDir || !outDir) {
  console.error("usage: summarize.ts <artifacts dir> <output dir>");
  process.exit(2);
}

const read = (...parts: string[]) => {
  const file = path.join(inDir, ...parts);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
};
const exitCode = (dir: string) => {
  const raw = read(dir, "exit-code");
  return raw === null ? null : Number(raw.trim());
};

type Verdict = "PASS" | "FAIL" | "MISSING";
const sections: { name: string; verdict: Verdict; reasons: string[] }[] = [];
const md: string[] = [];

/**
 * Each case in src/tests/products-catalog-postgrest.test.ts at f42c4ff, by the
 * authorization context it runs under (static reading of the file):
 * - FIXTURE: ctxFor(org) — require() is a no-op and can() is always true; the
 *   organization id is handed in. It shows pagination/search over real
 *   PostgREST, NOT authorization.
 * - RAW: a direct PostgREST read, no service or context.
 * - PRINCIPAL-AUTHZ: principal(user) — resolveActiveOrganizationId + the real
 *   AuthorizationService (membership → role → permission keys read through
 *   PostgREST), with assertions about who sees what.
 * - PRINCIPAL-CONTEXT: the same real principal, asserting paging behaviour only.
 * Every read uses a service_role JWT, as the server does, so database RLS is not
 * what is exercised; the session/cookie layer before principal() is not either.
 */
const CASES: [string, string][] = [
  ["the cap is real", "RAW"],
  ["201 and 1,000 products", "FIXTURE"],
  ["the largest page (100)", "FIXTURE"],
  ["a same-instant burst", "FIXTURE"],
  ["category, Archived, and both together", "FIXTURE"],
  ["search through the real !inner embed", "FIXTURE"],
  ["variants: 2,500 on one product", "FIXTURE"],
  ["the POS whole-catalogue read", "FIXTURE"],
  ["another organization's cursor", "FIXTURE"],
  ["the production principal path", "PRINCIPAL-AUTHZ"],
  ["SKU, barcode and name matches", "PRINCIPAL-AUTHZ"],
  ["roles through the real membership read", "PRINCIPAL-AUTHZ"],
  ["archiving the cursor's product", "PRINCIPAL-CONTEXT"],
  ["negative control: the pre-#126 read", "PRINCIPAL-CONTEXT"],
];

function suiteResult(log: string) {
  const count = (word: string) =>
    Number(new RegExp(`^\\s*(\\d+) ${word}\\b`, "m").exec(log)?.[1] ?? NaN);
  const cases = CASES.map(([fragment, kind]) => {
    const line = log
      .split("\n")
      .find((l) => /^\((pass|fail|skip)\)/.test(l) && l.includes(fragment));
    return { fragment, kind, result: line ? /^\((\w+)\)/.exec(line)![1]! : "absent" };
  });
  // bun always prints the pass and fail counts but a skip count only when
  // something was skipped; an absent pass/fail line still reads as NaN (FAIL).
  const skip = count("skip");
  return { pass: count("pass"), fail: count("fail"), skip: Number.isNaN(skip) ? 0 : skip, cases };
}

// ── PostgREST gate: caps ─────────────────────────────────────────────────────
{
  const reasons: string[] = [];
  const code = exitCode("gate-caps");
  md.push("## PostgREST gate — caps 40, 150, 1000", "");
  if (code === null) {
    sections.push({ name: "gate-caps", verdict: "MISSING", reasons: ["no exit-code"] });
    md.push("MISSING: the job left no evidence.", "");
  } else {
    if (code !== 0) reasons.push(`gate exited ${code}`);
    md.push(`Gate exit code: \`${code}\``, "");
    const perCap: Record<string, ReturnType<typeof suiteResult>> = {};
    for (const cap of ["40", "150", "1000"]) {
      const log = read("gate-caps", "logs", `cap-${cap}.log`);
      if (log === null) {
        reasons.push(`cap ${cap}: no log`);
        continue;
      }
      const result = suiteResult(log);
      perCap[cap] = result;
      if (result.pass !== CASES.length || result.fail !== 0 || result.skip !== 0) {
        reasons.push(
          `cap ${cap}: ${result.pass} pass / ${result.fail} fail / ${result.skip} skip (want ${CASES.length}/0/0)`,
        );
      }
      for (const c of result.cases)
        if (c.result !== "pass") reasons.push(`cap ${cap}: "${c.fragment}" ${c.result}`);
    }
    md.push("| Case | Context | cap 40 | cap 150 | cap 1000 |", "|---|---|---|---|---|");
    for (const [fragment, kind] of CASES) {
      const cell = (cap: string) =>
        perCap[cap]?.cases.find((c) => c.fragment === fragment)?.result ?? "—";
      md.push(`| ${fragment} | ${kind} | ${cell("40")} | ${cell("150")} | ${cell("1000")} |`);
    }
    md.push(
      "",
      "FIXTURE cases use a permissive context (`require` no-op, `can` always true): they prove paging/search over real PostgREST, not authorization. Only PRINCIPAL-AUTHZ cases exercise the real membership → role → permission read.",
      "",
    );

    const probe = read("gate-caps", "embed-probe.json");
    md.push("### Embedded-permission truncation (independent probe)", "");
    if (probe === null || read("gate-caps", "embed-exit-code")?.trim() !== "0") {
      reasons.push("embed probe missing or failed");
      md.push("Probe missing or failed.", "");
    } else {
      const rows = (JSON.parse(probe) as { rows: Record<string, unknown>[] }).rows;
      md.push(
        "| cap | role | permissions (SQL) | embedded rows | truncated | products.read | products.view_cost |",
        "|---|---|---|---|---|---|---|",
        ...rows.map(
          (r) =>
            `| ${r.cap} | ${r.role} | ${r.permissionsInSql} | ${r.embeddedRows} | ${r.truncated ? "**yes**" : "no"} | ${r.hasProductsRead} | ${r.hasProductsViewCost} |`,
        ),
        "",
      );
    }
    sections.push({ name: "gate-caps", verdict: reasons.length ? "FAIL" : "PASS", reasons });
  }
}

// ── PostgREST gate: negative controls ────────────────────────────────────────
{
  const reasons: string[] = [];
  const code = exitCode("gate-negative-controls");
  const log = read("gate-negative-controls", "gate.log");
  md.push("## Negative controls (separate disposable checkout, cap 40)", "");
  if (code === null || log === null) {
    sections.push({ name: "negative-controls", verdict: "MISSING", reasons: ["no evidence"] });
    md.push("MISSING: the job left no evidence.", "");
  } else {
    if (code !== 0) reasons.push(`gate exited ${code}`);
    const lines = log.split("\n").filter((l) => l.includes("negative control (cap"));
    const caught = lines.filter((l) => /: CAUGHT$/.test(l.trim()));
    if (lines.length !== 8) reasons.push(`${lines.length} negative controls ran (want 8)`);
    if (caught.length !== 8) reasons.push(`${caught.length}/8 caught`);
    const clean = (read("gate-negative-controls", "worktree-status.txt") ?? "missing").trim();
    if (clean !== "") reasons.push(`checkout not restored after mutations: ${clean.slice(0, 200)}`);
    md.push(
      `Gate exit code: \`${code}\`; caught ${caught.length}/${lines.length}; checkout restored: ${clean === "" ? "yes" : "NO"}`,
      "",
    );
    md.push(...lines.map((l) => `- ${l.replace(/^\[catalog-postgrest-gate\] /, "")}`), "");
    sections.push({
      name: "negative-controls",
      verdict: reasons.length ? "FAIL" : "PASS",
      reasons,
    });
  }
}

// ── Mobile harness ───────────────────────────────────────────────────────────
{
  const reasons: string[] = [];
  const code = exitCode("mobile");
  const raw = read("mobile", "evidence", "results.json");
  md.push("## Mobile harness — production build, /app/products", "");
  if (code === null || raw === null) {
    sections.push({
      name: "mobile",
      verdict: "MISSING",
      reasons: ["no results.json or exit-code"],
    });
    md.push(`MISSING: exit code ${code}, results.json ${raw === null ? "absent" : "present"}.`, "");
  } else {
    type Check = {
      lang: string;
      width: number;
      name: string;
      ok: boolean;
      detail?: string;
      known?: string;
    };
    const results = JSON.parse(raw) as {
      checks: Check[];
      consoleErrors: string[];
      expectedFailures: string[];
    };
    const failed = results.checks.filter((c) => !c.ok);
    const unexpected = failed.filter((c) => !c.known);
    if (code !== 0) reasons.push(`harness exited ${code}`);
    if (results.checks.length !== 162) reasons.push(`${results.checks.length} checks (want 162)`);
    if (unexpected.length) reasons.push(`${unexpected.length} unexpected failures`);
    if (results.consoleErrors.length)
      reasons.push(`${results.consoleErrors.length} console errors`);

    // The four failures reported on #126: English UI, long Khmer name, every width.
    const NAME = "long name: every line of the Khmer name clears the price and the row edge";
    const reported = [320, 360, 390, 430].map((width) =>
      results.checks.find((c) => c.lang === "en" && c.width === width && c.name === NAME),
    );
    const reproduced = reported.filter((c) => c && !c.ok).length;
    const otherKnown = failed.filter((c) => c.known && !(c.lang === "en" && c.name === NAME));

    md.push(
      `Harness exit code: \`${code}\`; checks: ${results.checks.filter((c) => c.ok).length}/${results.checks.length} passed; ` +
        `known pre-existing failures: ${failed.length - unexpected.length}; unexpected failures: ${unexpected.length}; ` +
        `console errors: ${results.consoleErrors.length}; deliberately aborted reads: ${results.expectedFailures.length}`,
      "",
      "### The four previously reported failures (English UI, long Khmer name)",
      "",
      "| width | reproduced | detail |",
      "|---|---|---|",
      ...[320, 360, 390, 430].map((width, i) => {
        const c = reported[i];
        return `| ${width} | ${c ? (c.ok ? "no (passed)" : "**yes**") : "absent"} | ${c?.detail ?? ""} |`;
      }),
      "",
      `Reproduced ${reproduced}/4. Khmer UI, same check: ${results.checks
        .filter((c) => c.lang === "km" && c.name === NAME)
        .map((c) => `${c.width}:${c.ok ? "pass" : "FAIL"}`)
        .join(" ")}.`,
      "",
    );
    if (otherKnown.length) reasons.push(`${otherKnown.length} other checks marked known`);
    if (unexpected.length) {
      md.push(
        "### Unexpected failures",
        "",
        ...unexpected.map((c) => `- ${c.lang}@${c.width} ${c.name}: ${c.detail ?? ""}`),
        "",
      );
    }
    if (results.consoleErrors.length) {
      md.push("### Console errors", "", ...results.consoleErrors.map((e) => `- \`${e}\``), "");
    }

    // Fonts at every measurement and screenshot (font-observer.mjs).
    const fontLog = read("mobile", "fonts.jsonl");
    md.push("### Browser and web fonts", "");
    if (fontLog === null) {
      reasons.push("no font log");
      md.push("No font log.", "");
    } else {
      const entries = fontLog
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, any>);
      const browser = entries.find((e) => e.kind === "browser");
      const observed = entries.filter((e) => e.kind === "evaluate" || e.kind === "screenshot");
      const remeasured = entries.filter((e) => e.kind === "long-name-remeasure");
      // Kantumruy Pro leads the stack and has its own Latin subset, so Plus
      // Jakarta Sans may rightly never load; it is reported, not required.
      const ready = (e: Record<string, any>) =>
        !e.error && e.status === "loaded" && (!e.hasKhmerText || e.kantumruyLoaded > 0);
      const notReady = observed.filter((e) => !ready(e));
      const shots = observed.filter((e) => e.kind === "screenshot");
      md.push(
        `Browser: ${browser?.version ?? "unknown"} (${browser?.executablePath ?? "?"})`,
        "",
        `Font state observed at ${observed.length} points (${shots.length} screenshots): ` +
          `${observed.length - notReady.length} with document.fonts loaded and (on Khmer text) a Kantumruy Pro face loaded; ${notReady.length} not. ` +
          `Plus Jakarta Sans faces loaded at ${observed.filter((e) => e.jakartaLoaded > 0).length} of them.`,
        "",
      );
      if (notReady.length) {
        reasons.push(`fonts not ready at ${notReady.length} observed points`);
        // Where each one sits: the next screenshot the harness took after it.
        const nextShot = (e: Record<string, any>) =>
          observed.slice(observed.indexOf(e) + 1).find((n) => n.kind === "screenshot")?.file ??
          "none";
        md.push(
          ...notReady
            .slice(0, 40)
            .map(
              (e) =>
                `- ${e.kind} ${e.file ?? ""} ${e.lang ?? ""}@${e.viewport?.width ?? "?"} (next screenshot: ${nextShot(e)}): status=${e.status} kantumruy=${e.kantumruyLoaded} jakarta=${e.jakartaLoaded} ${e.error ?? ""}`,
            ),
          "",
        );
      }
      // Supplemental, never part of the verdict: the harness's long-name check
      // repeated read-only at the list screenshot (font-observer.mjs).
      md.push(
        "### Supplemental: long-Khmer-name check repeated at the list screenshot",
        "",
        "Read-only, moments after the harness's own measurement on the same page. It does not change any verdict above.",
        "",
        "| lang@width | fonts | Kantumruy faces loaded | result |",
        "|---|---|---|---|",
        ...remeasured.map(
          (e) =>
            `| ${e.lang ?? "?"}@${e.viewport?.width ?? "?"} | ${e.status ?? "?"} | ${e.kantumruyLoaded ?? "?"} | ${e.error ?? (e.overrun === "" ? "clears price and row" : `**${e.overrun}**`)} |`,
        ),
        "",
      );
      if (remeasured.length !== 8)
        reasons.push(`${remeasured.length} long-name re-measurements (want 8)`);
      if (!browser) reasons.push("browser version not recorded");
    }
    const screenshots = existsSync(path.join(inDir, "mobile", "evidence"))
      ? readdirSync(path.join(inDir, "mobile", "evidence")).filter((f) => f.endsWith(".png"))
      : [];
    md.push(`Screenshots: ${screenshots.length} (in the \`pr126-mobile\` artifact).`, "");
    sections.push({ name: "mobile", verdict: reasons.length ? "FAIL" : "PASS", reasons });
  }
}

// ── Provenance ───────────────────────────────────────────────────────────────
md.push("## Provenance", "");
for (const job of ["gate-caps", "gate-negative-controls", "mobile"]) {
  const provenance = read(job, "provenance.txt");
  md.push(`### ${job}`, "", "```", (provenance ?? "missing").trim(), "```", "");
}

const allPass = sections.length === 3 && sections.every((s) => s.verdict === "PASS");
const head = [
  "# PR #126 verification — summary",
  "",
  `Overall: **${allPass ? "PASS" : "NOT PASS"}**`,
  "",
  "| Section | Verdict | Reasons |",
  "|---|---|---|",
  ...sections.map((s) => `| ${s.name} | ${s.verdict} | ${s.reasons.join("; ")} |`),
  "",
  "A mobile PASS allows exactly the failures the harness itself marks as pre-existing on main; they are listed above, not hidden.",
  "",
];
writeFileSync(path.join(outDir, "summary.md"), [...head, ...md].join("\n"));
writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ allPass, sections }, null, 2));
console.info([...head, ...md].join("\n"));
process.exit(allPass ? 0 : 1);
