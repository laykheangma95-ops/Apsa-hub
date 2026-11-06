/**
 * A short, quiet checkout-style confirmation for an accepted scan.
 *
 * Sound is optional feedback: nothing here may throw, reject unhandled, or
 * delay a scan, and no accepted business operation depends on it. One
 * AudioContext serves the whole page.
 *
 * ── Activation ───────────────────────────────────────────────────────────────
 * Mobile browsers (iOS Safari above all) only let audio start inside a user
 * gesture, and an accepted scan arrives after an asynchronous lookup — long
 * after the tap that opened the camera or the key event that ended a wedge
 * scan. So callers PREPARE the context synchronously inside that gesture
 * (prepareScanSound), which creates/resumes it and plays nothing audible; the
 * tone itself is played later, and only for an accepted scan
 * (playAcceptedScanSound).
 *
 * ── One accepted scan → one tone ────────────────────────────────────────────
 * Running context: the tone is scheduled at once. Tones are spaced
 * TONE_SPACING_S apart on the audio clock, so three scans accepted together
 * are three audible confirmations, not one overlapping blip. No JS timers.
 *
 * Suspended or WebKit "interrupted" context: each accepted scan becomes its
 * own pending request (id + its own timestamp) tagged with the RECOVERY
 * ATTEMPT it waits on. Recovery (ctx.resume()) is requested once per attempt;
 * scans accepted meanwhile join that attempt. When the attempt succeeds, each
 * of its still-fresh requests plays, spaced as above.
 *
 * - Freshness: a request older than SCAN_TONE_FRESH_MS when its recovery
 *   completes is dropped on its own — so a late resume (e.g. iOS resuming on a
 *   later, unrelated tap, Retry or scan) never plays an old confirmation.
 * - Attempts: an attempt that has not succeeded within SCAN_TONE_FRESH_MS is
 *   abandoned; the next accepted scan or preparation starts a new attempt. A
 *   superseded attempt's promise, when it finally settles, is ignored — it can
 *   neither flush the newer attempt's requests nor replay its own. Requests
 *   are never transferred between attempts.
 * - Bound: at most MAX_PENDING_TONES requests wait at once. When full, the
 *   OLDEST waiting request is dropped (it is closest to going stale) and the
 *   new one is kept. Requests are never merged into one tone.
 * - A failed recovery drops its requests. A closed or replaced context drops
 *   everything pending, and its attempts can no longer flush anything.
 */

type AudioContextConstructor = new () => AudioContext;

/** A pending tone older than this when audio recovers is dropped. */
export const SCAN_TONE_FRESH_MS = 400;
/** Most accepted-scan tones that may wait for audio recovery at once. */
export const MAX_PENDING_TONES = 4;
/** Start-to-start separation of consecutive tones, in seconds (tone ≈ 0.095 s). */
export const TONE_SPACING_S = 0.14;

interface PendingTone {
  id: number;
  requestedAt: number;
  attempt: number;
}

let audioContext: AudioContext | null = null;
let pending: PendingTone[] = [];
/** Id of the newest recovery attempt; earlier attempts are superseded. */
let attempt = 0;
/** Whether `attempt` is still waiting to succeed, and since when. */
let attemptOpen = false;
let attemptStartedAt = 0;
let nextToneId = 0;
/** Audio-clock time at which the next tone may start. */
let nextStartAt = 0;

function audioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as typeof window & { webkitAudioContext?: AudioContextConstructor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function isRunning(ctx: AudioContext): boolean {
  return (ctx.state as string) === "running";
}

/** Forget every pending request and make every earlier attempt inert. */
function dropAll(): void {
  pending = [];
  attempt += 1;
  attemptOpen = false;
  nextStartAt = 0;
}

function context(): AudioContext | null {
  if (audioContext && audioContext.state === "closed") {
    audioContext = null;
    dropAll();
  }
  if (audioContext) return audioContext;
  const Ctor = audioContextConstructor();
  if (!Ctor) return null;
  const created = new Ctor();
  dropAll();
  audioContext = created;
  return created;
}

function attemptIsLive(): boolean {
  return attemptOpen && now() - attemptStartedAt <= SCAN_TONE_FRESH_MS;
}

/**
 * Call ctx.resume() synchronously (so, from a gesture, it runs inside that
 * gesture) on behalf of attempt `id`. Only a resume that belongs to the
 * current attempt, on the current context, can complete it.
 */
function requestResume(ctx: AudioContext, id: number, primary: boolean): void {
  let resumed: Promise<void>;
  try {
    resumed = ctx.resume();
  } catch {
    if (primary) settle(ctx, id, false);
    return;
  }
  Promise.resolve(resumed).then(
    () => settle(ctx, id, true),
    () => {
      if (primary) settle(ctx, id, false);
    },
  );
}

/**
 * Open a new recovery attempt. Requests still waiting on an earlier attempt
 * are dropped, never moved onto this one: that attempt is superseded and can
 * no longer play them.
 */
function startAttempt(ctx: AudioContext): number {
  attempt += 1;
  attemptOpen = true;
  attemptStartedAt = now();
  pending = pending.filter((p) => p.attempt === attempt);
  const id = attempt;
  requestResume(ctx, id, true);
  return id;
}

function settle(ctx: AudioContext, id: number, ok: boolean): void {
  try {
    // A superseded attempt, a replaced context, or an attempt already done.
    if (ctx !== audioContext || id !== attempt || !attemptOpen) return;
    attemptOpen = false;
    const mine = pending.filter((p) => p.attempt === id);
    pending = pending.filter((p) => p.attempt !== id);
    if (!ok || !isRunning(ctx)) return;
    const t = now();
    for (const request of mine) {
      if (t - request.requestedAt <= SCAN_TONE_FRESH_MS) tone(ctx);
    }
  } catch {
    // Optional feedback only.
  }
}

/**
 * Call synchronously from a trusted user action that starts scanning (the tap
 * that opens the camera, Retry, a manual submit, the key event that completes
 * a wedge scan). Creates or resumes the shared context so a later
 * accepted-scan tone may play. Audible output: none.
 */
export function prepareScanSound(): void {
  try {
    const ctx = context();
    if (!ctx || isRunning(ctx)) return;
    // Join a live attempt (its requests stay its own), or open a new one.
    if (attemptIsLive()) requestResume(ctx, attempt, false);
    else startAttempt(ctx);
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

/** One short confirmation tone. Call exactly once per accepted scan. */
export function playAcceptedScanSound(): void {
  try {
    const ctx = context();
    if (!ctx) return;
    if (isRunning(ctx)) {
      tone(ctx);
      return;
    }
    const id = attemptIsLive() ? attempt : startAttempt(ctx);
    // The attempt may already have failed synchronously (resume() threw).
    if (id !== attempt || !attemptOpen) return;
    const t = now();
    pending = pending.filter((p) => p.attempt === id && t - p.requestedAt <= SCAN_TONE_FRESH_MS);
    if (pending.length >= MAX_PENDING_TONES) pending.shift();
    pending.push({ id: ++nextToneId, requestedAt: t, attempt: id });
  } catch {
    // Sound is optional feedback; a blocked audio device must never block a scan.
  }
}

function tone(ctx: AudioContext): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  const start = Math.max(ctx.currentTime, nextStartAt);
  nextStartAt = start + TONE_SPACING_S;

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

/** Test seam: how many tones are waiting for audio recovery. */
export function pendingScanTonesForTests(): number {
  return pending.length;
}

/** Test seam: forget the shared context and everything pending. */
export function resetScanSoundForTests(): void {
  audioContext = null;
  dropAll();
  nextToneId = 0;
}
