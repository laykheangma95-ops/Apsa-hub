/**
 * A short, quiet checkout-style confirmation for an accepted scan.
 *
 * Sound is optional feedback: nothing here may throw, reject unhandled, or
 * delay a scan. One AudioContext serves the whole page.
 *
 * Mobile browsers (iOS Safari above all) only let audio start inside a user
 * gesture, and an accepted scan arrives after an asynchronous lookup — long
 * after the tap that opened the camera or the key event that ended a wedge
 * scan. So callers PREPARE the context synchronously inside that gesture
 * (prepareScanSound), which creates/resumes it and plays nothing audible; the
 * tone itself is played later, and only for an accepted scan
 * (playAcceptedScanSound).
 */

type AudioContextConstructor = new () => AudioContext;

/** A tone requested while the context was resuming plays only if it is still this fresh. */
const STALE_TONE_MS = 400;

let audioContext: AudioContext | null = null;
let toneQueuedAt: number | null = null;

function audioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as typeof window & { webkitAudioContext?: AudioContextConstructor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function context(): AudioContext | null {
  if (audioContext && audioContext.state === "closed") audioContext = null;
  if (audioContext) return audioContext;
  const Ctor = audioContextConstructor();
  if (!Ctor) return null;
  audioContext = new Ctor();
  return audioContext;
}

/**
 * Resume a context that is not running: "suspended" (autoplay policy) or
 * WebKit's non-standard "interrupted" (a call, Siri, the page backgrounded).
 * resume() is called synchronously so that, from a gesture, it runs inside
 * that gesture; its rejection is absorbed. Null when already running.
 */
function resume(ctx: AudioContext): Promise<void> | null {
  if ((ctx.state as string) === "running") return null;
  let resumed: Promise<void>;
  try {
    resumed = ctx.resume();
  } catch {
    return null;
  }
  return Promise.resolve(resumed).catch(() => {});
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Call synchronously from a trusted user action that starts scanning (the tap
 * that opens the camera, the key event that completes a wedge scan). Creates or
 * resumes the shared context so a later accepted-scan tone may play. Audible
 * output: none.
 */
export function prepareScanSound(): void {
  try {
    const ctx = context();
    if (!ctx || (ctx.state as string) === "running") return;
    void resume(ctx);
    // Older iOS only unlocks Web Audio once something has started inside the
    // gesture: a one-sample silent buffer.
    const source = ctx.createBufferSource();
    source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    source.connect(ctx.destination);
    source.start(0);
    source.onended = () => source.disconnect();
  } catch {
    // Unavailable or blocked audio never blocks scanning.
  }
}

/** One short confirmation tone. Call only once a scan has been accepted. */
export function playAcceptedScanSound(): void {
  try {
    const ctx = context();
    if (!ctx) return;
    if ((ctx.state as string) === "running") {
      tone(ctx);
      return;
    }
    const pending = resume(ctx);
    // Several scans accepted while resuming still produce one tone, and only
    // if the context comes back promptly — never a late beep on a later tap.
    if (!pending || toneQueuedAt !== null) return;
    toneQueuedAt = now();
    void pending.then(() => {
      const queuedAt = toneQueuedAt;
      toneQueuedAt = null;
      try {
        if (
          queuedAt !== null &&
          now() - queuedAt <= STALE_TONE_MS &&
          (ctx.state as string) === "running"
        ) {
          tone(ctx);
        }
      } catch {
        // see above
      }
    });
  } catch {
    // Sound is optional feedback; a blocked audio device must never block a scan.
  }
}

function tone(ctx: AudioContext): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  const start = ctx.currentTime;

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(1050, start);
  oscillator.frequency.exponentialRampToValueAtTime(850, start + 0.085);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.1, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.09);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.095);
  oscillator.onended = () => {
    oscillator.disconnect();
    gain.disconnect();
  };
}

/** Test seam: forget the shared context so each test starts clean. */
export function resetScanSoundForTests(): void {
  audioContext = null;
  toneQueuedAt = null;
}
