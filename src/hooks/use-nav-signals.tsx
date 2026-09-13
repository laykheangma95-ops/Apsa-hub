/**
 * The two numbers the bottom bar is allowed to show.
 *
 * A badge is a claim on a merchant's attention, so the bar carries exactly two
 * of them and no more: a COUNT on Inbox (conversations nobody has answered)
 * and a DOT on Home (there is something to look at). Sales and Business are
 * hubs — everything under them is already counted on one of those two, and a
 * badge on a container is how badges stop meaning anything.
 *
 * Both live here, at the signed-in shell, rather than on the screens that
 * happen to know them: the bar is on every screen, so the badges have to be
 * right on every screen, not only on Home and Inbox.
 *
 * Presentation only. Neither query grants anything — both are authorized
 * server-side on their own (messages.read, and each Home domain separately).
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getConversationCounts, getHomeSummary } from "@/lib/api";
import { homeQueryKey } from "@/lib/home-query";
import { homeHasAttention } from "@/lib/home-attention";
import { useCapabilities } from "@/hooks/use-capabilities";

export interface NavSignals {
  /** Conversations waiting on a human. 0 means "none", never "unknown". */
  unansweredConversations: number;
  /** True only when Home actually knows there is something to act on. */
  homeNeedsAttention: boolean;
  /** Re-read Home's attention state — the Home tab's long-press shortcut. */
  refreshHomeAttention: () => void;
  /**
   * The signed-in principal, straight from the server-derived /app route
   * context. Carried here because the shell's own surfaces — the bar and the
   * Apsi sheet — sit outside any route and still have to partition their
   * caches by user AND organization. It is a cache partition, never an
   * authorization claim: every read behind it is authorized again server-side.
   */
  principal: { userId: string; organizationId: string };
}

const NavSignalsContext = createContext<NavSignals>({
  unansweredConversations: 0,
  homeNeedsAttention: false,
  refreshHomeAttention: () => {},
  principal: { userId: "", organizationId: "" },
});

/**
 * A conversation has exactly one status, so these two buckets are disjoint and
 * adding them is a count, not an estimate. "Unanswered" is deliberately
 * narrower than "everything in the inbox": a thread the merchant has read and
 * parked under follow-up is not waiting on them right now.
 */
export function unansweredConversationCount(counts: Record<string, number>): number {
  const unread = counts["unread"] ?? 0;
  const needsReply = counts["needs_reply"] ?? 0;
  return unread + needsReply;
}

interface NavSignalsProviderProps {
  /** From the server-derived /app route context. Cache partitioning only. */
  userId: string;
  organizationId: string;
  children: ReactNode;
}

/** How long the bar may trust Home's summary before asking again. */
const HOME_SIGNAL_STALE_MS = 5 * 60_000;

export function NavSignalsProvider({ userId, organizationId, children }: NavSignalsProviderProps) {
  const capabilities = useCapabilities();
  const canReadMessages = capabilities.can("messages.read");

  const countsQuery = useQuery({
    queryKey: ["conversation-counts"],
    queryFn: getConversationCounts,
    enabled: canReadMessages,
    staleTime: 60_000,
  });

  /*
   * Same cache key Home itself uses for "today", so the two share one request
   * rather than racing. The long staleTime is what keeps this cheap: Home
   * mounts with no staleTime and refreshes the shared entry on every visit, so
   * the bar almost never has to fetch on its own — it reads what Home already
   * paid for.
   */
  const homeQuery = useQuery({
    queryKey: homeQueryKey(userId, organizationId, "today"),
    queryFn: () => getHomeSummary("today"),
    enabled: capabilities.state === "ready",
    staleTime: HOME_SIGNAL_STALE_MS,
  });

  const value = useMemo<NavSignals>(
    () => ({
      unansweredConversations: canReadMessages
        ? unansweredConversationCount(countsQuery.data ?? {})
        : 0,
      homeNeedsAttention: homeQuery.data ? homeHasAttention(homeQuery.data) : false,
      refreshHomeAttention: () => {
        void homeQuery.refetch();
        if (canReadMessages) void countsQuery.refetch();
      },
      principal: { userId, organizationId },
    }),
    [canReadMessages, countsQuery, homeQuery, userId, organizationId],
  );

  return <NavSignalsContext.Provider value={value}>{children}</NavSignalsContext.Provider>;
}

export function useNavSignals(): NavSignals {
  return useContext(NavSignalsContext);
}
