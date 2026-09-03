/**
 * Server-side session utilities.
 *
 * All functions in this file run on the server only.
 * Never import this from browser-bundled code.
 */
import { createServerClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/supabase/types";

export interface AuthSession {
  userId: string;
  accessToken: string;
  profile: Profile;
}

/**
 * Validate the Bearer token from an incoming server request.
 * Returns the authenticated session or null if invalid/expired.
 *
 * Never trust any userId provided by the client — always derive it
 * from the verified JWT here.
 */
export async function validateSession(
  accessToken: string | undefined | null,
): Promise<AuthSession | null> {
  if (!accessToken) return null;

  const client = createServerClient(accessToken);

  const {
    data: { user },
    error,
  } = await client.auth.getUser();

  if (error || !user) return null;

  const { data: profileData, error: profileError } = await client
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (profileError || !profileData) return null;

  // Explicit cast: supabase-js type inference requires a connected project for full resolution.
  const profile = profileData as unknown as Profile;

  if (profile.status !== "active") return null;

  return {
    userId: user.id,
    accessToken,
    profile,
  };
}

/**
 * Extract Bearer token from Authorization header.
 * Returns null if the header is absent or malformed.
 */
export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}
