import { describe, expect, it } from "bun:test";

// DISPOSABLE: proves the CI failure summary/artifact path. Removed in the next commit.
describe("disposable CI check", () => {
  it("passes", () => expect(1).toBe(1));
  it("fails on purpose", () => expect(1).toBe(2));
});
