/**
 * Webhook event receipts — replay protection / provider-event idempotency.
 *
 *   PostgresWebhookReceiptStore — production: claim_webhook_event /
 *     release_webhook_event (migration 045). One INSERT … ON CONFLICT DO
 *     NOTHING, so exactly one of any number of concurrent deliveries of the
 *     same event, on any number of instances, wins the claim.
 *   MemoryWebhookReceiptStore — tests only. Per-process; NOT replay protection
 *     for a multi-instance deployment. Unlike the rate limiter there is no
 *     silent memory fallback here: a webhook route whose receipt store is
 *     unreachable must fail (the provider retries), never process unguarded.
 *
 * Server-only.
 */

export interface WebhookReceiptStore {
  /** True on first sight of (provider, eventId); false for any repeat. */
  claim(provider: string, eventId: string): Promise<boolean>;
  /** Undo a claim after failed processing so the provider's retry is processed. */
  release(provider: string, eventId: string): Promise<void>;
}

export class MemoryWebhookReceiptStore implements WebhookReceiptStore {
  private readonly seen = new Set<string>();

  async claim(provider: string, eventId: string): Promise<boolean> {
    const key = `${provider}\u0000${eventId}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  async release(provider: string, eventId: string): Promise<void> {
    this.seen.delete(`${provider}\u0000${eventId}`);
  }
}

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;
};

export class WebhookReceiptStoreError extends Error {
  constructor(readonly reason: string) {
    super(`webhook receipt store unavailable: ${reason}`);
    this.name = "WebhookReceiptStoreError";
  }
}

export class PostgresWebhookReceiptStore implements WebhookReceiptStore {
  constructor(private readonly client?: RpcClient) {}

  private async resolveClient(): Promise<RpcClient> {
    if (this.client) return this.client;
    const { supabaseAdmin } = await import("@/lib/supabase/server");
    return supabaseAdmin as unknown as RpcClient;
  }

  async claim(provider: string, eventId: string): Promise<boolean> {
    const client = await this.resolveClient();
    const { data, error } = await client.rpc("claim_webhook_event", {
      p_provider: provider,
      p_event_id: eventId,
    });
    if (error || typeof data !== "boolean") {
      throw new WebhookReceiptStoreError(error?.code || "malformed_result");
    }
    return data;
  }

  async release(provider: string, eventId: string): Promise<void> {
    const client = await this.resolveClient();
    const { error } = await client.rpc("release_webhook_event", {
      p_provider: provider,
      p_event_id: eventId,
    });
    if (error) throw new WebhookReceiptStoreError(error.code || "rpc_error");
  }
}
