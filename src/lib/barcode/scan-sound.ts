/** A short, quiet checkout-style confirmation for an accepted scan. */
let audioContext: AudioContext | null = null;

export function playAcceptedScanSound(): void {
  if (typeof window === "undefined" || !window.AudioContext) return;

  try {
    const context = (audioContext ??= new window.AudioContext());
    // Some mobile browsers suspend audio until the user interacts with the page.
    if (context.state === "suspended") {
      void context
        .resume()
        .then(() => sound(context))
        .catch(() => {});
    } else {
      sound(context);
    }
  } catch {
    // Sound is optional feedback; a blocked audio device must never block a scan.
  }
}

function sound(context: AudioContext): void {
  if (context.state !== "running") return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const start = context.currentTime;

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(1050, start);
  oscillator.frequency.exponentialRampToValueAtTime(850, start + 0.085);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.1, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.09);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.095);
  oscillator.onended = () => {
    oscillator.disconnect();
    gain.disconnect();
  };
}
