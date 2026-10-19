/**
 * Spawns src/tests/delivery-transition-principal-mounted.runtime.ts in its own
 * process: it registers happy-dom globals and module mocks that must not leak
 * into the rest of the suite, and builds a PGlite database from every
 * migration.
 *
 * Run: bun test src/tests/delivery-transition-principal-mounted.test.ts
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("Delivery transitions run as the principal that started them, and their answers stay with it", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/delivery-transition-principal-mounted.runtime.ts")],
    { cwd: process.cwd(), encoding: "utf8", timeout: 600000 },
  );
  if (result.status !== 0) {
    // Bun truncates a long console argument: write each failing case and the
    // lines before it (its error and diff), in full and without React's
    // stack-frame noise.
    const lines = `${result.stdout}\n${result.stderr}`
      .split("\n")
      .filter((line) => !line.includes("react-stack-top-frame"));
    const keep = new Set<number>();
    lines.forEach((line, i) => {
      if (/^\(fail\)/.test(line)) for (let j = Math.max(0, i - 60); j <= i; j++) keep.add(j);
    });
    process.stderr.write(
      `${[...keep].map((i) => lines[i]).join("\n")}\n${String(result.error ?? "")}\n`,
    );
  }
  expect(result.status).toBe(0);
}, 610000);
