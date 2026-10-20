/**
 * The Conversation composer's reply-lifecycle rules (src/lib/conversation/
 * reply-session.ts) — pure. The mounted proof is telegram-reply-mounted.
 */
import { describe, expect, it } from "bun:test";
import {
  hasUnresolvedOutbound,
  reconcileThreadMessages,
  replyCompletion,
  sameScope,
} from "@/lib/conversation/reply-session";
import type { Message } from "@/types";

const msg = (id: string, state: Message["state"], direction: Message["direction"] = "outbound") =>
  ({ id, direction, body: id, at: "2026-10-20T00:00:00Z", state }) as Message;

describe("reconcileThreadMessages", () => {
  it("a snapshot fetched after the append replaces the appended row", () => {
    const merged = reconcileThreadMessages([], [msg("m1", "failed")], 200, [
      { message: msg("m1", "sending"), receivedAt: 100 },
    ]);
    expect(merged.map((m) => m.state)).toEqual(["failed"]);
  });

  it("an older snapshot never replaces a newer send result", () => {
    const merged = reconcileThreadMessages([], [msg("m1", "sending")], 100, [
      { message: msg("m1", "sent"), receivedAt: 200 },
    ]);
    expect(merged.map((m) => m.state)).toEqual(["sent"]);
  });

  it("keeps order: older pages, server thread, then appended-only rows", () => {
    const merged = reconcileThreadMessages([msg("o1", "sent")], [msg("s1", "sent")], 100, [
      { message: msg("a1", "sending"), receivedAt: 50 },
    ]);
    expect(merged.map((m) => m.id)).toEqual(["o1", "s1", "a1"]);
  });
});

describe("hasUnresolvedOutbound", () => {
  it("only outbound 'sending' counts", () => {
    expect(hasUnresolvedOutbound([msg("a", "sending")])).toBe(true);
    expect(hasUnresolvedOutbound([msg("a", "sending", "inbound")])).toBe(false);
    expect(hasUnresolvedOutbound([msg("a", "failed"), msg("b", "sent")])).toBe(false);
  });
});

describe("replyCompletion", () => {
  const base = {
    submittedBody: "hello",
    currentDraft: "hello",
    key: "k1",
    currentKey: "k1",
    resultState: "sent" as Message["state"],
    failed: false,
  };
  it("a terminal sent of this key clears draft and key", () => {
    expect(replyCompletion(base)).toEqual({ clearDraft: true, clearKey: true });
  });
  it("a newer draft survives", () => {
    expect(replyCompletion({ ...base, currentDraft: "new text" })).toEqual({
      clearDraft: false,
      clearKey: true,
    });
  });
  it("a newer key survives (and so does its draft)", () => {
    expect(replyCompletion({ ...base, currentKey: "k2" })).toEqual({
      clearDraft: false,
      clearKey: false,
    });
  });
  it("'sending' (a replay in flight) and failures keep both", () => {
    expect(replyCompletion({ ...base, resultState: "sending" })).toEqual({
      clearDraft: false,
      clearKey: false,
    });
    expect(replyCompletion({ ...base, resultState: "failed", failed: true })).toEqual({
      clearDraft: false,
      clearKey: false,
    });
  });
});

describe("sameScope", () => {
  const scope = { userId: "u", organizationId: "o", conversationId: "c", operation: 1 };
  it("matches only an identical member, organization, conversation and operation", () => {
    expect(sameScope(scope, { ...scope })).toBe(true);
    for (const change of [
      { userId: "u2" },
      { organizationId: "o2" },
      { conversationId: "c2" },
      { operation: 2 },
    ]) {
      expect(sameScope(scope, { ...scope, ...change })).toBe(false);
    }
  });
});
