import { beforeEach, describe, expect, it, mock } from "bun:test";

function createServerFnMock() {
  return () => ({
    validator(validator: (data: unknown) => unknown) {
      return {
        handler<TArgs extends { data: unknown }, TResult>(handler: (args: { data: TArgs["data"] }) => TResult | Promise<TResult>) {
          return async ({ data }: TArgs) => handler({ data: validator(data) as TArgs["data"] });
        },
      };
    },
    handler<TResult>(handler: () => TResult | Promise<TResult>) { return handler; },
  });
}

let accessToken: string | undefined;
let refreshToken: string | undefined;
let refreshSession: {
  access_token: string; refresh_token: string;
  user: { id: string; email: string; email_confirmed_at: string | null };
} | null = null;
let writes: { name: string; options: Record<string, unknown> }[] = [];
let deleted: string[] = [];

mock.module("@tanstack/react-start", () => ({ createServerFn: createServerFnMock() }));
mock.module("@tanstack/react-start/server", () => ({
  getCookie: (name: string) => name === "sb-access-token" ? accessToken : refreshToken,
  setCookie: (name: string, _value: string, options: Record<string, unknown>) => writes.push({ name, options }),
  deleteCookie: (name: string) => deleted.push(name),
}));
mock.module("@/lib/supabase/server", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null }, error: new Error("expired") }) } }),
  createRefreshClient: () => ({ auth: { refreshSession: async () => ({ data: { session: refreshSession }, error: refreshSession ? null : new Error("expired") }) } }),
}));
const { getSessionFn } = await import("@/api/auth");

beforeEach(() => { accessToken = undefined; refreshToken = undefined; refreshSession = null; writes = []; deleted = []; });

describe("session public API", () => {
  it("returns null without cookies and writes secure persistent refresh cookies", async () => {
    await expect(getSessionFn()).resolves.toBeNull();
    expect(writes).toEqual([]);
    accessToken = "expired";
    refreshToken = "refresh";
    refreshSession = { access_token: "new-access", refresh_token: "new-refresh", user: { id: "user-1", email: "user@example.com", email_confirmed_at: "2026-01-01T00:00:00.000Z" } };
    await expect(getSessionFn()).resolves.toMatchObject({ userId: "user-1", emailVerified: true, accessToken: "new-access" });
    expect(writes.map((cookie) => cookie.name)).toEqual(["sb-access-token", "sb-refresh-token"]);
    for (const cookie of writes) {
      expect(cookie.options.httpOnly).toBe(true);
      expect(cookie.options.sameSite).toBe("lax");
      expect(cookie.options.path).toBe("/");
      expect(cookie.options.maxAge as number).toBeGreaterThan(0);
      expect(cookie.options.secure).toBe(process.env["NODE_ENV"] === "production");
    }
  });

  it("clears both cookies when refresh fails", async () => {
    accessToken = "expired";
    refreshToken = "refresh";
    await expect(getSessionFn()).resolves.toBeNull();
    expect(deleted).toEqual(["sb-access-token", "sb-refresh-token"]);
  });
});
