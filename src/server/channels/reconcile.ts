/**
 * Telegram webhook reconciliation — migration 064 §2a. Server-only.
 *
 * Why it exists: Telegram's setWebhook / deleteWebhook carry no version, and a
 * request APSA sent can still be applied arbitrarily late (no Telegram
 * guarantee bounds it). A late deleteWebhook after a newer connect silences
 * the bot — no customer message arrives to reveal it. So every live
 * connection is re-checked on a schedule, independent of traffic.
 *
 *   worker     GET|POST /api/internal/channels/reconcile, authorized by
 *              `Authorization: Bearer $CRON_SECRET` (Vercel Cron's
 *              convention; any HTTPS scheduler can send it). No CRON_SECRET →
 *              503: reconciliation is off, never open. Intended cadence:
 *              every 5 minutes (RECONCILE_RUN_INTERVAL_MS documents it).
 *   ownership  none needed: claim_channel_reconcile_batch hands each due row
 *              to exactly one run (FOR UPDATE SKIP LOCKED) and pushes its next
 *              check 2 minutes out, so overlapping or restarted runs never
 *              work the same row, and a run that dies returns its rows after
 *              2 minutes. Any Telegram write happens only under the bot's
 *              'repair' operation lease (§2) — never alongside a member's
 *              connect or disconnect.
 *   per row    one getWebhookInfo (read-only). Right URL → healthy (next in
 *              15 min). Missing / wrong → repair: setWebhook + getWebhookInfo
 *              under the lease. Bot busy → retry in 1 minute. Failure → retry
 *              after 1, 2, 4 … 60 minutes.
 *   limits     ≤ RECONCILE_BATCH_LIMIT rows per run, no new row after
 *              RECONCILE_RUN_BUDGET_MS; ≤ 3 Telegram calls per row per run.
 *   visible    missing / wrong webhook → 'Needs attention' with
 *              mismatch_since; no successful observation for 60 minutes →
 *              'not confirmed' (also computed at read time, so a stopped
 *              worker is visible); from the 3rd consecutive failure every run
 *              logs channels.telegram.reconcile_alert (error level, ids and
 *              counts only) for the operator's log alerting.
 *
 * Guarantee (with the worker scheduled every 5 minutes and Telegram
 * reachable): a missing or wrong webhook on a live connection — whatever late
 * request caused it — is detected and repaired within ~20 minutes, plus any
 * operation then in flight on the bot. Not prevented: detected and repaired.
 */
import { serverLog } from "@/server/observability/logger";
import { timingSafeEqual, webhookRejection } from "@/server/webhooks/security";
import { ChannelError } from "./errors";
import * as repo from "./repository";
import {
  openCredential,
  reconcileBot,
  telegramWebhookUrl,
  type TelegramApiFactory,
} from "./service";
import { TelegramApiError, TelegramBotApi } from "./telegram/api";
import { CHANNEL_RECONCILE_PATH, isChannelReconcileRequest } from "./telegram/paths";

export const RECONCILE_PATH = CHANNEL_RECONCILE_PATH;
export { isChannelReconcileRequest as isReconcileRequest };
/** The schedule this design assumes (configured outside the app). */
export const RECONCILE_RUN_INTERVAL_MS = 5 * 60 * 1000;
export const RECONCILE_BATCH_LIMIT = 25;
export const RECONCILE_RUN_BUDGET_MS = 45_000;
/** Consecutive failed checks from which every run raises an operator alert. */
export const RECONCILE_ALERT_AFTER = 3;

export interface ReconcileRunOptions {
  api?: TelegramApiFactory;
  nowMs?: () => number;
  limit?: number;
  budgetMs?: number;
}

export interface ReconcileRunReport {
  checked: number;
  healthy: number;
  repaired: number;
  failed: number;
  busy: number;
  alerts: number;
}

const defaultApi: TelegramApiFactory = (token) => new TelegramBotApi(token);

/** One reconciliation run. Never throws for a single connection's failure. */
export async function reconcileChannels(
  options: ReconcileRunOptions = {},
): Promise<ReconcileRunReport> {
  const api = options.api ?? defaultApi;
  const nowMs = options.nowMs ?? Date.now;
  const budget = options.budgetMs ?? RECONCILE_RUN_BUDGET_MS;
  const startedAt = nowMs();
  const report: ReconcileRunReport = {
    checked: 0,
    healthy: 0,
    repaired: 0,
    failed: 0,
    busy: 0,
    alerts: 0,
  };

  const batch = await repo.claimReconcileBatch(options.limit ?? RECONCILE_BATCH_LIMIT);
  for (const row of batch) {
    // Rows left unprocessed are handed back by their 2-minute claim.
    if (nowMs() - startedAt > budget) break;
    report.checked += 1;
    const result = await checkOne(row, api, nowMs);
    const tally =
      result === "healthy" || result === "repaired" || result === "busy" ? result : "failed";
    report[tally] += 1;

    let recorded: Awaited<ReturnType<typeof repo.recordReconcile>> | null = null;
    try {
      recorded = await repo.recordReconcile(row.id, row.webhook_generation, result);
    } catch (error) {
      serverLog.error("channels.telegram.reconcile_record_failed", {
        connectionId: row.id,
        code: error instanceof ChannelError ? error.code : "unknown",
      });
    }
    const failures = recorded?.reconcile_failures ?? 0;
    if (recorded?.recorded && failures >= RECONCILE_ALERT_AFTER) {
      report.alerts += 1;
      serverLog.error("channels.telegram.reconcile_alert", {
        connectionId: row.id,
        failures,
        error: result,
        mismatchSince: recorded.mismatch_since ?? null,
      });
    }
  }
  serverLog.info("channels.telegram.reconcile_run", { ...report });
  return report;
}

async function checkOne(
  row: repo.ReconcileCandidate,
  api: TelegramApiFactory,
  nowMs: () => number,
): Promise<repo.ReconcileResult> {
  let bot: TelegramBotApi;
  let expected: string;
  try {
    bot = api(await openCredential(row.credential_ciphertext));
    expected = telegramWebhookUrl(row.id, row.webhook_generation);
  } catch {
    return "unobservable"; // key missing / ciphertext unreadable / no public origin
  }

  let seen: string;
  try {
    seen = (await bot.getWebhookInfo()).url;
  } catch (error) {
    serverLog.warn("channels.telegram.reconcile_unobservable", {
      connectionId: row.id,
      code: error instanceof TelegramApiError ? error.code : "unknown",
    });
    return "unobservable";
  }
  if (seen === expected) return "healthy";

  const seenState: repo.ReconcileResult = seen === "" ? "missing" : "mismatch";
  serverLog.warn("channels.telegram.reconcile_divergence", {
    connectionId: row.id,
    seen: seenState,
  });
  // Repair under the bot's operation lease, as the server itself.
  const outcome = await reconcileBot(
    { organizationId: row.organization_id, actorUserId: null },
    bot,
    row.external_account_id,
    nowMs,
  ).catch(() => "unknown" as const);
  if (outcome === "verified") return "repaired";
  if (outcome === "busy") return "busy";
  return seenState;
}

// ── HTTP entry ────────────────────────────────────────────────────────────────

/**
 * The scheduler's entry. Off (503) unless CRON_SECRET is configured; any other
 * credential is the generic 401. Answers counts only — never ids or secrets.
 */
export async function handleReconcileRequest(
  request: Request,
  options: ReconcileRunOptions & { env?: Record<string, string | undefined> } = {},
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return webhookRejection(405);
  const secret = (options.env ?? process.env)["CRON_SECRET"]?.trim();
  if (!secret) return webhookRejection(503);
  const provided = request.headers.get("authorization") ?? "";
  if (provided.length > 512 || !timingSafeEqual(provided, `Bearer ${secret}`)) {
    return webhookRejection(401);
  }
  try {
    const report = await reconcileChannels(options);
    return new Response(JSON.stringify({ ok: true, ...report }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (error) {
    serverLog.error("channels.telegram.reconcile_run_failed", {
      code: error instanceof ChannelError ? error.code : "unknown",
    });
    return webhookRejection(503);
  }
}
