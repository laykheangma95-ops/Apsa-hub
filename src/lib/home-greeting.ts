/**
 * The time-of-day greeting in Home's header.
 *
 * Read on the Cambodia clock — the same calendar Home's "Today" is counted in
 * (src/server/home/service.ts) — never the browser's or the server's own zone,
 * so the server render and the first client render agree on the greeting.
 */
export type HomeGreetingKey = "home.greet.morning" | "home.greet.afternoon" | "home.greet.evening";

export function phnomPenhHour(now: Date): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Phnom_Penh",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(now);
  return Number(hour) % 24;
}

/** Morning 05:00–11:59, afternoon 12:00–17:59, evening otherwise. */
export function homeGreetingKey(now: Date): HomeGreetingKey {
  const hour = phnomPenhHour(now);
  if (hour >= 5 && hour < 12) return "home.greet.morning";
  if (hour >= 12 && hour < 18) return "home.greet.afternoon";
  return "home.greet.evening";
}
