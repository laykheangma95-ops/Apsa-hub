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
 * as its SHA-256 hex digest; the plaintext exists once, in the setWebhook call.
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

/** 32 random bytes, base64url — within Telegram's secret_token alphabet [A-Za-z0-9_-]{1,256}. */
export function generateWebhookSecret(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
