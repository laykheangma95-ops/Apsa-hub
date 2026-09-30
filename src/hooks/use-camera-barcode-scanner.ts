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

    let cancelled = false;
    const readStatus = (): CameraScanStatus => statusRef.current;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const release = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      const video = videoRef.current;
      if (video) video.srcObject = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        release();
        dispatch({ type: "hidden" });
      }
    };

    dispatch({ type: "start" });
    document.addEventListener("visibilitychange", onVisibility);

    void (async () => {
      // getUserMedia exists only in a secure context (HTTPS / localhost).
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        dispatch({ type: "fail", reason: "unsupported" });
        return;
      }
      try {
        const [media, decode] = await Promise.all([
          navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              facingMode: { ideal: "environment" },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
          }),
          createFrameDecoder(),
        ]);
        if (cancelled || statusRef.current.kind !== "starting") {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = media;
        const video = videoRef.current;
        if (!video) throw Object.assign(new Error("video_unavailable"), { name: "AbortError" });
        video.srcObject = media;
        // iOS Safari only plays inline, muted, after an explicit play().
        video.setAttribute("playsinline", "true");
        video.muted = true;
        await video.play();
        if (cancelled) return;
        dispatch({ type: "ready" });

        const tick = async () => {
          if (cancelled || statusRef.current.kind !== "scanning") return;
          const v = videoRef.current;
          if (v && v.readyState >= 2) {
            try {
              const raw = await decode(v);
              if (cancelled) return;
              if (raw !== null) dispatch({ type: "decoded", raw });
            } catch {
              // A single bad frame is not a failure; the next one is the retry.
            }
          }
          // Re-read through a function: the dispatch above may have moved it.
          const after = readStatus();
          if (after.kind === "detected") {
            release();
            return;
          }
          if (!cancelled && after.kind === "scanning") {
            timer = setTimeout(() => void tick(), FRAME_INTERVAL_MS);
          }
        };
        void tick();
      } catch (err) {
        release();
        if (!cancelled) dispatch({ type: "fail", reason: classifyCameraError(err) });
      }
    })();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      release();
    };
  }, [active, attempt, dispatch]);

  const retry = useCallback(() => {
    // Return to idle so the effect's own `start` is accepted, then re-run it.
    dispatch({ type: "stop" });
    setAttempt((n) => n + 1);
  }, [dispatch]);

  return { status, videoRef, retry };
}
