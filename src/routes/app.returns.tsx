/**
 * /app/returns — Customer Returns list.
 *
 * Newest first: order number, status (words + icon) and how many items are
 * coming back. Each row opens /app/returns/$returnId, where the return is
 * received, inspected and completed; "New return" opens /app/returns/new.
 *
 * Every figure comes from the server (src/server/returns/service.ts), which
 * re-checks orders.return + orders.read on every call. The capability checks
 * here only decide what is offered — but they also gate the CACHE: the list
 * names orders, so it is evicted and never rendered once the grant is gone.
 * When more returns exist than one page shows, the list says so.
 * No price, phone or address is shown.
 */
import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Info, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AppHeader, ListSkeleton, ScreenBleed } from "@/design-system";
import { Button } from "@/components/ui/button";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import { OperationalState } from "@/components/common/OperationalState";
import { ReturnStatusLabel } from "@/components/returns/ReturnStatusLabel";
import { ReturnsAccess } from "@/components/returns/ReturnsAccess";
import { useCapabilities, useSensitiveCapabilityRevalidation } from "@/hooks/use-capabilities";
import { shortTime } from "@/lib/format";
import {
  canAccessReturns,
  listCustomerReturns,
  returnsKeys,
  type ReturnSummary,
} from "@/lib/returns";

export const Route = createFileRoute("/app/returns")({
  head: () => ({
    meta: [
      { title: "Customer returns — APSA" },
      { name: "description", content: "Customer returns of delivered orders." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ReturnsListRoute,
});

function ReturnRow({ item }: { item: ReturnSummary }) {
  const { t } = useTranslation();
  return (
    <Link
      to="/app/returns/$returnId"
      params={{ returnId: item.returnId }}
      className="press flex w-full flex-col gap-1.5 border-b border-border-default bg-surface-primary px-4 py-3 text-left last:border-b-0 hover:bg-surface-secondary"
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="text-label tnum min-w-0 flex-1 truncate text-text-primary">
          {t("returns.list.order", { number: item.orderNumber })}
        </span>
        <span className="text-caption tnum shrink-0 text-text-muted">
          {shortTime(item.updatedAt)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <ReturnStatusLabel status={item.status} />
        <span className="text-caption tnum text-text-secondary">
          {t("returns.list.units", { count: item.quantity })}
        </span>
      </div>
    </Link>
  );
}

function ReturnsListRoute() {
  const { session, organizationId } = Route.useRouteContext();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const detailOpen = pathname !== "/app/returns" && pathname.startsWith("/app/returns/");
  if (detailOpen) return <Outlet />;
  return (
    <ReturnsListIdentityBoundary
      key={`${session.userId}\u0000${organizationId}`}
      userId={session.userId}
      organizationId={organizationId}
    />
  );
}

function ReturnsListIdentityBoundary({
  userId,
  organizationId,
}: {
  userId: string;
  organizationId: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const capabilities = useCapabilities();
  useSensitiveCapabilityRevalidation(userId, organizationId, true);
  const allowed = canAccessReturns(capabilities, organizationId);

  return (
    <ScreenBleed surface="raised" bottom="none">
      <AppHeader
        title={t("returns.title")}
        subtitle={t("returns.subtitle")}
        onBack={() => void navigate({ to: "/app/inventory" })}
      />

      <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 pb-6 lg:max-w-[var(--screen-max-wide)]">
        <ReturnsAccess
          userId={userId}
          organizationId={organizationId}
          allowed={allowed}
          denied={<CapabilityDeniedState capabilities={capabilities} />}
        >
          {() => <ReturnsListBody userId={userId} organizationId={organizationId} />}
        </ReturnsAccess>
      </main>
    </ScreenBleed>
  );
}

function ReturnsListBody({ userId, organizationId }: { userId: string; organizationId: string }) {
  const { t } = useTranslation();
  const returnsQuery = useQuery({
    queryKey: returnsKeys.list(userId, organizationId),
    queryFn: listCustomerReturns,
  });

  const returns = returnsQuery.data?.returns ?? [];
  const truncated = returnsQuery.data?.truncated ?? false;

  return (
    <div className="content-in flex flex-col gap-3">
      <Button asChild className="tap-target h-12 w-full gap-2">
        <Link to="/app/returns/new">
          <Plus className="size-4" aria-hidden />
          {t("returns.list.new")}
        </Link>
      </Button>

      {truncated ? (
        <p
          role="status"
          className="text-caption flex items-start gap-2 rounded-xl bg-status-info-soft px-3 py-2 text-status-info-text"
        >
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{t("returns.list.partial", { count: returns.length })}</span>
        </p>
      ) : null}

      <div
        className="list-enter overflow-hidden rounded-2xl border border-border-default"
        aria-busy={returnsQuery.isLoading}
      >
        {returnsQuery.isLoading ? <ListSkeleton rows={4} /> : null}

        {returnsQuery.isError ? (
          <OperationalState
            tone="danger"
            title={t("returns.list.errorTitle")}
            body={t("returns.list.errorBody")}
            onRetry={() => void returnsQuery.refetch()}
            className="rounded-none border-0"
          />
        ) : null}

        {returnsQuery.isSuccess && returns.length === 0 ? (
          <OperationalState
            title={t("returns.list.emptyTitle")}
            body={t("returns.list.emptyBody")}
            className="rounded-none border-0"
          />
        ) : null}

        {returns.length > 0 ? (
          <ul aria-label={t("returns.title")}>
            {returns.map((item) => (
              <li key={item.returnId}>
                <ReturnRow item={item} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
