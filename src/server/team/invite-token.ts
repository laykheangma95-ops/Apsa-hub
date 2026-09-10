/**
 * Invitation token generation/hashing.
 *
 * The raw token is returned to the caller exactly once (as part of the invite
 * link) and is never persisted or logged — only its SHA-256 hash is stored in
 * `invitations.token_hash`. See SECURITY.md §48 ("Never log ... raw tokens").
 *
 * Never import this from browser-bundled code.
 */
import { randomBytes, createHash } from "node:crypto";

/** Invitations expire 7 days after being issued (or resent). */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function inviteExpiryFromNow(): string {
  return new Date(Date.now() + INVITATION_TTL_MS).toISOString();
}
