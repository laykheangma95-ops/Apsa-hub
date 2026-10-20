/**
 * Channel credential protection — server-only.
 *
 * Provider credentials (a Telegram bot token today) are stored in
 * channel_connections ONLY as AES-256-GCM ciphertext (migration 064). The key,
 * CHANNEL_CREDENTIAL_KEY, is a server environment secret that never reaches the
 * database, the browser or a log line, so a database dump alone cannot act as
 * a merchant's bot.
 *
 *   CHANNEL_CREDENTIAL_KEY = base64 of exactly 32 random bytes
 *     (generate: `openssl rand -base64 32`)
 *
 * Ciphertext format: "v1.<iv base64url>.<ciphertext+tag base64url>". The
 * version is stored beside it (credential_key_version) so a future key
 * rotation can re-encrypt row by row.
 *
 * The webhook secret a provider echoes back on every delivery is stored only
 * as its SHA-256 hex digest. It is DERIVED (deriveWebhookSecret) from the
 * connection id and that connect's webhook generation with a subkey of
 * CHANNEL_CREDENTIAL_KEY, so the server can re-point Telegram at the current
 * generation (repair) and recognise a delivery for an older generation of the
 * same connection, without ever storing a usable secret.
 */

export const CREDENTIAL_KEY_VERSION = 1;
const FORMAT_PREFIX = "v1";

export class ChannelCredentialKeyError extends Error {
  constructor() {
    super("CHANNEL_CREDENTIAL_KEY is missing or is not 32 bytes of base64");
    this.name = "ChannelCredentialKeyError";
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decodes the configured key; throws ChannelCredentialKeyError if unusable. */
export function readCredentialKey(
  raw: string | undefined = process.env["CHANNEL_CREDENTIAL_KEY"],
): Uint8Array<ArrayBuffer> {
  if (!raw || raw.trim() === "") throw new ChannelCredentialKeyError();
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64UrlDecode(raw.trim());
  } catch {
    throw new ChannelCredentialKeyError();
  }
  if (bytes.length !== 32) throw new ChannelCredentialKeyError();
  return bytes;
}

async function importKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptCredential(
  plaintext: string,
  key: Uint8Array<ArrayBuffer> = readCredentialKey(),
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await importKey(key),
      new TextEncoder().encode(plaintext),
    ),
  );
  return `${FORMAT_PREFIX}.${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}`;
}

export class ChannelCredentialDecryptError extends Error {
  constructor() {
    super("channel credential could not be decrypted");
    this.name = "ChannelCredentialDecryptError";
  }
}

/** Authenticated decryption: a tampered or foreign-key ciphertext throws. */
export async function decryptCredential(
  stored: string,
  key: Uint8Array<ArrayBuffer> = readCredentialKey(),
): Promise<string> {
  const [version, iv, body, ...rest] = stored.split(".");
  if (version !== FORMAT_PREFIX || !iv || !body || rest.length > 0) {
    throw new ChannelCredentialDecryptError();
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlDecode(iv) },
      await importKey(key),
      base64UrlDecode(body),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new ChannelCredentialDecryptError();
  }
}

async function hmac(
  key: Uint8Array<ArrayBuffer>,
  message: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(message)),
  );
}

/**
 * The webhook secret for one connect of one connection: base64url of
 * HMAC-SHA256(subkey, "<connection id>:<webhook generation>"), the subkey
 * being HMAC(CHANNEL_CREDENTIAL_KEY, a fixed label) so the AES key is never
 * used directly for MACs. Within Telegram's [A-Za-z0-9_-]{1,256}.
 */
export async function deriveWebhookSecret(
  connectionId: string,
  generation: string,
  key: Uint8Array<ArrayBuffer> = readCredentialKey(),
): Promise<string> {
  const subkey = await hmac(key, "apsa:channel-webhook-secret:v1");
  return base64UrlEncode(
    await hmac(subkey, `${connectionId.toLowerCase()}:${generation.toLowerCase()}`),
  );
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
