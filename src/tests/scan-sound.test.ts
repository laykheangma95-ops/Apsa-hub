/**
 * Accepted-scan sound: one shared AudioContext, prepared synchronously inside
 * a user gesture, tone only on request, and never a throw or an unhandled
 * rejection. Runs against a fake AudioContext — no audio device, and no claim
 * about how a real phone's browser behaves.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  playAcceptedScanSound,
  prepareScanSound,
  resetScanSoundForTests,
} from "@/lib/barcode/scan-sound";

type State = "running" | "suspended" | "interrupted" | "closed";

const log: string[] = [];
let instances: FakeContext[] = [];
let resumeBehaviour: "resolve" | "reject" | "hold" | "throw" = "resolve";
let holds: Array<() => void> = [];

class FakeNode {
  constructor(private readonly name: string) {}
  connect() {}
  disconnect() {}
  start() {
    log.push(`${this.name}.start`);
  }
  stop() {}
  onended: (() => void) | null = null;
}

class FakeContext {
  state: State;
  currentTime = 0;
  sampleRate = 44100;
  destination = {};
  static initialState: State = "suspended";
  constructor() {
    this.state = FakeContext.initialState;
    instances.push(this);
  }
  resume(): Promise<void> {
    log.push("resume");
    if (resumeBehaviour === "throw") throw new Error("sync failure");
    if (resumeBehaviour === "reject") return Promise.reject(new Error("NotAllowedError"));
    if (resumeBehaviour === "hold")
      return new Promise((r) => {
        holds.push(() => {
          this.state = "running";
          r();
        });
      });
    this.state = "running";
    return Promise.resolve();
  }
  createOscillator() {
    log.push("tone");
    const node = new FakeNode("oscillator");
    return Object.assign(node, {
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

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const tones = () => log.filter((e) => e === "tone").length;

beforeEach(() => {
  resetScanSoundForTests();
  log.length = 0;
  instances = [];
  holds = [];
  unhandled = [];
  resumeBehaviour = "resolve";
  FakeContext.initialState = "suspended";
  g.window = { AudioContext: FakeContext };
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  if (hadWindow) g.window = originalWindow;
  else delete g.window;
  process.off("unhandledRejection", onUnhandled);
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

describe("prepare (inside the gesture)", () => {
  it("creates the context and calls resume() synchronously, with no audible tone", () => {
    prepareScanSound();
    // Synchronous: recorded before any await, so it runs inside the gesture.
    expect(log).toEqual(["resume", "silent-buffer", "buffer.start"]);
    expect(tones()).toBe(0);
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
    resumeBehaviour = "reject";
    expect(() => prepareScanSound()).not.toThrow();
    resumeBehaviour = "throw";
    expect(() => prepareScanSound()).not.toThrow();
    await flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toEqual([]);
  });
});

describe("accepted-scan tone", () => {
  it("plays one tone per call on a running context, all on ONE context", () => {
    FakeContext.initialState = "running";
    for (let i = 0; i < 5; i++) playAcceptedScanSound();
    expect(tones()).toBe(5);
    expect(instances).toHaveLength(1);
  });

  it("prepare then play: one context, one tone", async () => {
    prepareScanSound();
    await flush();
    playAcceptedScanSound();
    expect(instances).toHaveLength(1);
    expect(tones()).toBe(1);
  });

  it("a suspended context that resumes promptly plays the tone once", async () => {
    playAcceptedScanSound();
    expect(tones()).toBe(0);
    await flush();
    expect(tones()).toBe(1);
  });

  it("several accepted scans while resuming produce one tone, not a burst", async () => {
    resumeBehaviour = "hold";
    playAcceptedScanSound();
    playAcceptedScanSound();
    playAcceptedScanSound();
    for (const release of holds) release();
    await flush();
    expect(tones()).toBe(1);
  });

  it("a resume that is refused plays nothing and leaks no rejection", async () => {
    resumeBehaviour = "reject";
    playAcceptedScanSound();
    await flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(tones()).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it("a resume that only completes much later never plays a stale tone", async () => {
    resumeBehaviour = "hold";
    let t = 1000;
    const now = spyOn(performance, "now").mockImplementation(() => t);
    try {
      playAcceptedScanSound();
      t += 5000; // e.g. iOS resumes on the user's NEXT unrelated tap
      for (const release of holds) release();
      await flush();
      expect(tones()).toBe(0);
    } finally {
      now.mockRestore();
    }
  });

  it("a closed context is replaced, not reused", () => {
    FakeContext.initialState = "running";
    playAcceptedScanSound();
    instances[0]!.state = "closed";
    playAcceptedScanSound();
    expect(instances).toHaveLength(2);
    expect(tones()).toBe(2);
  });
});
