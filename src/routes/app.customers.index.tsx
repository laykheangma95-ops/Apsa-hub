import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertTriangle, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppHeader, BottomNav, ListSkeleton, ScreenBleed } from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import { useCapabilities } from "@/hooks/use-capabilities";
import { getCustomers, searchRealCustomers } from "@/lib/api";
import { customerKeys, visibleCustomerPhone } from "@/lib/customers-query";
import {
  CUSTOMER_DIRECTORY_PAGE_SIZE,
  CUSTOMER_SEARCH_DEBOUNCE_MS,
  classifyCustomerError,
  customerDirectoryBody,
} from "@/lib/customers-view";
import { initials, localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import type { CompanionColor, Customer } from "@/types";

export const Route = createFileRoute("/app/customers/")({
  head: () => ({
    meta: [
      { title: "Customers — APSA" },
      {
        name: "description",
        content: "Every customer of this business in one list — find anyone by name.",
      },
      { property: "og:title", content: "Customers — APSA" },
      { property: "og:description", content: "Every customer, newest first." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CustomerDirectoryScreen,
});

const COMPANION_VAR: Record<CompanionColor, string> = {
  nilo: "var(--companion-nilo)",
  minto: "var(--companion-minto)",
  vela: "var(--companion-vela)",
  suri: "var(--companion-suri)",
  luma: "var(--companion-luma)",
};

/**
 * One customer, scanned in a second: who they are, and — only for a member
 * who may see it right now — how to reach them.
 *
 * The phone goes through visibleCustomerPhone on every render. A row fetched
 * while the member held customers.view_sensitive stays in the cache; if the
 * grant is revoked (or the capability refresh fails), the number disappears on
 * the next render instead of waiting for a refetch.
 */
function CustomerRow({
  customer,
  canViewSensitive,
}: {
  customer: Customer;
  canViewSensitive: boolean;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const name = localName(customer, language);
  const phone = visibleCustomerPhone(customer, canViewSensitive);

  return (
    <Link
      to="/app/customers/$id"
      params={{ id: customer.id }}
      className="press tap-target flex w-full items-center gap-3 border-b border-border-default bg-surface-primary px-4 py-3 text-left last:border-b-0 hover:bg-surface-secondary"
    >
      <span
        aria-hidden
        className="text-label flex size-10 shrink-0 items-center justify-center rounded-full text-text-inverse"
        style={{ backgroundColor: COMPANION_VAR[customer.companion] }}
      >
        {initials(name)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-label min-w-0 break-words text-text-primary">{name}</span>
        {canViewSensitive ? (
          <span className="text-caption tnum min-w-0 truncate text-text-secondary">
            {phone || t("customerList.noPhone")}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

function CustomerDirectoryScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const capabilities = useCapabilities();

  /*
   * Cache identity from the /app route guard's server-derived context — never
   * the capability snapshot and never the URL. It partitions the cache and
   * nothing else: listCustomers()/searchCustomers() re-check customers.read
   * against the membership the SERVER resolved, on every call.
   */
  const { session, organizationId: routeOrganizationId } = Route.useRouteContext();
  const userId = session.userId;

  const canRead = capabilities.can("customers.read");
  // canSensitive, not can: a phone's mere display — and which rows a phone
  // query returns — is the disclosure, so it must not ride on a snapshot whose
  // latest refresh failed.
  const canViewSensitive = capabilities.canSensitive("customers.view_sensitive");

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // The term goes to the server rather than narrowing the rows on screen: a
  // customer two pages down must still be findable, and only the server sees
  // the whole organization.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search.trim()), CUSTOMER_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search]);

  const searching = debouncedSearch.length > 0;

  const directoryQuery = useInfiniteQuery({
    queryKey: customerKeys.directory(userId, routeOrganizationId),
    queryFn: ({ pageParam }) =>
      getCustomers({ offset: pageParam, limit: CUSTOMER_DIRECTORY_PAGE_SIZE }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.offset + lastPage.customers.length : undefined,
    enabled: canRead && !searching,
  });

  const searchQuery = useInfiniteQuery({
    queryKey: customerKeys.directorySearch(
      userId,
      routeOrganizationId,
      debouncedSearch,
      canViewSensitive,
    ),
    queryFn: ({ pageParam }) =>
      searchRealCustomers(debouncedSearch, canViewSensitive, { offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.offset + lastPage.customers.length : undefined,
    enabled: canRead && searching,
  });

  const active = searching ? searchQuery : directoryQuery;

  const rows = useMemo(() => {
    if (searching) return searchQuery.data?.pages.flatMap((page) => page.customers) ?? [];
    return directoryQuery.data?.pages.flatMap((page) => page.customers) ?? [];
  }, [searching, searchQuery.data, directoryQuery.data]);

  const searchPages = searching ? (searchQuery.data?.pages ?? []) : [];
  const phoneSearchDenied = searchPages.some((page) => page.phoneSearchDenied);
  const truncated = searchPages.some((page) => page.truncated);

  const errorKind = active.isError ? classifyCustomerError(active.error) : null;

  useEffect(() => {
    if (errorKind === "unauthorized") void navigate({ to: "/sign-in" });
  }, [errorKind, navigate]);

  const header = (
    <AppHeader title={t("customerList.title")} subtitle={t("customerList.subtitle")} />
  );

  if (capabilities.state === "pending") {
    return (
      <ScreenBleed bottom="nav" surface="raised">
        {header}
        <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 lg:max-w-[var(--screen-max-wide)]">
          <ListSkeleton rows={6} />
        </main>
        <BottomNav />
      </ScreenBleed>
    );
  }

  /*
   * No customers.read: only the denial. Not the search box, not a count — a
   * denial must not describe the data behind it.
   */
  if (!canRead) {
    return (
      <ScreenBleed bottom="nav" surface="raised">
        {header}
        <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 lg:max-w-[var(--screen-max-wide)]">
          <CapabilityDeniedState capabilities={capabilities} />
        </main>
        <BottomNav />
      </ScreenBleed>
    );
  }

  if (errorKind === "unauthorized") return null; // redirecting, see the effect above

  const body = active.isSuccess
    ? customerDirectoryBody({
        searching,
        rowCount: rows.length,
        phoneSearchDenied,
        truncated,
      })
    : null;

  return (
    <ScreenBleed bottom="nav" surface="raised">
      {header}

      <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 lg:max-w-[var(--screen-max-wide)]">
        <div className="relative mb-2">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted"
            aria-hidden
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={
              canViewSensitive
                ? t("customerList.searchPlaceholder")
                : t("customerList.searchPlaceholderNameOnly")
            }
            aria-label={
              canViewSensitive
                ? t("customerList.searchPlaceholder")
                : t("customerList.searchPlaceholderNameOnly")
            }
            className="h-11 pl-9"
          />
        </div>

        <p className="text-caption mb-3 px-1 text-text-secondary">
          {searching ? t("customerList.searchScope") : t("customerList.listScope")}
          {canViewSensitive ? null : ` ${t("customerList.phonesHidden")}`}
        </p>

        {searching && truncated && rows.length > 0 ? (
          <div
            role="status"
            className="text-caption mb-3 flex items-start gap-2 rounded-xl bg-status-warning-soft px-3 py-2 text-status-warning-text"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{t("customerList.partial")}</span>
          </div>
        ) : null}

        <div className="list-enter overflow-hidden rounded-2xl border border-border-default">
          {active.isPending && active.fetchStatus !== "idle" ? <ListSkeleton rows={6} /> : null}

          {errorKind ? (
            <OperationalState
              tone="danger"
              title={
                errorKind === "forbidden"
                  ? t("customerList.denied.title")
                  : t("customerList.error.title")
              }
              body={
                errorKind === "forbidden"
                  ? t("customerList.denied.body")
                  : t("customerList.error.body")
              }
              {...(errorKind === "forbidden" ? {} : { onRetry: () => void active.refetch() })}
              className="rounded-none border-0"
            />
          ) : null}

          {body === "phone_denied" ? (
            <OperationalState
              title={t("customerList.phoneDenied.title")}
              body={t("customerList.phoneDenied.body")}
              className="rounded-none border-0"
            />
          ) : null}

          {body === "partial_empty" ? (
            <OperationalState
              title={t("customerList.partialEmpty.title")}
              body={t("customerList.partialEmpty.body")}
              className="rounded-none border-0"
            />
          ) : null}

          {body === "no_results" ? (
            <OperationalState
              title={t("customerList.noResults.title")}
              body={t("customerList.noResults.body")}
              action={
                <Button variant="ghost" className="tap-target h-11" onClick={() => setSearch("")}>
                  {t("customerList.noResults.clear")}
                </Button>
              }
              className="rounded-none border-0"
            />
          ) : null}

          {body === "empty" ? (
            <OperationalState
              title={t("customerList.empty.title")}
              body={t("customerList.empty.body")}
              className="rounded-none border-0"
            />
          ) : null}

          {body === "rows"
            ? rows.map((customer) => (
                <CustomerRow
                  key={customer.id}
                  customer={customer}
                  canViewSensitive={canViewSensitive}
                />
              ))
            : null}
        </div>

        {body === "rows" && active.hasNextPage ? (
          <Button
            variant="ghost"
            className="tap-target mt-3 h-11 w-full"
            disabled={active.isFetchingNextPage}
            onClick={() => void active.fetchNextPage()}
          >
            {active.isFetchingNextPage ? t("customerList.loadingMore") : t("customerList.loadMore")}
          </Button>
        ) : null}
      </main>

      <BottomNav />
    </ScreenBleed>
  );
}
