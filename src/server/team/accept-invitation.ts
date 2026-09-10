/**
 * Invitation acceptance (server-only).
 *
 * Mirrors src/server/org/create-organization.ts: the RPC uses auth.uid()
 * internally, so it MUST be called through the caller's own JWT — never
 * through the service-role client, which would make auth.uid() resolve to
 * NULL and always fail the RPC's unauthenticated guard.
 *
 * NEVER import supabaseAdmin at module scope here — createServerClient is
 * imported dynamically inside the function body so @/lib/supabase/server
 * stays server-side only.
 */
import { hashInviteToken } from "./invite-token";

interface RpcSuccess {
  status: "success";
  org_id: string;
}
interface RpcAlreadyMember {
  status: "already_member";
  org_id: string;
}
interface RpcOtherStatus {
  status: "not_found" | "already_used" | "expired" | "email_mismatch";
}

type RpcResult = RpcSuccess | RpcAlreadyMember | RpcOtherStatus;

export type AcceptInvitationResult =
  | { ok: true; orgId: string; alreadyMember: boolean }
  | { ok: false; code: "not_found" | "already_used" | "expired" | "email_mismatch" }
  | { ok: false; code: "unauthenticated" }
  | { ok: false; code: "internal_error"; message: string };

export async function acceptInvitationForCaller(
  accessToken: string,
  rawToken: string,
): Promise<AcceptInvitationResult> {
  const { createServerClient } = await import("@/lib/supabase/server");
  const userClient = createServerClient(accessToken);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rpcResult, error } = await (userClient as any).rpc("accept_invitation", {
    p_token_hash: hashInviteToken(rawToken),
  });

  if (error) {
    if (error.message?.includes("unauthenticated")) {
      return { ok: false, code: "unauthenticated" };
    }
    return { ok: false, code: "internal_error", message: error.message };
  }

  const result = rpcResult as unknown as RpcResult;

  switch (result.status) {
    case "success":
      return { ok: true, orgId: result.org_id, alreadyMember: false };
    case "already_member":
      return { ok: true, orgId: result.org_id, alreadyMember: true };
    case "not_found":
    case "already_used":
    case "expired":
    case "email_mismatch":
      return { ok: false, code: result.status };
    default:
      return { ok: false, code: "internal_error", message: "Unexpected RPC response" };
  }
}
