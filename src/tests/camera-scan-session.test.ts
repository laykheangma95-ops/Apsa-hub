/**
 * Camera scan session — behavioural lifecycle tests.
 *
 * Root cause this covers: the scanner started with
 * `Promise.all([getUserMedia(...), createFrameDecoder()])`. When the camera was
 * granted but the decoder failed to load (ZXing chunk unreachable offline or
 * gone after a deploy, no canvas), the pair rejected after the stream had been
 * acquired — the stream was never stored, so nothing stopped it and the camera
 * light stayed on behind a "could not start" message. Each Try again could open
 * another.
 *
 * These drive the real startCameraSession (the body of the hook's effect) with
 * fake streams, video and decoders, and the real stepCameraScan state machine,
 * so each invariant is proven by what happens to the tracks and the frame loop,
 * not by what the source text says. The hook's effect cleanup calls
 * `session.stop()` for both sheet close and unmount, so both are one path here.
 *
 * Run: bun test src/tests/camera-scan-session.test.ts
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  initialCameraScanStatus,
  stepCameraScan,
  type CameraScanEvent,
  type CameraScanStatus,
} from "../lib/barcode/camera-scan";
import {
  startCameraSession,
  type CameraSession,
  type CameraStream,
  type CameraVideo,
} from "../hooks/use-camera-barcode-scanner";

// ── Fakes ────────────────────────────────────────────────────────────────────

interface FakeTrack {
  kind: "video" | "audio";
  stopped: number;
  stop(): void;
}

function fakeStream(): CameraStream & { tracks: FakeTrack[] } {
  // Two tracks so "every track" is proven, not just the first.
  const tracks: FakeTrack[] = (["video", "audio"] as const).map((kind) => ({
    kind,
    stopped: 0,
    stop() {
      this.stopped++;
    },
  }));
  return { tracks, getTracks: () => tracks };
}

function fakeVideo(overrides: Partial<CameraVideo> = {}): CameraVideo {
  return {
    srcObject: null,
    muted: false,
    readyState: 4,
    setAttribute() {},
    play: async () => {},
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const domError = (name: string) => Object.assign(new Error(name), { name });

type Decoder = (video: CameraVideo) => Promise<string | null>;

/**
 * The hook's state and dispatch, minus React: status lives in a ref-like slot,
 * dispatch runs the real state machine, emissions are recorded.
 */
function scanner() {
  let status: CameraScanStatus = initialCameraScanStatus;
  const emitted: string[] = [];
  const streams: Array<ReturnType<typeof fakeStream>> = [];
  const state = {
    get status() {
      return status;
    },
    emitted,
    streams,
    gumCalls: 0,
    decodeCalls: 0,
    dispatch(event: CameraScanEvent) {
      const step = stepCameraScan(status, event);
      status = step.status;
      if (step.emit !== null) emitted.push(step.emit);
    },
    /** Every stream ever handed out has every track stopped. */
    allTracksStopped() {
      return streams.every((s) => s.tracks.every((t) => t.stopped > 0));
    },
    liveTracks() {
      return streams.flatMap((s) => s.tracks).filter((t) => t.stopped === 0).length;
    },
    /** What the hook's effect does when the sheet opens (or Try again re-runs it). */
    open(opts: {
      createDecoder: () => Promise<Decoder>;
      getUserMedia?: () => Promise<CameraStream>;
      video?: CameraVideo | null;
      cameraAvailable?: boolean;
    }): CameraSession {
      state.dispatch({ type: "start" });
      const video = opts.video === undefined ? fakeVideo() : opts.video;
      return startCameraSession<CameraVideo>({
        cameraAvailable: opts.cameraAvailable ?? true,
        getUserMedia: async () => {
          state.gumCalls++;
          const stream = opts.getUserMedia ? await opts.getUserMedia() : fakeStream();
          streams.push(stream as ReturnType<typeof fakeStream>);
          return stream;
        },
        createDecoder: async () => {
          const decode = await opts.createDecoder();
          return async (v) => {
            state.decodeCalls++;
            return decode(v);
          };
        },
        getVideo: () => video,
        readStatus: () => status,
        dispatch: (e) => state.dispatch(e),
        frameIntervalMs: 1,
      });
    },
  };
  return state;
}

const noCode: Decoder = async () => null;

/** Assert the frame loop is not running: no decode happens across many intervals. */
async function expectLoopStopped(s: ReturnType<typeof scanner>) {
  const before = s.decodeCalls;
  await wait(30);
  expect(s.decodeCalls).toBe(before);
}

// ── The P1: decoder failure must never leave the camera on ──────────────────

describe("decoder failure (the camera-leak P1)", () => {
  it("a decoder that fails to load never opens the camera, so nothing can leak", async () => {
    const s = scanner();
    s.open({
      createDecoder: () => Promise.reject(domError("TypeError")), // chunk fetch failed
    });
    await flush();
    expect(s.gumCalls).toBe(0);
    expect(s.streams).toHaveLength(0);
    expect(s.status).toEqual({ kind: "failed", reason: "unsupported" });
    await expectLoopStopped(s);
  });

  it("a decoder that fails AFTER the camera would have been granted still leaves no live track", async () => {
    // The exact race the parallel start lost: the camera resolves first, the
    // decoder rejects later. Whatever order is used, no track may stay live.
    const s = scanner();
    const decoder = deferred<Decoder>();
    s.open({ createDecoder: () => decoder.promise });
    await flush();
    decoder.reject(domError("NotSupportedError")); // e.g. no 2D canvas
    await flush();
    expect(s.liveTracks()).toBe(0);
    expect(s.allTracksStopped()).toBe(true);
    expect(s.status.kind).toBe("failed");
    await expectLoopStopped(s);
  });

  it("a failure after the camera was acquired (play() rejects) stops every track", async () => {
    const s = scanner();
    const video = fakeVideo({ play: () => Promise.reject(domError("NotAllowedError")) });
    s.open({ createDecoder: async () => noCode, video });
    await flush();
    expect(s.gumCalls).toBe(1);
    expect(s.allTracksStopped()).toBe(true);
    expect(video.srcObject).toBeNull();
    expect(s.status).toEqual({ kind: "failed", reason: "denied" });
    await expectLoopStopped(s);
  });

  it("a missing video element after acquisition stops every track", async () => {
    const s = scanner();
    s.open({ createDecoder: async () => noCode, video: null });
    await flush();
    expect(s.gumCalls).toBe(1);
    expect(s.allTracksStopped()).toBe(true);
    expect(s.status.kind).toBe("failed");
  });

  it("Try again after a decoder failure starts exactly one new session", async () => {
    const s = scanner();
    const first = s.open({ createDecoder: () => Promise.reject(domError("TypeError")) });
    await flush();
    expect(s.status.kind).toBe("failed");

    // retry(): dispatch stop, then the effect re-runs (cleanup, then open).
    s.dispatch({ type: "stop" });
    first.stop();
    const second = s.open({ createDecoder: async () => noCode });
    await flush();
    expect(s.gumCalls).toBe(1);
    expect(s.streams).toHaveLength(1);
    expect(s.status.kind).toBe("scanning");
    expect(s.liveTracks()).toBe(2); // exactly one live stream (video + audio)

    second.stop();
    s.dispatch({ type: "stop" });
    expect(s.allTracksStopped()).toBe(true);
    await expectLoopStopped(s);
  });
});

// ── Permission / device failures ─────────────────────────────────────────────

describe("camera failures leak nothing", () => {
  it("permission denied: failed/denied, no stream, no loop", async () => {
    const s = scanner();
    s.open({
      createDecoder: async () => noCode,
      getUserMedia: () => Promise.reject(domError("NotAllowedError")),
    });
    await flush();
    expect(s.status).toEqual({ kind: "failed", reason: "denied" });
    expect(s.streams).toHaveLength(0);
    await expectLoopStopped(s);
  });

  it("insecure context / no mediaDevices: unsupported, camera never requested", async () => {
    const s = scanner();
    s.open({ createDecoder: async () => noCode, cameraAvailable: false });
    await flush();
    expect(s.status).toEqual({ kind: "failed", reason: "unsupported" });
    expect(s.gumCalls).toBe(0);
  });
});

// ── Close / unmount / background during startup ─────────────────────────────

describe("teardown during startup", () => {
  it("close (or unmount) while the camera request is pending stops the late stream", async () => {
    const s = scanner();
    const camera = deferred<CameraStream>();
    const session = s.open({
      createDecoder: async () => noCode,
      getUserMedia: () => camera.promise,
    });
    await flush();
    expect(s.gumCalls).toBe(1);

    session.stop(); // effect cleanup: sheet closed or component unmounted
    s.dispatch({ type: "stop" });
    const late = fakeStream();
    camera.resolve(late);
    await flush();

    expect(late.tracks.every((t) => t.stopped === 1)).toBe(true);
    expect(s.status.kind).toBe("idle");
    await expectLoopStopped(s);
    expect(s.decodeCalls).toBe(0);
  });

  it("unmount with no status change (effect cleanup only) still stops the late stream", async () => {
    // Unmount runs the cleanup but no later dispatch: `cancelled` alone must hold.
    const s = scanner();
    const camera = deferred<CameraStream>();
    const session = s.open({
      createDecoder: async () => noCode,
      getUserMedia: () => camera.promise,
    });
    await flush();
    session.stop();
    const late = fakeStream();
    camera.resolve(late);
    await flush();
    expect(late.tracks.every((t) => t.stopped === 1)).toBe(true);
    expect(s.status.kind).toBe("starting"); // nothing dispatched after unmount
    await expectLoopStopped(s);
  });

  it("close while the decoder is still loading never requests the camera", async () => {
    const s = scanner();
    const decoder = deferred<Decoder>();
    const session = s.open({ createDecoder: () => decoder.promise });
    session.stop();
    s.dispatch({ type: "stop" });
    decoder.resolve(noCode);
    await flush();
    expect(s.gumCalls).toBe(0);
    expect(s.status.kind).toBe("idle");
  });

  it("page hidden while the camera request is pending: paused, late stream stopped", async () => {
    const s = scanner();
    const camera = deferred<CameraStream>();
    const session = s.open({
      createDecoder: async () => noCode,
      getUserMedia: () => camera.promise,
    });
    await flush();
    session.hide();
    const late = fakeStream();
    camera.resolve(late);
    await flush();
    expect(s.status.kind).toBe("paused");
    expect(late.tracks.every((t) => t.stopped === 1)).toBe(true);
    await expectLoopStopped(s);
  });
});

// ── Running session: success and teardown unchanged ─────────────────────────

describe("running session", () => {
  it("success: emits once, releases the camera, stops decoding", async () => {
    const s = scanner();
    let frames = 0;
    const video = fakeVideo();
    s.open({
      createDecoder: async () => async () => (++frames >= 3 ? "8850123456789" : null),
      video,
    });
    await wait(40);
    expect(s.emitted).toEqual(["8850123456789"]);
    expect(s.status).toEqual({ kind: "detected", code: "8850123456789" });
    expect(s.allTracksStopped()).toBe(true);
    expect(video.srcObject).toBeNull();
    await expectLoopStopped(s);
  });

  it("a code on every frame still emits exactly once", async () => {
    const s = scanner();
    s.open({ createDecoder: async () => async () => "SKU-1" });
    await wait(40);
    expect(s.emitted).toEqual(["SKU-1"]);
    await expectLoopStopped(s);
  });

  it("close while scanning stops every track and the frame loop", async () => {
    const s = scanner();
    const video = fakeVideo();
    const session = s.open({ createDecoder: async () => noCode, video });
    await wait(15);
    expect(s.status.kind).toBe("scanning");
    expect(s.decodeCalls).toBeGreaterThan(0);
    session.stop();
    s.dispatch({ type: "stop" });
    expect(s.allTracksStopped()).toBe(true);
    expect(video.srcObject).toBeNull();
    await expectLoopStopped(s);
  });

  it("page hidden while scanning stops every track, pauses, and stops the loop", async () => {
    const s = scanner();
    const session = s.open({ createDecoder: async () => noCode });
    await wait(15);
    session.hide();
    expect(s.status.kind).toBe("paused");
    expect(s.allTracksStopped()).toBe(true);
    await expectLoopStopped(s);
  });

  it("a frame that throws is skipped, not fatal", async () => {
    const s = scanner();
    let n = 0;
    s.open({
      createDecoder: async () => async () => {
        n++;
        if (n === 1) throw new Error("bad frame");
        return n >= 3 ? "OK-1" : null;
      },
    });
    await wait(40);
    expect(s.emitted).toEqual(["OK-1"]);
    expect(s.allTracksStopped()).toBe(true);
  });
});

// ── Hook wiring: the effect uses this session for every exit path ───────────

describe("hook wiring", () => {
  const hook = readFileSync(
    join(import.meta.dir, "..", "hooks/use-camera-barcode-scanner.ts"),
    "utf8",
  );

  it("the effect starts one session and stops it in cleanup (close + unmount)", () => {
    expect(hook).toContain("const session = startCameraSession<HTMLVideoElement>({");
    expect(hook).toMatch(/return \(\) => \{[\s\S]*?session\.stop\(\);[\s\S]*?\};/);
    expect(hook).toContain("}, [active, attempt, dispatch]);");
  });

  it("the decoder is created before the camera is requested (no parallel start)", () => {
    expect(hook).not.toContain("Promise.all([\n          navigator.mediaDevices.getUserMedia");
    const body = hook.slice(hook.indexOf("export function startCameraSession"));
    expect(body.indexOf("await env.createDecoder()")).toBeGreaterThan(-1);
    expect(body.indexOf("await env.createDecoder()")).toBeLessThan(
      body.indexOf("await env.getUserMedia("),
    );
  });
});
