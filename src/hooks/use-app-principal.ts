/**
 * The signed-in principal, for components that live in the shell rather than
 * on a route.
 *
 * `userId` and `organizationId` come from the /app route guard's context —
 * a validated session cookie and the active membership row the SERVER
 * resolved (src/routes/app.tsx `beforeLoad`). They are never read from the
 * URL, from client state, or from the capability snapshot (which is
 * presentation data fetched separately, and is explicitly not the source of
 * truth for cache identity).
 *
 * They partition React Query caches. They authorize nothing: every server
 * function derives the user and organization again from the session and
 * re-checks permissions, so a forged pair would still return only that
 * caller's own data.
 *
 * Returns null outside /app — BottomNav also renders on the design gallery
 * route, where there is no signed-in principal and therefore nothing that may
 * be cached under one.
 */
import { useMatch } from "@tanstack/react-router";

export interface AppPrincipal {
  userId: string;
  organizationId: string;
}

export function useAppPrincipal(): AppPrincipal | null {
  const context = useMatch({
    from: "/app",
    shouldThrow: false,
    select: (match) => match.context,
  });

  if (!context) return null;
  const { session, organizationId } = context;
  if (!session?.userId || !organizationId) return null;
  return { userId: session.userId, organizationId };
}
