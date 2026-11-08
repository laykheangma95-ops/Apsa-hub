/**
 * Accepted-scan sound: one shared AudioContext, prepared synchronously inside
 * a user gesture, ONE tone per accepted scan (also across audio recovery),
 * stale requests dropped, superseded recoveries inert, a bounded queue, and
 * never a throw or an unhandled rejection.
 *
 * Runs against a fake AudioContext with a controlled clock — no audio device,
 * and no claim about how a real phone's browser behaves.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  MAX_PENDING_TONES,
  SCAN_TONE_FRESH_MS,
  TONE_SPACING_S,
  pendingScanTonesForTests,
  playAcceptedScanSound,
  prepareScanSound,
  resetScanSoundForTests,
} from "@/lib/barcode/scan-sound";

type State = "running" | "suspended" | "interrupted" | "closed";
type ResumeMode = "resolve" | "reject" | "hold" | "throw" | "hold-reject";

const log: string[] = [];
let instances: FakeContext[] = [];
let resumeMode: ResumeMode = "resolve";
/** Held resume() calls, oldest first: settle them in any order. */
let held: Array<{ resolve: () => void; reject: () => void }> = [];
/** Start time (audio clock) of every tone, in order. */
let toneStarts: number[] = [];

class FakeNode {
  constructor(private readonly name: string) {}
  connect() {}
  disconnect() {}
  start(at?: number) {
    log.push(`${this.name}.start`);
    if (this.name === "oscillator") toneStarts.push(at ?? 0);
  }
  stop() {}
  onended: (() => void) | null = null;
}

class FakeContext {
  state: State;
  currentTime = 10;
  sampleRate = 44100;
  destination = {};
  static initialState: State = "suspended";
  constructor() {
    this.state = FakeContext.initialState;
    instances.push(this);
  }
  resume(): Promise<void> {
    log.push("resume");
    if (resumeMode === "throw") throw new Error("sync failure");
    if (resumeMode === "reject") return Promise.reject(new Error("NotAllowedError"));
    if (resumeMode === "hold" || resumeMode === "hold-reject")
      return new Promise((resolve, reject) => {
        held.push({
          resolve: () => {
            this.state = "running";
            resolve();
          },
          reject: () => reject(new Error("NotAllowedError")),
        });
      });
    this.state = "running";
    return Promise.resolve();
  }
  createOscillator() {
    log.push("tone");
    return Object.assign(new FakeNode("oscillator"), {
      type: "sine",
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
    });
  }
  createGain() {
    return Object.assign(new FakeNode("gain"), {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
    });
  }
  createBuffer() {
    return {};
  }
  createBufferSource() {
    log.push("silent-buffer");
    return Object.assign(new FakeNode("buffer"), { buffer: null as unknown });
  }
}

const g = globalThis as Record<string, unknown>;
// Other test files may run in this process with their own window: restore it.
const hadWindow = "window" in g;
const originalWindow = g.window;

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

let clock = 1000;
let clockSpy: ReturnType<typeof spyOn> | null = null;

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};
const tones = () => toneStarts.length;

beforeEach(() => {
  resetScanSoundForTests();
  log.length = 0;
  instances = [];
  held = [];
  toneStarts = [];
  unhandled = [];
  resumeMode = "resolve";
  FakeContext.initialState = "suspended";
  clock = 1000;
  clockSpy = spyOn(performance, "now").mockImplementation(() => clock);
  g.window = { AudioContext: FakeContext };
  process.on("unhandledRejection", onUnhandled);
});

afterEach(async () => {
  await flush();
  expect(unhandled).toEqual([]);
  if (hadWindow) g.window = originalWindow;
  else delete g.window;
  process.off("unhandledRejection", onUnhandled);
  clockSpy?.mockRestore();
  resetScanSoundForTests();
});

describe("SSR and missing audio", () => {
  it("does nothing, and does not throw, without a window", () => {
    delete g.window;
    expect(() => prepareScanSound()).not.toThrow();
    expect(() => playAcceptedScanSound()).not.toThrow();
    expect(instances).toHaveLength(0);
  });

  it("does nothing without any AudioContext", () => {
    g.window = {};
    expect(() => prepareScanSound()).not.toThrow();
    expect(() => playAcceptedScanSound()).not.toThrow();
  });

  it("uses webkitAudioContext where that is all there is", () => {
    g.window = { webkitAudioContext: FakeContext };
    prepareScanSound();
    expect(instances).toHaveLength(1);
  });

  it("a constructor that throws never escapes", () => {
    g.window = {
      AudioContext: class {
        constructor() {
          throw new Error("blocked");
        }
      },
    };
    expect(() => prepareScanSound()).not.toThrow();
    expect(() => playAcceptedScanSound()).not.toThrow();
  });
});

describe("prepare (inside the gesture) is never audible", () => {
  it("creates the context and calls resume() synchronously; no tone", async () => {
    prepareScanSound();
    // Synchronous: recorded before any await, so it runs inside the gesture.
    expect(log).toEqual(["resume", "silent-buffer", "buffer.start"]);
    await flush();
    expect(tones()).toBe(0);
  });

  it("repeated preparation, with no accepted scan, never plays a tone", async () => {
    resumeMode = "hold";
    for (let i = 0; i < 5; i++) prepareScanSound();
    for (const h of held) h.resolve();
    await flush();
    for (let i = 0; i < 5; i++) prepareScanSound();
    await flush();
    expect(tones()).toBe(0);
    expect(instances).toHaveLength(1);
  });

  it("an iOS 'interrupted' context is resumed too", () => {
    FakeContext.initialState = "interrupted";
    prepareScanSound();
    expect(log[0]).toBe("resume");
  });

  it("does nothing more once the context is running", () => {
    FakeContext.initialState = "running";
    prepareScanSound();
    expect(log).toEqual([]);
  });

  it("a rejected or throwing resume is absorbed", async () => {
    resumeMode = "reject";
    expect(() => prepareScanSound()).not.toThrow();
    resumeMode = "throw";
    clock += SCAN_TONE_FRESH_MS + 1;
    expect(() => prepareScanSound()).not.toThrow();
    await flush();
    expect(tones()).toBe(0);
  });
});

describe("one accepted scan → one tone", () => {
  it("three accepted scans on a running context: three tones, spaced, one context", () => {
    FakeContext.initialState = "running";
    for (let i = 0; i < 3; i++) playAcceptedScanSound();
    expect(tones()).toBe(3);
    expect(instances).toHaveLength(1);
    expect(toneStarts[1]! - toneStarts[0]!).toBeCloseTo(TONE_SPACING_S, 6);
    expect(toneStarts[2]! - toneStarts[1]!).toBeCloseTo(TONE_SPACING_S, 6);
  });

  it("three accepted scans while suspended, quick recovery: exactly three spaced tones", async () => {
    resumeMode = "hold";
    playAcceptedScanSound();
    clock += 50;
    playAcceptedScanSound();
    clock += 50;
    playAcceptedScanSound();
    // Recovery requested once, not once per scan.
    expect(log.filter((e) => e === "resume")).toHaveLength(1);
    expect(pendingScanTonesForTests()).toBe(3);
    clock += 50;
    held[0]!.resolve();
    await flush();
    expect(tones()).toBe(3);
    expect(toneStarts[1]! - toneStarts[0]!).toBeCloseTo(TONE_SPACING_S, 6);
    expect(toneStarts[2]! - toneStarts[1]!).toBeCloseTo(TONE_SPACING_S, 6);
    expect(pendingScanTonesForTests()).toBe(0);
  });

  it("prepare in the gesture, then accepted scans after recovery: one tone each", async () => {
    prepareScanSound();
    await flush();
    playAcceptedScanSound();
    playAcceptedScanSound();
    expect(instances).toHaveLength(1);
    expect(tones()).toBe(2);
  });

  it("each request is judged fresh on its own: only the young ones play", async () => {
    resumeMode = "hold";
    playAcceptedScanSound(); // t=1000
    clock += 300;
    playAcceptedScanSound(); // t=1300
    clock += 150; // t=1450: first is 450 ms old, second 150 ms
    held[0]!.resolve();
    await flush();
    expect(tones()).toBe(1);
  });

  it("recovery after the freshness deadline: zero delayed tones", async () => {
    resumeMode = "hold";
    playAcceptedScanSound();
    playAcceptedScanSound();
    clock += 5000; // e.g. iOS resumes on the user's NEXT unrelated tap
    held[0]!.resolve();
    await flush();
    expect(tones()).toBe(0);
    expect(pendingScanTonesForTests()).toBe(0);
  });

  it("a later unrelated tap (prepare) or Retry never releases a stale tone", async () => {
    resumeMode = "hold";
    playAcceptedScanSound();
    clock += 5000;
    prepareScanSound(); // a new attempt, from a later gesture
    for (const h of held) h.resolve();
    await flush();
    expect(tones()).toBe(0);
  });

  it("a later accepted scan plays only its own tone, never an earlier stale one", async () => {
    resumeMode = "hold";
    playAcceptedScanSound();
    clock += 5000;
    resumeMode = "resolve";
    playAcceptedScanSound();
    await flush();
    expect(tones()).toBe(1);
  });
});

describe("overlapping and superseded recoveries", () => {
  it("two overlapping resume attempts (prepare joins a live one): no duplicated tones", async () => {
    resumeMode = "hold";
    playAcceptedScanSound();
    prepareScanSound(); // gesture while the first recovery is still live
    playAcceptedScanSound();
    expect(held).toHaveLength(2);
    // Both resume() promises succeed; the attempt's two tones play once.
    held[1]!.resolve();
    held[0]!.resolve();
    await flush();
    expect(tones()).toBe(2);
  });

  it("an old recovery finishing after a newer one began cannot flush the new queue", async () => {
    resumeMode = "hold";
    playAcceptedScanSound(); // attempt 1
    clock += SCAN_TONE_FRESH_MS + 1; // attempt 1 abandoned
    playAcceptedScanSound(); // attempt 2 (its own request)
    playAcceptedScanSound();
    expect(held).toHaveLength(2);
    // The OLD promise settles first. The context is running now, but attempt 1
    // is superseded: it must neither play attempt 2's requests nor its own.
    held[0]!.resolve();
    await flush();
    expect(tones()).toBe(0);
    expect(pendingScanTonesForTests()).toBe(2);
    held[1]!.resolve();
    await flush();
    expect(tones()).toBe(2);
  });

  it("requests are not transferred to a new attempt", async () => {
    resumeMode = "hold";
    playAcceptedScanSound(); // attempt 1
    clock += SCAN_TONE_FRESH_MS + 1;
    prepareScanSound(); // attempt 2, no accepted scan of its own
    held[1]!.resolve();
    held[0]!.resolve();
    await flush();
    expect(tones()).toBe(0);
  });

  it("a recovery that is refused drops its requests and plays nothing later", async () => {
    resumeMode = "hold-reject";
    playAcceptedScanSound();
    playAcceptedScanSound();
    held[0]!.reject();
    await flush();
    expect(tones()).toBe(0);
    expect(pendingScanTonesForTests()).toBe(0);
    // The context is later resumed by something else: still nothing stale.
    instances[0]!.state = "running";
    prepareScanSound();
    await flush();
    expect(tones()).toBe(0);
  });

  it("a throwing resume drops the request; nothing escapes", async () => {
    resumeMode = "throw";
    expect(() => playAcceptedScanSound()).not.toThrow();
    await flush();
    expect(tones()).toBe(0);
    expect(pendingScanTonesForTests()).toBe(0);
  });

  it("an interruption mid-session: the next accepted scan waits for its own recovery", async () => {
    FakeContext.initialState = "running";
    playAcceptedScanSound();
    instances[0]!.state = "interrupted";
    resumeMode = "hold";
    playAcceptedScanSound();
    expect(tones()).toBe(1);
    held[0]!.resolve();
    await flush();
    expect(tones()).toBe(2);
  });
});

describe("queue bound and context lifecycle", () => {
  it(`at most ${MAX_PENDING_TONES} wait; the OLDEST is dropped, never merged`, async () => {
    resumeMode = "hold";
    for (let i = 0; i < MAX_PENDING_TONES + 2; i++) {
      playAcceptedScanSound();
      clock += 10;
    }
    expect(pendingScanTonesForTests()).toBe(MAX_PENDING_TONES);
    held[0]!.resolve();
    await flush();
    // Exactly the limit: one distinct tone per kept request.
    expect(tones()).toBe(MAX_PENDING_TONES);
    const gaps = toneStarts.slice(1).map((s, i) => s - toneStarts[i]!);
    for (const gap of gaps) expect(gap).toBeCloseTo(TONE_SPACING_S, 6);
  });

  it("which request is dropped at the limit is defined: the oldest", async () => {
    resumeMode = "hold";
    playAcceptedScanSound(); // t=1000 — will be dropped
    clock += 200;
    for (let i = 0; i < MAX_PENDING_TONES; i++) playAcceptedScanSound(); // t=1200
    clock += 250; // t=1450: the dropped one would now be stale; the rest are fresh
    held[0]!.resolve();
    await flush();
    expect(tones()).toBe(MAX_PENDING_TONES);
  });

  it("a closed context is replaced and its pending tones are discarded", async () => {
    resumeMode = "hold";
    playAcceptedScanSound();
    playAcceptedScanSound();
    instances[0]!.state = "closed";
    resumeMode = "resolve";
    playAcceptedScanSound(); // new context, its own request
    expect(instances).toHaveLength(2);
    await flush();
    expect(tones()).toBe(1);
    // The old context's resume finally settles: it can flush nothing.
    held[0]!.resolve();
    await flush();
    expect(tones()).toBe(1);
  });

  it("nothing is left waiting after recovery: no pending requests", async () => {
    resumeMode = "hold";
    playAcceptedScanSound();
    held[0]!.resolve();
    await flush();
    expect(pendingScanTonesForTests()).toBe(0);
  });
});
