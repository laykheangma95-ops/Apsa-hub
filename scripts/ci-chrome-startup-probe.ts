/**
 * DISPOSABLE CI probe (to be removed before merge): measures how long the
 * browser the parcel-label layout test would pick takes to print its DevTools
 * endpoint on a fresh runner — the first (cold) launch, then warm launches —
 * and where the time goes. Results are emitted as ::notice annotations.
 *
 * Usage: bun scripts/ci-chrome-startup-probe.ts <variant> <warmLaunches>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const variant = process.argv[2] ?? "current";
const warm = Number(process.argv[3] ?? "3");

const candidates = [
  process.env["APSA_CHROME_PATH"],
  process.env["CHROME_PATH"],
  process.env["PLAYWRIGHT_BROWSERS_PATH"]
    ? path.join(process.env["PLAYWRIGHT_BROWSERS_PATH"], "chromium")
    : undefined,
  "/opt/pw-browsers/chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];
const browser = candidates.find((c) => c && fs.existsSync(c))!;

const BASE = [
  "--headless=new",
  "--remote-debugging-port=0",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--mute-audio",
];
const QUIET = [
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-breakpad",
  "--no-service-autorun",
  "--password-store=basic",
  "--use-mock-keychain",
  "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider",
];

function read(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function psi(kind: string): string {
  return read(`/proc/pressure/${kind}`).split("\n")[0]?.replace(/ total=\d+/, "") ?? "";
}

/** Sum utime+stime (ticks) and major faults over the process tree rooted at pid. */
function treeStats(root: number) {
  let majflt = 0;
  let cpuTicks = 0;
  let readBytes = 0;
  let procs = 0;
  const children = new Map<number, number[]>();
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = read(`/proc/${entry}/stat`);
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(after[1]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(Number(entry));
  }
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift()!;
    const stat = read(`/proc/${pid}/stat`);
    if (!stat) continue;
    procs++;
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    majflt += Number(f[9]);
    cpuTicks += Number(f[11]) + Number(f[12]);
    readBytes += Number(read(`/proc/${pid}/io`).match(/^read_bytes: (\d+)/m)?.[1] ?? 0);
    queue.push(...(children.get(pid) ?? []));
  }
  return { procs, majflt, cpuMs: cpuTicks * 10, readMB: Math.round(readBytes / 1e6) };
}

async function launch(label: string) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
  const args = [...BASE, ...(variant === "quiet" ? QUIET : []), `--user-data-dir=${profile}`];
  const psiBefore = { io: psi("io"), cpu: psi("cpu") };
  const t0 = performance.now();
  const child = Bun.spawn([browser, ...args], { stdout: "ignore", stderr: "pipe" });
  const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let ready = -1;
  let stats = treeStats(child.pid);
  const timer = setInterval(() => (stats = treeStats(child.pid)), 500);
  const deadline = setTimeout(() => child.kill("SIGKILL"), 90_000);
  let buf = "";
  while (ready < 0) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const ms = Math.round(performance.now() - t0);
      lines.push(`+${ms}ms ${line.replace(/^\[[^\]]*\]\s*/, "").slice(0, 90)}`);
      if (line.includes("ws://")) ready = ms;
    }
  }
  clearInterval(timer);
  clearTimeout(deadline);
  stats = treeStats(child.pid);
  const summary =
    `${label} variant=${variant} ready=${ready}ms procs=${stats.procs} cpu=${stats.cpuMs}ms ` +
    `majflt=${stats.majflt} readMB=${stats.readMB} ` +
    `psiIO[before]=${psiBefore.io} psiIO[after]=${psi("io")} psiCPU[after]=${psi("cpu")} ` +
    `load=${os.loadavg().map((l) => l.toFixed(2)).join("/")}`;
  console.log(summary);
  console.log(lines.join("\n"));
  console.log(`::notice title=${label} ${ready}ms::${summary} | ${lines.slice(0, 14).join(" | ")}`);
  child.kill("SIGKILL");
  await child.exited;
  fs.rmSync(profile, { recursive: true, force: true });
}

console.log(
  `::notice title=runner::image=${process.env["ImageOS"]} ${process.env["ImageVersion"]} ` +
    `browser=${browser} -> ${fs.realpathSync(browser)} cpus=${os.cpus().length} ` +
    `mem=${Math.round(os.totalmem() / 1e9)}GB uptime=${Math.round(os.uptime())}s`,
);
if (variant === "prewarm") {
  // Sequentially read every file in the browser's install directory so the
  // launch below finds them in the page cache instead of faulting them in.
  const dir = path.dirname(fs.realpathSync(browser));
  const t0 = performance.now();
  let bytes = 0;
  let files = 0;
  const buf = Buffer.allocUnsafe(1 << 20);
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const fd = fs.openSync(p, "r");
        let n: number;
        while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) bytes += n;
        fs.closeSync(fd);
        files++;
      }
    }
  };
  walk(dir);
  const ms = Math.round(performance.now() - t0);
  console.log(`::notice title=prewarm ${ms}ms::dir=${dir} files=${files} MB=${Math.round(bytes / 1e6)} ms=${ms} psiIO=${psi("io")}`);
}
await launch("cold");
for (let i = 1; i <= warm; i++) await launch(`warm${i}`);
const version = Bun.spawnSync([browser, "--version"]).stdout.toString().trim();
console.log(`::notice title=version::${version}`);
