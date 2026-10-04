/**
 * Server-function transport — mutations are POST end to end.
 *
 * The behavioural checks (real TanStack client RPC path, real src/api
 * validators and handlers) run isolated in server-fn-post-transport.runtime.ts
 * because it replaces modules process-globally. This file spawns it, then pins
 * the installed-framework facts the APSA rule relies on, so a TanStack upgrade
 * that changes them fails here instead of silently.
 *
 * Run: bun test src/tests/server-fn-post-transport.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), "utf-8");

describe("server-function transport — behavioural (isolated runtime)", () => {
  it("passes the real client-RPC transport checks", async () => {
    const child = Bun.spawn(
      [process.execPath, "test", "./src/tests/server-fn-post-transport.runtime.ts"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, stderr).toBe(0);
  });
});

describe("installed TanStack Start facts the rule depends on", () => {
  const core = "node_modules/@tanstack/start-client-core/dist/esm";
  const server = "node_modules/@tanstack/start-server-core/dist/esm";

  it("an omitted createServerFn method defaults to GET", () => {
    expect(read(`${core}/createServerFn.js`)).toContain(
      'if (typeof resolvedOptions.method === "undefined") resolvedOptions.method = "GET";',
    );
  });

  it("a GET call puts its payload in the query string; a POST call in the body", () => {
    const fetcher = read(`${core}/client-rpc/serverFnFetcher.js`);
    expect(fetcher).toContain("encode({ payload: serializedPayload })");
    expect(fetcher).toMatch(
      /if \(first\.method === "POST"\) \{\s*body = await getFetchBody\(first\)/,
    );
  });

  it("the server refuses a request whose method differs from the declared one (405)", () => {
    expect(read(`${server}/server-functions-handler.js`)).toMatch(
      /if \(action\.method && methodUpper !== action\.method\) return new Response\(`expected \$\{action\.method\} method\. Got \$\{methodUpper\}`, \{\s*status: 405/,
    );
  });

  it("APSA keeps the CSRF middleware on every server function, whatever the method", () => {
    const start = read("src/start.ts");
    expect(start).toContain("createCsrfMiddleware({");
    expect(start).toContain('filter: (ctx) => ctx.handlerType === "serverFn"');
    expect(start).toMatch(/requestMiddleware: \[errorMiddleware, csrfMiddleware\]/);
    // The middleware rejects requests that carry no Sec-Fetch-Site/Origin/Referer
    // unless explicitly opted out — APSA never opts out.
    expect(start).not.toContain("allowRequestsWithoutOriginCheck");
  });
});
