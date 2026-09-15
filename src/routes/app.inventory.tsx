/**
 * /app/inventory — the merchant's stock workspace.
 *
 * Two domains, joined for display only:
 *   - the Product catalogue says what a variant IS (name, SKU, status);
 *   - the Inventory ledger says how much of it is ON HAND.
 *
 * The ledger is the only stock authority on this screen. `CatalogProduct.stock`
 * is null by design and is never read here — a quantity shown to a merchant
 * always traces back to `inventory_stock`, the live aggregate over
 * `inventory_movements`, computed server-side.
 *
 * Reads go through src/lib/inventory.ts and src/lib/catalog.ts, which call the
 * existing server functions. Organization is resolved from the caller's own DB
 * membership inside those handlers and every read is authorized again by
 * src/server/inventory/service.ts and src/server/products/service.ts, so the
 * capability checks here decide what is *offered*, never what is *allowed*.
 *
 * Negative quantities are rendered exactly as the ledger reports them. Nothing
 * on this screen clamps a negative on-hand figure to zero.
 */
import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, PackageX, Search, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppHeader, BottomNav, Chip, ChipRow, ListSkeleton, ScreenBleed } from "@/design-system";
import { Input } from "@/components/ui/input";
import { OperationalState } from "@/components/common/OperationalState";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import { useCapabilities } from "@/hooks/use-capabilities";
import {
  CATALOG_PAGE_LIMIT,
  enforceCatalogCachePrincipal,
  catalogKeys,
  listCatalogProducts,
} from "@/lib/catalog";
import {
  INVENTORY_LIST_LIMIT,
  buildInventoryRows,
  enforceInventoryCachePrincipal,
  formatQuantity,
  inventoryKeys,
  listOrganizationStock,
  searchLoadedInventory,
  stockState,
  type InventoryRow,
} from "@/lib/inventory";

export const Route = createFileRoute("/app/inventory")({
  head: () => ({
    meta: [
      { title: "Stock — APSA" },
      {
        name: "description",
        content: "What you have on hand, variant by variant, straight from the stock ledger.",
      },
      { property: "og:title", content: "Stock — APSA" },
      { property: "og:description", content: "On-hand quantities for everything you sell." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: InventoryListScreen,
});

/** The scan filters this screen offers. No threshold model — three plain facts. */
const STOCK_FILTERS = ["all", "negative", "zero"] as const;
type StockFilter = (typeof STOCK_FILTERS)[number];

function matchesFilter(row: InventoryRow, filter: StockFilter): boolean {
  if (filter === "all") return true;
  // A row whose quantity was not covered by this read is not claimed to be
  // anything, so it never satisfies a quantity filter.
  if (row.quantityOnHand === null) return false;
  return stockState(row.quantityOnHand) === filter;
}

/**
 * The number, and only the number, in the row's right-hand column.
 *
 * The written state marker deliberately does NOT live here. A Khmer label
 * ("ក្រោមសូន្យ") does not truncate, so a chip in this column makes the column
 * as wide as the label and squeezes the product name down to two or three
 * characters per line on a 320px phone. The label belongs beside the name,
 * where it can wrap into the flow; the quantity stays here, narrow and
 * `tnum`-aligned, as the thing the merchant scans down the right edge.
 */
function QuantityValue({ quantityOnHand }: { quantityOnHand: number | null }) {
  const { t } = useTranslation();

  /*
   * An uncovered quantity says so in words, never as 0 — "we did not read
   * this" and "there is none" are different facts and a merchant would
   * restock on the wrong one.
   */
  if (quantityOnHand === null) {
    return (
      <span className="text-caption shrink-0 text-text-muted">{t("inventoryList.unknownQty")}</span>
    );
  }

  return (
    <span
      className={
        stockState(quantityOnHand) === "negative"
          ? "text-financial tnum shrink-0 text-status-danger-text"
          : "text-financial tnum shrink-0 text-text-primary"
      }
    >
      {formatQuantity(quantityOnHand)}
    </span>
  );
}

/**
 * The written state marker: zero and below-zero, said in words.
 *
 * Status is never colour alone — each marker carries its own icon and label,
 * and `chip-text` lets a Khmer label wrap instead of clipping. A positive
 * quantity gets no marker: the number already says it, and there is no
 * low-stock threshold in this phase to invent one from.
 */
function StockStateMarker({ quantityOnHand }: { quantityOnHand: number | null }) {
  const { t } = useTranslation();
  if (quantityOnHand === null) return null;

  const state = stockState(quantityOnHand);
  if (state === "positive") return null;

  const negative = state === "negative";
  return (
    <span
      className={
        negative
          ? "text-label inline-flex max-w-full items-center gap-1 rounded-full bg-status-danger-soft px-2 py-0.5 text-status-danger-text"
          : "text-label inline-flex max-w-full items-center gap-1 rounded-full bg-surface-secondary px-2 py-0.5 text-text-secondary"
      }
    >
      {negative ? (
        <TriangleAlert className="size-3 shrink-0" aria-hidden />
      ) : (
        <PackageX className="size-3 shrink-0" aria-hidden />
      )}
      <span className="chip-text">
        {t(negative ? "inventoryList.state.negative" : "inventoryList.state.zero")}
      </span>
    </span>
  );
}

function InventoryListRow({ row }: { row: InventoryRow }) {
  const { t } = useTranslation();

  return (
    <Link
      to="/app/inventory/$variantId"
      params={{ variantId: row.variantId }}
      className="press flex w-full items-start justify-between gap-3 border-b border-border-default bg-surface-primary px-4 py-3 text-left last:border-b-0 hover:bg-surface-secondary"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-label min-w-0 text-text-primary" lang="km">
          <span className="chip-text">{row.productNameKm}</span>
        </span>
        {row.variantName ? (
          <span className="text-caption min-w-0 text-text-secondary">
            <span className="chip-text">{row.variantName}</span>
          </span>
        ) : (
          <span className="text-caption text-text-muted">{t("inventoryList.unnamedVariant")}</span>
        )}
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {row.sku ? (
            <span className="text-caption text-text-muted">
              {t("inventoryList.sku")}: <span className="tnum">{row.sku}</span>
            </span>
          ) : null}
          <StockStateMarker quantityOnHand={row.quantityOnHand} />
        </span>
      </span>

      <QuantityValue quantityOnHand={row.quantityOnHand} />
    </Link>
  );
}

function InventoryListScreen() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const detailOpen = pathname !== "/app/inventory" && pathname.startsWith("/app/inventory/");

  /*
   * Identity for both caches comes from the /app route guard's own
   * server-derived context (validated session + DB membership) — never from
   * the capability snapshot, which is presentation data fetched on a separate
   * request. It must include the user, not just the organization: two members
   * of one organization hold different inventory grants, and an
   * organization-only key would let one member's cached data be read back for
   * the next member who signs in to the same tab.
   */
  const { session, organizationId: routeOrganizationId } = Route.useRouteContext();
  const userId = session.userId;

  /*
   * Fail closed rather than fall back to a placeholder key: if the route's own
   * identity is incomplete, or the capability snapshot's resolved organization
   * has diverged from the route's (a stale snapshot mid organization switch),
   * nothing is fetched and nothing is offered.
   */
  const identityOk =
    Boolean(userId) &&
    Boolean(routeOrganizationId) &&
    (capabilities.state !== "ready" || capabilities.organizationId === routeOrganizationId);

  // Purges every inventory/catalog entry the instant this tab's principal
  // changes — independent, defense-in-depth isolation alongside Settings' full
  // queryClient.clear() on sign-out. No-ops unless the principal changed.
  enforceInventoryCachePrincipal(queryClient, userId, routeOrganizationId);
  enforceCatalogCachePrincipal(queryClient, userId, routeOrganizationId);

  const [filter, setFilter] = useState<StockFilter>("all");
  const [search, setSearch] = useState("");

  /*
   * inventory.read is what listOrganizationStock requires; products.read is
   * what getProductCatalog requires. They are separate grants, so they are
   * checked separately rather than collapsed into one "can use this screen".
   */
  const canReadStock = identityOk && capabilities.can("inventory.read");
  const canReadProducts = identityOk && capabilities.can("products.read");

  const organizationId = routeOrganizationId;

  const stockQuery = useQuery({
    queryKey: inventoryKeys.stockList(userId, organizationId),
    queryFn: () => listOrganizationStock(INVENTORY_LIST_LIMIT),
    enabled: !detailOpen && canReadStock,
  });

  const productsQuery = useQuery({
    // The same key the catalogue screen uses, so the two share one cached read
    // rather than each paying for its own.
    queryKey: catalogKeys.products(userId, organizationId, "ACTIVE", null),
    queryFn: () => listCatalogProducts({ status: "ACTIVE", categoryId: null }),
    enabled: !detailOpen && canReadStock && canReadProducts,
  });

  const products = useMemo(() => productsQuery.data ?? [], [productsQuery.data]);
  const rows = useMemo(
    () => buildInventoryRows(products, stockQuery.data),
    [products, stockQuery.data],
  );
  const filtered = useMemo(() => rows.filter((row) => matchesFilter(row, filter)), [rows, filter]);
  const visible = useMemo(() => searchLoadedInventory(filtered, search), [filtered, search]);

  /*
   * Either read being partial makes the whole list partial: the catalogue page
   * caps the products it identifies, and the stock read caps the variants it
   * covers. Both are said out loud rather than leaving the merchant to assume
   * they are looking at everything.
   */
  const stockTruncated = stockQuery.data?.truncated ?? false;
  const catalogPageIsFull = products.length >= CATALOG_PAGE_LIMIT;

  const loading = stockQuery.isLoading || productsQuery.isLoading;
  const failed = stockQuery.isError || productsQuery.isError;

  if (detailOpen) return <Outlet />;

  return (
    <ScreenBleed bottom="nav" surface="raised">
      <AppHeader title={t("inventoryList.title")} subtitle={t("inventoryList.subtitle")} />

      <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 lg:max-w-[var(--screen-max-wide)]">
        {/*
         * The denial returns before the search box and the filters, so a member
         * without inventory.read is never shown controls over stock they cannot
         * read — and the denial itself names no product, count or organization.
         */}
        {!canReadStock ? (
          <CapabilityDeniedState capabilities={capabilities} />
        ) : !canReadProducts ? (
          /*
           * Stock is readable but the catalogue is not, so there is no honest
           * way to say WHICH variant a quantity belongs to. Showing bare ids
           * would be worse than saying so.
           */
          <OperationalState
            title={t("inventoryList.needsCatalog.title")}
            body={t("inventoryList.needsCatalog.body")}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <ChipRow label={t("inventoryList.filterLabel")} role="tablist">
              {STOCK_FILTERS.map((option) => (
                <Chip
                  key={option}
                  role="tab"
                  selected={filter === option}
                  onClick={() => setFilter(option)}
                >
                  {t(`inventoryList.filter.${option}`)}
                </Chip>
              ))}
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
                  aria-label={t("inventoryList.searchPlaceholder")}
                  aria-describedby="inventory-search-scope"
                  placeholder={t("inventoryList.searchPlaceholder")}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <span id="inventory-search-scope" className="text-caption px-1 text-text-secondary">
                {t("inventoryList.searchScope")}
              </span>
            </div>

            {stockTruncated ? (
              <p className="text-caption px-1 text-text-secondary" role="status">
                {t("inventoryList.stockTruncated", { count: INVENTORY_LIST_LIMIT })}
              </p>
            ) : null}

            {catalogPageIsFull ? (
              <p className="text-caption px-1 text-text-secondary" role="status">
                {t("inventoryList.catalogPageLimit", { count: CATALOG_PAGE_LIMIT })}
              </p>
            ) : null}

            <div className="list-enter overflow-hidden rounded-2xl border border-border-default">
              {loading ? <ListSkeleton rows={6} /> : null}

              {failed ? (
                <OperationalState
                  tone="danger"
                  title={t("inventoryList.error.title")}
                  body={t("inventoryList.error.body")}
                  onRetry={() => {
                    void stockQuery.refetch();
                    void productsQuery.refetch();
                  }}
                  className="rounded-none border-0"
                />
              ) : null}

              {!loading && !failed && rows.length === 0 ? (
                <OperationalState
                  title={t("inventoryList.empty.title")}
                  body={t("inventoryList.empty.body")}
                  className="rounded-none border-0"
                />
              ) : null}

              {!loading && !failed && rows.length > 0 && visible.length === 0 ? (
                <OperationalState
                  title={t("inventoryList.noMatches.title")}
                  body={t("inventoryList.noMatches.body")}
                  className="rounded-none border-0"
                />
              ) : null}

              {visible.map((row) => (
                <InventoryListRow key={row.variantId} row={row} />
              ))}
            </div>

            {!loading && !failed && visible.length > 0 ? (
              <p className="text-caption flex items-center gap-1.5 px-1 text-text-muted">
                <Boxes className="size-3.5 shrink-0" aria-hidden />
                {t("inventoryList.ledgerNote")}
              </p>
            ) : null}
          </div>
        )}
      </main>

      <BottomNav />
    </ScreenBleed>
  );
}
