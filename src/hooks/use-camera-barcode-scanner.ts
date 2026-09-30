import { useCallback, useEffect, useRef, useState } from "react";
import {
  CAMERA_SCAN_FORMATS,
  chooseDecoderKind,
  classifyCameraError,
  initialCameraScanStatus,
  nativeFormatsToRequest,
  rgbaToLuminance,
  sampleSize,
  stepCameraScan,
  type CameraScanEvent,
  type CameraScanStatus,
} from "@/lib/barcode/camera-scan";

/**
 * Phone-camera barcode scanning (the device adapter).
 *
 * All decisions live in src/lib/barcode/camera-scan.ts (pure, unit-tested);
 * this hook only touches the device: it opens the rear camera, feeds frames to
 * a decoder, and releases the camera whenever scanning is not wanted — sheet
 * closed, component unmounted, page hidden, or a code found. A frozen preview
 * that keeps the camera light on is the failure it exists to prevent.
 *
 * Decoder: the platform BarcodeDetector where it genuinely supports the
 * formats (Chrome on Android), otherwise ZXing, loaded lazily so it never
 * weighs on the main bundle (iOS Safari has no BarcodeDetector).
 *
 * The decoded value is handed to `onDetected` exactly once per session; the
 * caller resolves it through the same org-scoped server lookup as a wedge scan.
 */

interface NativeDetector {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue?: string }>>;
}
interface NativeDetectorCtor {
  new (options: { formats: string[] }): NativeDetector;
  getSupportedFormats?: () => Promise<string[]>;
}

type FrameDecoder = (video: HTMLVideoElement) => Promise<string | null>;

/** Delay between decode attempts: fast enough to feel instant, light on battery. */
const FRAME_INTERVAL_MS = 160;

async function createFrameDecoder(): Promise<FrameDecoder> {
  const Native = (globalThis as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector;
  let supported: string[] = [];
  if (Native?.getSupportedFormats) {
    try {
      supported = await Native.getSupportedFormats();
    } catch {
      supported = [];
    }
  }

  if (
    Native &&
    chooseDecoderKind({ hasBarcodeDetector: true, supportedFormats: supported }) === "native"
  ) {
    const detector = new Native({ formats: nativeFormatsToRequest(supported) });
    return async (video) => {
      const found = await detector.detect(video);
      return (
        found.find((b) => typeof b.rawValue === "string" && b.rawValue.length > 0)?.rawValue ?? null
      );
    };
  }

  const [lib, { createZxingDecoder }] = await Promise.all([
    import("@zxing/library"),
    import("@/lib/barcode/zxing-decoder"),
  ]);
  const decoder = createZxingDecoder(lib, CAMERA_SCAN_FORMATS);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw Object.assign(new Error("canvas_unavailable"), { name: "NotSupportedError" });

  return async (video) => {
    const size = sampleSize(video.videoWidth, video.videoHeight);
    if (!size) return null;
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;
    ctx.drawImage(video, 0, 0, size.width, size.height);
    const { data } = ctx.getImageData(0, 0, size.width, size.height);
    return decoder.decode(rgbaToLuminance(data, size.width, size.height), size.width, size.height);
  };
}

// ── Camera session (startup, frame loop, release) ────────────────────────────

/** The slice of a MediaStream the session touches: its tracks, to stop them. */
export interface CameraStream {
  getTracks(): Array<{ stop(): void }>;
}

/** The slice of an HTMLVideoElement the session touches. */
export interface CameraVideo {
  srcObject: unknown;
  muted: boolean;
  readonly readyState: number;
  setAttribute(name: string, value: string): void;
  play(): Promise<void>;
}

/** Everything a session needs from the device, injected so tests can drive it. */
export interface CameraSessionEnv<V extends CameraVideo> {
  /** getUserMedia exists only in a secure context (HTTPS / localhost). */
  cameraAvailable: boolean;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<CameraStream>;
  createDecoder: () => Promise<(video: V) => Promise<string | null>>;
  getVideo: () => V | null;
  readStatus: () => CameraScanStatus;
  dispatch: (event: CameraScanEvent) => void;
  frameIntervalMs?: number;
}

export interface CameraSession {
  /** Page hidden: release the camera and pause (Try again restarts). */
  hide(): void;
  /** Sheet closed or component unmounted: release the camera, end the session. */
  stop(): void;
}

const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
};

/**
 * One scanning session: load the decoder, open the camera, run the frame loop,
 * and guarantee every acquired stream is stopped.
 *
 * The decoder is created BEFORE the camera is requested. When the two ran in
 * parallel, a decoder that failed to load (ZXing chunk unreachable offline or
 * gone after a deploy, no canvas) rejected the pair after getUserMedia had
 * already resolved — that stream was never stored, so nothing ever stopped it
 * and the camera light stayed on behind a "could not start" message. In this
 * order a decoder failure never touches the camera or asks for a permission it
 * could not use, and any stream that arrives after the session stopped wanting
 * it (closed, unmounted, hidden) is stopped on arrival.
 */
export function startCameraSession<V extends CameraVideo>(env: CameraSessionEnv<V>): CameraSession {
  let cancelled = false;
  let stream: CameraStream | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const interval = env.frameIntervalMs ?? FRAME_INTERVAL_MS;

  const stopTracks = (media: CameraStream) => media.getTracks().forEach((track) => track.stop());

  const release = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (stream) stopTracks(stream);
    stream = null;
    const video = env.getVideo();
    if (video) video.srcObject = null;
  };

  // Still wanted: not stopped, and not moved on by hide / stop / a failure.
  const stillStarting = () => !cancelled && env.readStatus().kind === "starting";

  void (async () => {
    if (!env.cameraAvailable) {
      env.dispatch({ type: "fail", reason: "unsupported" });
      return;
    }
    try {
      const decode = await env.createDecoder();
      if (!stillStarting()) return;
      const media = await env.getUserMedia(CAMERA_CONSTRAINTS);
      if (!stillStarting()) {
        stopTracks(media);
        return;
      }
      stream = media;
      const video = env.getVideo();
      if (!video) throw Object.assign(new Error("video_unavailable"), { name: "AbortError" });
      video.srcObject = media;
      // iOS Safari only plays inline, muted, after an explicit play().
      video.setAttribute("playsinline", "true");
      video.muted = true;
      await video.play();
      if (cancelled) return;
      env.dispatch({ type: "ready" });

      const tick = async () => {
        if (cancelled || env.readStatus().kind !== "scanning") return;
        const v = env.getVideo();
        if (v && v.readyState >= 2) {
          try {
            const raw = await decode(v);
            if (cancelled) return;
            if (raw !== null) env.dispatch({ type: "decoded", raw });
          } catch {
            // A single bad frame is not a failure; the next one is the retry.
          }
        }
        // Re-read through a function: the dispatch above may have moved it.
        const after = env.readStatus();
        if (after.kind === "detected") {
          release();
          return;
        }
        if (!cancelled && after.kind === "scanning") {
          timer = setTimeout(() => void tick(), interval);
        }
      };
      void tick();
    } catch (err) {
      release();
      if (!cancelled) env.dispatch({ type: "fail", reason: classifyCameraError(err) });
    }
  })();

  return {
    hide() {
      release();
      env.dispatch({ type: "hidden" });
    },
    stop() {
      cancelled = true;
      release();
    },
  };
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface UseCameraBarcodeScannerOptions {
  /** Whether the camera should be running (e.g. the scan sheet is open). */
  active: boolean;
  onDetected: (code: string) => void;
}

export interface UseCameraBarcodeScannerResult {
  status: CameraScanStatus;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Restart after a failure or pause. */
  retry: () => void;
}

export function useCameraBarcodeScanner({
  active,
  onDetected,
}: UseCameraBarcodeScannerOptions): UseCameraBarcodeScannerResult {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<CameraScanStatus>(initialCameraScanStatus);
  const statusRef = useRef<CameraScanStatus>(initialCameraScanStatus);
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  // Bumped to re-run the camera effect on Try again.
  const [attempt, setAttempt] = useState(0);

  const dispatch = useCallback((event: CameraScanEvent) => {
    const step = stepCameraScan(statusRef.current, event);
    statusRef.current = step.status;
    setStatus(step.status);
    if (step.emit !== null) onDetectedRef.current(step.emit);
  }, []);

  useEffect(() => {
    if (!active) {
      dispatch({ type: "stop" });
      return;
    }

    dispatch({ type: "start" });
    const session = startCameraSession<HTMLVideoElement>({
      cameraAvailable: window.isSecureContext && !!navigator.mediaDevices?.getUserMedia,
      getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
      createDecoder: createFrameDecoder,
      getVideo: () => videoRef.current,
      readStatus: () => statusRef.current,
      dispatch,
    });

    const onVisibility = () => {
      if (document.visibilityState === "hidden") session.hide();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      session.stop();
    };
  }, [active, attempt, dispatch]);

  const retry = useCallback(() => {
    // Return to idle so the effect's own `start` is accepted, then re-run it.
    dispatch({ type: "stop" });
    setAttempt((n) => n + 1);
  }, [dispatch]);

  return { status, videoRef, retry };
}
