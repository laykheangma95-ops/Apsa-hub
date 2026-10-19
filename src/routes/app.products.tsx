/**
 * /app/products — the merchant's product catalogue.
 *
 * Reads and writes go through src/lib/catalog.ts, which calls the existing
 * server functions in src/api/products.ts. The organization is resolved from
 * the caller's own DB membership inside those handlers and every action is
 * authorized again by src/server/products/service.ts, so the capability checks
 * on this screen decide what is *offered*, never what is *allowed*.
 *
 * The list is paged by the server, newest first, CATALOG_LIST_PAGE_SIZE at a
 * time, with no ceiling on how far Load more goes. The search box asks the
 * SERVER, across the whole catalogue under the chosen status and category —
 * never just the rows already loaded (src/lib/catalog-search.ts says exactly
 * what it matches).
 */
import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Archive, FolderTree, Package, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppHeader, BottomNav, Chip, ChipRow, ListSkeleton, ScreenBleed } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OperationalState } from "@/components/common/OperationalState";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import { CreateProductSheet } from "@/components/products/CreateProductSheet";
import { CategorySheet } from "@/components/products/CategorySheet";
import { useCapabilities } from "@/hooks/use-capabilities";
import { useLanguage } from "@/lib/i18n";
import { formatMoney } from "@/lib/money";
import {
  CATALOG_LIST_STATUSES,
  CATALOG_QUERY_ROOT,
  catalogKeys,
  categoryLabel,
  classifyCatalogListError,
  enforceCatalogCachePrincipal,
  listCatalogCategories,
  listCatalogProductsPage,
  productLeadPrice,
  type CatalogListCursor,
  type CatalogListStatus,
  type CatalogPageQuery,
  type CatalogProduct,
} from "@/lib/catalog";
import {
  CATALOG_SEARCH_DEBOUNCE_MS,
  CATALOG_SEARCH_INPUT_MAX,
  normalizeCatalogSearch,
} from "@/lib/catalog-search";

export const Route = createFileRoute("/app/products")({
  head: () => ({
    meta: [
      { title: "Products — APSA" },
      {
        name: "description",
        content: "Your product catalogue — names, variants and prices in one list.",
      },
      { property: "og:title", content: "Products — APSA" },
      { property: "og:description", content: "Names, variants and prices for what you sell." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ProductListScreen,
});

function ProductRow({ product }: { product: CatalogProduct }) {
  const { t } = useTranslation();
  const price = productLeadPrice(product);
  const archived = product.status === "ARCHIVED";

  return (
    <Link
      to="/app/products/$id"
      params={{ id: product.id }}
      className="press flex w-full flex-col gap-1.5 border-b border-border-default bg-surface-primary px-4 py-3 text-left last:border-b-0 hover:bg-surface-secondary"
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="text-label min-w-0 flex-1 text-text-primary" lang="km">
          <span className="chip-text">{product.nameKm}</span>
        </span>
        <span className="text-financial tnum shrink-0 text-text-primary">
          {price ? formatMoney(price) : t("catalog.list.noPrice")}
        </span>
      </div>

      {product.nameEn ? (
        <span className="text-caption min-w-0 truncate text-text-secondary" lang="en">
          {product.nameEn}
        </span>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {/*
         * Status is never colour alone: the marker carries its own icon and a
         * written label, and it survives a Khmer label without clipping.
         */}
        <span
          className={
            archived
              ? "text-label inline-flex max-w-full items-center gap-1.5 rounded-full bg-surface-secondary px-2 py-0.5 text-text-secondary"
              : "text-label inline-flex max-w-full items-center gap-1.5 rounded-full bg-status-success-soft px-2 py-0.5 text-status-success-text"
          }
        >
          {archived ? (
            <Archive className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <Package className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="chip-text">
            {t(archived ? "catalog.list.status.archived" : "catalog.list.status.active")}
          </span>
        </span>
        <span className="text-caption text-text-muted">
          {t("catalog.list.variants", { count: product.variants.length })}
        </span>
      </div>
    </Link>
  );
}

function ProductListScreen() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const detailOpen = pathname !== "/app/products" && pathname.startsWith("/app/products/");

  /*
   * Identity for the catalog cache comes from the /app route guard's own
   * server-derived context (validated session + DB membership) — never from
   * the capability snapshot, which is presentation data fetched on a separate
   * request. Two members of the same organization can hold different
   * products.view_cost permission, so this identity must include the user,
   * not just the organization: an organization-only key would let one
   * member's cached cost data be read back for the next member who signs in
   * to the same tab. See src/lib/catalog.ts's "React Query cache identity"
   * section.
   */
  const { session, organizationId: routeOrganizationId } = Route.useRouteContext();
  const userId = session.userId;

  /*
   * Fail closed rather than fall back to a placeholder key: if the route's
   * own identity is somehow incomplete, or the capability snapshot's resolved
   * organization has diverged from the route's (a stale snapshot mid an
   * organization switch), nothing is fetched and nothing is offered — never
   * key a request under a shared placeholder like "unresolved", which could
   * quietly pool two different principals' data together.
   */
  const identityOk =
    Boolean(userId) &&
    Boolean(routeOrganizationId) &&
    (capabilities.state !== "ready" || capabilities.organizationId === routeOrganizationId);

  // Purges every catalog entry the instant this tab's principal changes —
  // independent, defense-in-depth isolation alongside Settings' full
  // queryClient.clear() on sign-out (src/routes/app.settings.tsx). Runs on
  // every render; it is a no-op unless the principal actually changed.
  enforceCatalogCachePrincipal(queryClient, userId, routeOrganizationId);

  const [status, setStatus] = useState<CatalogListStatus>("ACTIVE");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  /** What is in the box, keystroke by keystroke. */
  const [searchInput, setSearchInput] = useState("");
  /** What the server is asked: the box, normalized, once typing pauses. */
  const [search, setSearch] = useState("");
  const typedSearch = normalizeCatalogSearch(searchInput);
  const searchPending = typedSearch !== search;
  useEffect(() => {
    if (typedSearch === search) return;
    const timer = setTimeout(() => setSearch(typedSearch), CATALOG_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typedSearch, search]);
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();
  const [categoriesOpen, setCategoriesOpen] = useState(false);

  /*
   * Each gate names the permission the matching server function requires:
   * getProductCatalog → products.read, createProduct → products.create,
   * createCategory/updateCategory → products.manage_categories,
   * updateVariant's cost branch → products.update_cost. A member without one
   * sees no entry point here and is refused by the server regardless.
   */
  const canReadProducts = identityOk && capabilities.can("products.read");
  const canCreateProduct = identityOk && capabilities.can("products.create");
  const canManageCategories = identityOk && capabilities.can("products.manage_categories");
  // Cost goes through canSensitive: no cost-entry affordance while the current
  // capability snapshot is unconfirmed (see CapabilityView.canSensitive).
  const canSetCost = identityOk && capabilities.canSensitive("products.update_cost");

  const organizationId = routeOrganizationId;

  /*
   * The whole catalogue, a page at a time, under one question: status,
   * category and search. Each page continues from the exact (created_at, id)
   * position the previous one ended on, so a product created while the
   * merchant pages appears at the top on the next refresh instead of pushing a
   * row from one page onto the next.
   *
   * The key carries the principal and the question, and so does every answer:
   * a page served for anyone other than this key's member and organization, or
   * for a different question, is refused before it is stored
   * (acceptCatalogPage).
   */
  const pageQuery: CatalogPageQuery = useMemo(
    () => ({ status, categoryId, search }),
    [status, categoryId, search],
  );
  const productsQuery = useInfiniteQuery({
    queryKey: catalogKeys.productPagesFor(userId, organizationId, pageQuery),
    queryFn: ({ pageParam, signal }) =>
      listCatalogProductsPage({
        before: pageParam,
        expected: { userId, organizationId },
        query: pageQuery,
        signal,
      }),
    initialPageParam: null as CatalogListCursor | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    /*
     * A dropped connection is worth two quiet retries; an answer about WHO is
     * asking never is. Signed out, refused or answered for another principal
     * surfaces at once.
     */
    retry: (failureCount, error) =>
      failureCount < 2 && classifyCatalogListError(error) === "server_error",
    enabled: !detailOpen && canReadProducts,
  });

  const categoriesQuery = useQuery({
    queryKey: catalogKeys.categories(userId, organizationId),
    queryFn: () => listCatalogCategories(canManageCategories),
    enabled: !detailOpen && canReadProducts,
  });

  // Keyed by id across pages. A cursor cannot hand back a row twice, but a
  // repeated React key would silently drop or reuse a row on screen.
  const products = useMemo(() => {
    const seen = new Set<string>();
    const list: CatalogProduct[] = [];
    for (const page of productsQuery.data?.pages ?? []) {
      for (const product of page.products) {
        if (seen.has(product.id)) continue;
        seen.add(product.id);
        list.push(product);
      }
    }
    return list;
  }, [productsQuery.data]);
  const categories = useMemo(() => categoriesQuery.data ?? [], [categoriesQuery.data]);
  const activeCategories = useMemo(
    () => categories.filter((category) => category.status === "ACTIVE"),
    [categories],
  );

  const listError = productsQuery.isError ? productsQuery.error : null;
  const errorKind = listError ? classifyCatalogListError(listError) : null;
  /*
   * Rows already on screen stay only while the server would still hand them
   * over. Signed out, refused (products.read revoked) or answered for another
   * principal: every loaded page leaves the screen, not just the failed one.
   */
  const blocked = errorKind !== null && errorKind !== "server_error";
  const hasPages = Boolean(productsQuery.data) && !blocked;
  const firstLoadFailed = Boolean(listError) && !blocked && !productsQuery.data;
  const moreFailed = productsQuery.isFetchNextPageError && !blocked;
  const refreshFailed = productsQuery.isRefetchError && hasPages;
  const reachedEnd = hasPages && !productsQuery.hasNextPage && products.length > 0;
  const searching = search !== "";
  /** A search typed but not yet asked, or asked and not yet answered. */
  const lookingUp = searchPending || (searching && productsQuery.isLoading);
  const endTitle = searching ? t("catalog.list.endSearch.title") : t("catalog.list.end.title");
  const endBody = searching
    ? t("catalog.list.endSearch.body", { count: products.length })
    : t("catalog.list.end.body", { count: products.length });

  useEffect(() => {
    if (errorKind === "unauthorized") void navigate({ to: "/sign-in" });
  }, [errorKind, navigate]);

  /*
   * One request per page, however fast the taps. The ref closes the gap
   * between a tap and the re-render that marks the button busy; cancelRefetch
   * false makes a call during any fetch join it rather than restart it.
   */
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const loadingMore = useRef(false);
  const focusEndWhenDone = useRef(false);
  const busy = productsQuery.isFetching;
  function loadMore() {
    if (loadingMore.current || productsQuery.isFetching || !productsQuery.hasNextPage) return;
    loadingMore.current = true;
    focusEndWhenDone.current = document.activeElement === loadMoreRef.current;
    void productsQuery.fetchNextPage({ cancelRefetch: false }).finally(() => {
      loadingMore.current = false;
    });
  }
  // The Load more button leaves when the last page arrives; keyboard focus
  // moves to the end-of-list message instead of falling back to the page.
  useEffect(() => {
    if (reachedEnd && focusEndWhenDone.current) {
      focusEndWhenDone.current = false;
      endRef.current?.focus();
    }
  }, [reachedEnd]);

  /*
   * A new question starts at its first page. The list just left is cancelled
   * and dropped: a page still in flight for it lands in no cache entry (its
   * request is aborted too), and coming back to it reads page one again
   * rather than replaying every page walked before. Runs on any change of
   * status, category or search.
   */
  const shownKey = useRef<readonly unknown[] | null>(null);
  useEffect(() => {
    const key = catalogKeys.productPagesFor(userId, organizationId, pageQuery);
    const previous = shownKey.current;
    shownKey.current = key;
    if (!previous || JSON.stringify(previous) === JSON.stringify(key)) return;
    loadingMore.current = false;
    focusEndWhenDone.current = false;
    void queryClient.cancelQueries({ queryKey: previous, exact: true });
    queryClient.removeQueries({ queryKey: previous, exact: true });
  }, [queryClient, userId, organizationId, pageQuery]);

  /** Every catalog list/detail row for THIS principal, and nothing else. */
  function invalidateCatalog() {
    void queryClient.invalidateQueries({ queryKey: [CATALOG_QUERY_ROOT, userId, organizationId] });
  }

  function clearSearch() {
    setSearchInput("");
    setSearch("");
  }

  if (detailOpen) return <Outlet />;

  return (
    <ScreenBleed bottom="nav" surface="raised">
      <AppHeader
        title={t("catalog.list.title")}
        subtitle={t("catalog.list.subtitle")}
        {...(canCreateProduct
          ? {
              action: (
                <button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  aria-label={t("catalog.list.addProduct")}
                  className="press-tactile tap-target flex shrink-0 items-center justify-center rounded-full bg-action-primary text-text-on-action"
                >
                  <Plus className="size-5" aria-hidden />
                </button>
              ),
            }
          : {})}
      />

      <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 lg:max-w-[var(--screen-max-wide)]">
        {/*
         * The denial returns before the search box and the filters, so a member
         * without products.read is never shown controls over a catalogue they
         * cannot read.
         */}
        {!canReadProducts ? (
          <CapabilityDeniedState capabilities={capabilities} />
        ) : blocked ? (
          /*
           * The server refused, or answered for someone else: no controls that
           * would ask it again for a list it will not give, and no rows.
           */
          errorKind === "principal_changed" ? (
            <OperationalState
              tone="danger"
              title={t("catalog.list.principalChanged.title")}
              body={t("catalog.list.principalChanged.body")}
              action={
                <Button className="tap-target h-12" onClick={() => window.location.reload()}>
                  {t("catalog.list.principalChanged.reload")}
                </Button>
              }
            />
          ) : (
            <OperationalState
              title={t("catalog.list.denied.title")}
              body={t("catalog.list.denied.body")}
            />
          )
        ) : (
          <div className="flex flex-col gap-3">
            <ChipRow label={t("catalog.list.statusLabel")} role="tablist">
              {CATALOG_LIST_STATUSES.map((option) => (
                <Chip
                  key={option}
                  role="tab"
                  selected={status === option}
                  onClick={() => setStatus(option)}
                >
                  {t(`catalog.list.status.${option === "ACTIVE" ? "active" : "archived"}`)}
                </Chip>
              ))}
            </ChipRow>

            <ChipRow label={t("catalog.list.categoryFilter")}>
              <Chip selected={categoryId === null} onClick={() => setCategoryId(null)}>
                {t("catalog.list.categoryAll")}
              </Chip>
              {activeCategories.map((category) => (
                <Chip
                  key={category.id}
                  selected={categoryId === category.id}
                  onClick={() => setCategoryId(category.id)}
                >
                  {categoryLabel(category, language)}
                </Chip>
              ))}
              {canManageCategories ? (
                <Chip
                  onClick={() => setCategoriesOpen(true)}
                  ariaPressed={null}
                  icon={<FolderTree className="size-4" aria-hidden />}
                >
                  {t("catalog.list.manageCategories")}
                </Chip>
              ) : null}
            </ChipRow>

            <div className="flex flex-col gap-1">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted"
                  aria-hidden
                />
                <Input
                  type="search"
                  className="h-12 pl-9"
                  value={searchInput}
                  maxLength={CATALOG_SEARCH_INPUT_MAX}
                  aria-label={t("catalog.list.searchPlaceholder")}
                  aria-describedby="catalog-search-scope"
                  placeholder={t("catalog.list.searchPlaceholder")}
                  onChange={(event) => setSearchInput(event.target.value)}
                  onKeyDown={(event) => {
                    // Enter asks at once rather than waiting out the pause.
                    if (event.key === "Enter") setSearch(typedSearch);
                  }}
                />
              </div>
              {/*
               * Said plainly: the box searches the whole catalogue in this list,
               * not just the rows on screen.
               */}
              <span id="catalog-search-scope" className="text-caption px-1 text-text-secondary">
                {t("catalog.list.searchScope")}
              </span>
            </div>

            {refreshFailed ? (
              <div
                role="status"
                className="text-caption flex items-start gap-2 rounded-xl bg-status-warning-soft px-3 py-2 text-status-warning-text"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">{t("catalog.list.refreshError")}</span>
                <button
                  type="button"
                  onClick={() => void productsQuery.refetch()}
                  className="press tap-target -my-2 shrink-0 rounded-lg px-2 font-medium underline underline-offset-2"
                >
                  {t("common.retry")}
                </button>
              </div>
            ) : null}

            <div
              className="list-enter overflow-hidden rounded-2xl border border-border-default"
              aria-busy={productsQuery.isLoading || searchPending}
            >
              {productsQuery.isLoading ? <ListSkeleton rows={6} /> : null}

              {firstLoadFailed ? (
                <OperationalState
                  tone="danger"
                  title={t("catalog.list.error.title")}
                  body={t("catalog.list.error.body")}
                  onRetry={() => void productsQuery.refetch()}
                  className="rounded-none border-0"
                />
              ) : null}

              {/*
               * Empty only when the first page was READ and held nothing.
               * A brand-new catalogue (Active, All categories, no search):
               * the merchant who can add a product is told the minimum it
               * takes (Khmer name + price) and handed the same Add Product
               * sheet as the header's "+", in thumb reach.
               */}
              {hasPages && products.length === 0 && !productsQuery.hasNextPage ? (
                searching ? (
                  <OperationalState
                    title={t("catalog.list.noMatches.title")}
                    body={t("catalog.list.noMatches.body")}
                    action={
                      <Button
                        variant="ghost"
                        className="tap-target h-auto min-h-11 whitespace-normal py-2"
                        onClick={clearSearch}
                      >
                        {t("catalog.list.noMatches.clear")}
                      </Button>
                    }
                    className="rounded-none border-0"
                  />
                ) : categoryId !== null ? (
                  <OperationalState
                    title={t("catalog.list.emptyCategory.title")}
                    body={t("catalog.list.emptyCategory.body")}
                    className="rounded-none border-0"
                  />
                ) : status === "ACTIVE" && categoryId === null && canCreateProduct ? (
                  <OperationalState
                    title={t("catalog.list.firstProduct.title")}
                    body={t("catalog.list.firstProduct.body")}
                    action={
                      <Button
                        type="button"
                        className="tap-target h-auto min-h-12 w-full whitespace-normal py-2 sm:w-auto"
                        onClick={() => setCreateOpen(true)}
                      >
                        <Plus className="size-5 shrink-0" aria-hidden />
                        {t("catalog.list.firstProduct.action")}
                      </Button>
                    }
                    className="rounded-none border-0"
                  />
                ) : (
                  <OperationalState
                    title={t(
                      status === "ACTIVE"
                        ? "catalog.list.empty.activeTitle"
                        : "catalog.list.empty.archivedTitle",
                    )}
                    body={t(
                      status === "ACTIVE"
                        ? "catalog.list.empty.activeBody"
                        : "catalog.list.empty.archivedBody",
                    )}
                    className="rounded-none border-0"
                  />
                )
              ) : null}

              {hasPages
                ? products.map((product) => <ProductRow key={product.id} product={product} />)
                : null}
            </div>

            {hasPages && products.length > 0 ? (
              <div className="flex flex-col items-stretch gap-2 pb-2">
                {moreFailed ? (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-xl bg-status-danger-soft px-3 py-2 text-status-danger-text"
                  >
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <div className="min-w-0">
                      <p className="text-label">{t("catalog.list.moreError.title")}</p>
                      <p className="text-caption">{t("catalog.list.moreError.body")}</p>
                    </div>
                  </div>
                ) : null}

                {productsQuery.hasNextPage ? (
                  /*
                   * aria-disabled rather than disabled: a disabled button drops
                   * keyboard focus mid-load. loadMore() refuses while busy.
                   */
                  <Button
                    ref={loadMoreRef}
                    variant={moreFailed ? "default" : "ghost"}
                    className="tap-target h-auto min-h-12 w-full whitespace-normal py-2 aria-disabled:opacity-70"
                    aria-disabled={busy}
                    aria-describedby="catalog-list-progress"
                    onClick={loadMore}
                  >
                    {productsQuery.isFetchingNextPage
                      ? t("catalog.list.loadingMore")
                      : moreFailed
                        ? t("common.retry")
                        : t("catalog.list.loadMore")}
                  </Button>
                ) : null}

                {reachedEnd ? (
                  <div ref={endRef} tabIndex={-1} className="rounded-xl px-3 py-2 text-center">
                    <p className="text-label text-text-primary">{endTitle}</p>
                    <p className="text-caption mt-0.5 text-text-muted">{endBody}</p>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/*
             * Spoken progress: searching, loading more, then how many are on
             * screen. Always mounted so a screen reader hears each change.
             */}
            <p
              id="catalog-list-progress"
              role="status"
              aria-live="polite"
              className={
                lookingUp || (hasPages && products.length > 0 && !reachedEnd)
                  ? "text-caption tnum -mt-1 pb-2 text-center text-text-muted"
                  : "sr-only"
              }
            >
              {lookingUp ? (
                t("catalog.list.searching")
              ) : productsQuery.isFetchingNextPage ? (
                t("catalog.list.loadingMore")
              ) : !hasPages || products.length === 0 ? null : reachedEnd ? (
                // Two spans, not one joined sentence: Khmer and English end a
                // sentence differently, and each string already carries its own.
                <>
                  <span>{endTitle}</span> <span>{endBody}</span>
                </>
              ) : (
                t("catalog.list.showing", { count: products.length })
              )}
            </p>
          </div>
        )}
      </main>

      {canCreateProduct ? (
        <CreateProductSheet
          open={createOpen}
          onOpenChange={setCreateOpen}
          categories={activeCategories}
          canSetCost={canSetCost}
          onCreated={() => invalidateCatalog()}
        />
      ) : null}

      {canManageCategories ? (
        <CategorySheet
          open={categoriesOpen}
          onOpenChange={setCategoriesOpen}
          categories={categories}
          onChanged={() => {
            void queryClient.invalidateQueries({
              queryKey: catalogKeys.categories(userId, organizationId),
            });
            invalidateCatalog();
          }}
        />
      ) : null}

      <BottomNav />
    </ScreenBleed>
  );
}
