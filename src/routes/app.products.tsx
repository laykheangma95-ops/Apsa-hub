/**
 * /app/products — the merchant's product catalogue.
 *
 * Reads and writes go through src/lib/catalog.ts, which calls the existing
 * server functions in src/api/products.ts. The organization is resolved from
 * the caller's own DB membership inside those handlers and every action is
 * authorized again by src/server/products/service.ts, so the capability checks
 * on this screen decide what is *offered*, never what is *allowed*.
 *
 * The search box filters the products already loaded into this page. It is not
 * server search and the screen says so rather than implying the whole
 * catalogue was searched.
 */
import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, FolderTree, Package, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppHeader, BottomNav, Chip, ChipRow, ListSkeleton, ScreenBleed } from "@/design-system";
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
  CATALOG_PAGE_LIMIT,
  CATALOG_QUERY_ROOT,
  catalogKeys,
  categoryLabel,
  enforceCatalogCachePrincipal,
  listCatalogCategories,
  listCatalogProducts,
  productLeadPrice,
  searchLoadedProducts,
  type CatalogListStatus,
  type CatalogProduct,
} from "@/lib/catalog";

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
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
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
  const canSetCost = identityOk && capabilities.can("products.update_cost");

  const organizationId = routeOrganizationId;

  const productsQuery = useQuery({
    queryKey: catalogKeys.products(userId, organizationId, status, categoryId),
    queryFn: () => listCatalogProducts({ status, categoryId }),
    enabled: !detailOpen && canReadProducts,
  });

  const categoriesQuery = useQuery({
    queryKey: catalogKeys.categories(userId, organizationId),
    queryFn: () => listCatalogCategories(canManageCategories),
    enabled: !detailOpen && canReadProducts,
  });

  const products = useMemo(() => productsQuery.data ?? [], [productsQuery.data]);
  const categories = useMemo(() => categoriesQuery.data ?? [], [categoriesQuery.data]);
  const activeCategories = useMemo(
    () => categories.filter((category) => category.status === "ACTIVE"),
    [categories],
  );
  const visible = useMemo(() => searchLoadedProducts(products, search), [products, search]);
  const pageIsFull = products.length >= CATALOG_PAGE_LIMIT;

  /** Every catalog list/detail row for THIS principal, and nothing else. */
  function invalidateCatalog() {
    void queryClient.invalidateQueries({ queryKey: [CATALOG_QUERY_ROOT, userId, organizationId] });
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
                  value={search}
                  aria-label={t("catalog.list.searchPlaceholder")}
                  aria-describedby="catalog-search-scope"
                  placeholder={t("catalog.list.searchPlaceholder")}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              {/*
               * Said plainly, every time: this searches what is on screen. A
               * merchant who believes it searched the whole catalogue would
               * conclude a product does not exist when it simply is not on
               * this page.
               */}
              <span id="catalog-search-scope" className="text-caption px-1 text-text-secondary">
                {t("catalog.list.searchScope")}
              </span>
            </div>

            {pageIsFull ? (
              <p className="text-caption px-1 text-text-secondary" role="status">
                {t("catalog.list.pageLimit", { count: CATALOG_PAGE_LIMIT })}
              </p>
            ) : null}

            <div className="list-enter overflow-hidden rounded-2xl border border-border-default">
              {productsQuery.isLoading ? <ListSkeleton rows={6} /> : null}

              {productsQuery.isError ? (
                <OperationalState
                  tone="danger"
                  title={t("catalog.list.error.title")}
                  body={t("catalog.list.error.body")}
                  onRetry={() => void productsQuery.refetch()}
                  className="rounded-none border-0"
                />
              ) : null}

              {productsQuery.isSuccess && products.length === 0 ? (
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
              ) : null}

              {productsQuery.isSuccess && products.length > 0 && visible.length === 0 ? (
                <OperationalState
                  title={t("catalog.list.noMatches.title")}
                  body={t("catalog.list.noMatches.body")}
                  className="rounded-none border-0"
                />
              ) : null}

              {visible.map((product) => (
                <ProductRow key={product.id} product={product} />
              ))}
            </div>
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
