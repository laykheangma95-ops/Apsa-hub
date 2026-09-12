/**
 * /app/inventory/$variantId — one variant's stock: total, per location, history.
 *
 * The variant id in the URL is only ever resolved inside the caller's own
 * organization (getVariantStock filters on ctx.organizationId and rejects
 * anything else with "Variant not found"), so an id copied from another
 * business comes back as a plain not-found — the same answer as a made-up id,
 * and nothing is mutated on the way there.
 *
 * Four independent grants shape this screen, exactly as the server checks them:
 *   inventory.read            — the quantities and the per-location breakdown
 *   inventory.view_movements  — the movement history section
 *   inventory.receive_stock   — the Receive stock action
 *   inventory.adjust          — the Manual adjustment action
 *
 * None of them is inferred from a role name. A Cashier with inventory.read sees
 * stock and no admin actions; a Manager sees all four; and a member who loses
 * inventory.view_movements mid-session loses the cached history immediately,
 * not at the next refetch.
 *
 * Every quantity here comes from the ledger. There is no setStock path, and a
 * negative on-hand figure is rendered as itself.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin, PackagePlus, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AppHeader,
  DetailSkeleton,
  ScreenBleed,
  Section,
  StickyActionBar,
  Timeline,
  type TimelineItem,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { OperationalState } from "@/components/common/OperationalState";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import { ReceiveStockSheet } from "@/components/inventory/ReceiveStockSheet";
import { AdjustStockSheet } from "@/components/inventory/AdjustStockSheet";
import { useCapabilities } from "@/hooks/use-capabilities";
import { notifySuccess } from "@/lib/feedback";
import { catalogKeys, enforceCatalogCachePrincipal, getCatalogProduct } from "@/lib/catalog";
import {
  INVENTORY_QUERY_ROOT,
  MOVEMENT_PAGE_SIZE,
  classifyInventoryError,
  enforceInventoryCachePrincipal,
  enforceMovementHistoryCapability,
  formatMovementDelta,
  formatQuantity,
  getVariantStock,
  inventoryKeys,
  isInventoryId,
  listInventoryLocations,
  listMovementHistory,
  locationName,
  movementTypeLabelKey,
  stockState,
  type InventoryMovement,
  type InventoryLocation,
} from "@/lib/inventory";

export const Route = createFileRoute("/app/inventory/$variantId")({
  head: () => ({
    meta: [
      { title: "Stock item — APSA" },
      { name: "description", content: "On-hand stock and movement history for one variant." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: InventoryDetailScreen,
});

function movementTone(movement: InventoryMovement): NonNullable<TimelineItem["tone"]> {
  if (movement.movementType === "manual_adjustment") return "warning";
  return movement.quantityDelta < 0 ? "danger" : "success";
}

function InventoryDetailScreen() {
  const { variantId } = Route.useParams();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();

  /*
   * Identity for both caches comes from the /app route guard's own
   * server-derived context — never from the capability snapshot. See
   * src/lib/inventory.ts's "React Query cache identity" section.
   */
  const { session, organizationId: routeOrganizationId } = Route.useRouteContext();
  const userId = session.userId;

  const identityOk =
    Boolean(userId) &&
    Boolean(routeOrganizationId) &&
    (capabilities.state !== "ready" || capabilities.organizationId === routeOrganizationId);

  enforceInventoryCachePrincipal(queryClient, userId, routeOrganizationId);
  enforceCatalogCachePrincipal(queryClient, userId, routeOrganizationId);

  const canReadStock = identityOk && capabilities.can("inventory.read");
  const canReadProducts = identityOk && capabilities.can("products.read");
  /*
   * Movement history goes through canSensitive rather than can: the history is
   * the one payload on this screen whose mere display is a disclosure — it
   * names who moved stock, by how much, and why. It must not ride on a
   * retained capability snapshot whose latest refresh failed, because a
   * revocation landing in that unconfirmed window would still read as granted.
   * The quantities keep the ordinary stale-tolerant reader so a timed-out
   * background refresh does not blank the whole screen.
   */
  const canViewMovements = identityOk && capabilities.canSensitive("inventory.view_movements");
  const canReceiveStock = identityOk && capabilities.can("inventory.receive_stock");
  const canAdjustStock = identityOk && capabilities.can("inventory.adjust");

  /*
   * Evict cached movement history the moment this member may no longer see it.
   * Runs during render, not in an effect: an effect fires after children have
   * already rendered, which would let one frame of a revoked member's history
   * paint. A no-op while the grant holds.
   */
  enforceMovementHistoryCapability(queryClient, canViewMovements);

  const organizationId = routeOrganizationId;

  /*
   * A malformed id is answered here instead of being sent to the server, which
   * would only reject it at the Zod validator anyway. This is presentation,
   * not a check: a well-formed id belonging to another organization looks
   * exactly like a valid one and is refused server-side, not here.
   */
  const idLooksValid = isInventoryId(variantId);

  const [receiveOpen, setReceiveOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);

  const stockQuery = useQuery({
    queryKey: inventoryKeys.variantStock(userId, organizationId, variantId),
    queryFn: () => getVariantStock(variantId),
    enabled: canReadStock && idLooksValid,
    retry: false,
  });

  const stock = stockQuery.data;

  // Product identity comes from the Product domain's own read, authorized
  // there. The Inventory response carries no name, SKU or price by design.
  const productQuery = useQuery({
    queryKey: catalogKeys.product(userId, organizationId, stock?.productId ?? "unresolved"),
    queryFn: () => getCatalogProduct(stock!.productId, true),
    enabled: canReadStock && canReadProducts && Boolean(stock?.productId),
    retry: false,
  });

  const locationsQuery = useQuery({
    queryKey: inventoryKeys.locations(userId, organizationId),
    queryFn: () => listInventoryLocations(),
    enabled: canReadStock,
  });

  const movementsQuery = useInfiniteQuery({
    queryKey: inventoryKeys.movements(userId, organizationId, variantId),
    queryFn: ({ pageParam }) =>
      listMovementHistory({ variantId, limit: MOVEMENT_PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    // Server pagination, not a client-side slice of everything: a full page
    // means there may be more, and the next request asks for the next offset.
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === MOVEMENT_PAGE_SIZE
        ? pages.reduce((total, page) => total + page.length, 0)
        : undefined,
    enabled: canViewMovements && idLooksValid,
  });

  const locations: readonly InventoryLocation[] = useMemo(
    () => locationsQuery.data ?? [],
    [locationsQuery.data],
  );

  const variant = useMemo(
    () => productQuery.data?.variants.find((candidate) => candidate.id === variantId) ?? null,
    [productQuery.data, variantId],
  );

  const movements = useMemo(() => movementsQuery.data?.pages.flat() ?? [], [movementsQuery.data]);

  const timelineItems = useMemo<TimelineItem[]>(
    () =>
      movements.map((movement) => {
        const place = locationName(movement.locationId, locations);
        const when = new Date(movement.createdAt).toLocaleString(i18n.language);
        return {
          id: movement.id,
          // Business language, never the enum value: "Stock received", not
          // "restock"; "Sold", not "sale".
          title: `${t(movementTypeLabelKey(movement.movementType))} · ${formatMovementDelta(movement.quantityDelta)}`,
          ...(movement.reason ? { detail: movement.reason } : {}),
          meta: place ? `${when} · ${place}` : when,
          tone: movementTone(movement),
        };
      }),
    [movements, locations, i18n.language, t],
  );

  const notFound =
    !idLooksValid ||
    (stockQuery.isError && classifyInventoryError(stockQuery.error) === "not_found");

  /** Every inventory and catalog row for THIS principal, and nothing else. */
  function refreshAfterMovement() {
    void queryClient.invalidateQueries({
      queryKey: [INVENTORY_QUERY_ROOT, userId, organizationId],
    });
    notifySuccess(t("inventory.movementRecorded"));
  }

  const variantLabel = variant
    ? `${productQuery.data?.nameKm ?? ""} · ${variant.name || t("inventoryList.unnamedVariant")}`
    : t("inventoryDetail.title");

  const quantity = stock?.quantityOnHand ?? 0;
  const state = stockState(quantity);
  const showActions = Boolean(stock) && (canReceiveStock || canAdjustStock);

  return (
    <ScreenBleed surface="raised">
      <AppHeader
        title={productQuery.data?.nameKm ?? t("inventoryDetail.title")}
        {...(variant?.name ? { subtitle: variant.name } : {})}
        onBack={() => void navigate({ to: "/app/inventory" })}
      />

      <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 pb-6 lg:max-w-[var(--screen-max-wide)]">
        {!canReadStock ? <CapabilityDeniedState capabilities={capabilities} /> : null}

        {canReadStock && notFound ? (
          <OperationalState
            title={t("inventoryDetail.notFound.title")}
            body={t("inventoryDetail.notFound.body")}
          />
        ) : null}

        {canReadStock && !notFound && stockQuery.isLoading ? <DetailSkeleton /> : null}

        {canReadStock && !notFound && stockQuery.isError ? (
          <OperationalState
            tone="danger"
            title={t("inventoryDetail.error.title")}
            body={t("inventoryDetail.error.body")}
            onRetry={() => void stockQuery.refetch()}
          />
        ) : null}

        {canReadStock && stock ? (
          <div className="content-in flex flex-col gap-4">
            {/* ── On hand ─────────────────────────────────────────────── */}
            <Section title={t("inventoryDetail.onHand")}>
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span
                    className={
                      state === "negative"
                        ? "text-h1 tnum text-status-danger-text"
                        : "text-h1 tnum text-text-primary"
                    }
                  >
                    {formatQuantity(quantity)}
                  </span>
                  <span className="text-caption text-text-secondary">
                    {t("inventoryDetail.units")}
                  </span>
                </div>

                {/*
                 * A negative balance is stated in words as well as shown as a
                 * number. It is never corrected to zero: it means more was sold
                 * than the ledger says was received, and that is the thing the
                 * merchant has to fix.
                 */}
                {state === "negative" ? (
                  <p
                    className="text-body-sm flex items-start gap-2 rounded-xl bg-status-danger-soft px-3 py-2 text-status-danger-text"
                    role="status"
                  >
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span>{t("inventoryDetail.negativeNotice")}</span>
                  </p>
                ) : null}

                {state === "zero" ? (
                  <p className="text-body-sm text-text-secondary" role="status">
                    {t("inventoryDetail.zeroNotice")}
                  </p>
                ) : null}

                {variant ? (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {variant.sku ? (
                      <span className="text-caption text-text-secondary">
                        {t("inventoryList.sku")}: <span className="tnum">{variant.sku}</span>
                      </span>
                    ) : null}
                    <span className="text-caption text-text-secondary">
                      {t(
                        variant.status === "ARCHIVED"
                          ? "inventoryDetail.variantArchived"
                          : "inventoryDetail.variantActive",
                      )}
                    </span>
                  </div>
                ) : null}

                {!canReadProducts ? (
                  <p className="text-caption text-text-secondary" role="status">
                    {t("inventoryDetail.noCatalogAccess")}
                  </p>
                ) : null}
              </div>
            </Section>

            {/* ── Per location ────────────────────────────────────────── */}
            <Section title={t("inventoryDetail.byLocation")}>
              {stock.byLocation.length === 0 ? (
                <p className="text-body-sm text-text-secondary">
                  {t("inventoryDetail.noLocationRows")}
                </p>
              ) : (
                <ul className="divide-y divide-border-default">
                  {stock.byLocation.map((row) => {
                    const place = locationName(row.locationId, locations);
                    const rowState = stockState(row.quantityOnHand);
                    return (
                      <li
                        key={row.locationId ?? "no-location"}
                        className="flex min-w-0 items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-2">
                          <MapPin className="size-4 shrink-0 text-text-muted" aria-hidden />
                          <span className="text-body-sm min-w-0 text-text-primary">
                            <span className="chip-text">
                              {place ??
                                (row.locationId === null
                                  ? t("inventoryDetail.unassignedLocation")
                                  : t("inventoryDetail.unknownLocation"))}
                            </span>
                          </span>
                        </span>
                        <span
                          className={
                            rowState === "negative"
                              ? "text-financial tnum shrink-0 text-status-danger-text"
                              : "text-financial tnum shrink-0 text-text-primary"
                          }
                        >
                          {formatQuantity(row.quantityOnHand)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>

            {/* ── Movement history ────────────────────────────────────── */}
            {canViewMovements ? (
              <Section title={t("movementHistory.title")}>
                <div className="flex flex-col gap-3">
                  {movementsQuery.isLoading ? (
                    <p className="text-body-sm text-text-secondary" role="status">
                      {t("movementHistory.loading")}
                    </p>
                  ) : null}

                  {movementsQuery.isError ? (
                    <OperationalState
                      tone="danger"
                      title={t("movementHistory.error.title")}
                      body={t("movementHistory.error.body")}
                      onRetry={() => void movementsQuery.refetch()}
                      className="rounded-xl"
                    />
                  ) : null}

                  {!movementsQuery.isLoading &&
                  !movementsQuery.isError &&
                  movements.length === 0 ? (
                    <p className="text-body-sm text-text-secondary">{t("movementHistory.empty")}</p>
                  ) : null}

                  {timelineItems.length > 0 ? <Timeline items={timelineItems} /> : null}

                  {movementsQuery.hasNextPage ? (
                    <Button
                      variant="outline"
                      className="tap-target h-11 w-full"
                      disabled={movementsQuery.isFetchingNextPage}
                      onClick={() => void movementsQuery.fetchNextPage()}
                    >
                      {movementsQuery.isFetchingNextPage
                        ? t("movementHistory.loading")
                        : t("movementHistory.loadMore")}
                    </Button>
                  ) : null}
                </div>
              </Section>
            ) : (
              /*
               * Said plainly rather than left blank: stock is visible to this
               * member, the history behind it is a separate grant they do not
               * hold. The message names no movement, actor or reason.
               */
              <Section title={t("movementHistory.title")}>
                <p className="text-body-sm text-text-secondary" role="status">
                  {t("movementHistory.denied")}
                </p>
              </Section>
            )}
          </div>
        ) : null}
      </main>

      {/*
       * Both actions are offered only with the permission the server demands
       * for that movement type — never by role name. A member without either
       * sees no action bar at all, and a member who somehow reached the call
       * anyway is refused by src/server/inventory/service.ts.
       */}
      {showActions ? (
        <StickyActionBar
          {...(canReceiveStock && canAdjustStock
            ? {
                secondary: (
                  <Button
                    variant="ghost"
                    className="tap-target h-11"
                    onClick={() => setAdjustOpen(true)}
                  >
                    <SlidersHorizontal className="size-4" aria-hidden />
                    {t("stockAdjustment.action")}
                  </Button>
                ),
              }
            : {})}
        >
          {canReceiveStock ? (
            <Button className="tap-target h-12 w-full" onClick={() => setReceiveOpen(true)}>
              <PackagePlus className="size-4" aria-hidden />
              {t("receiveStock.action")}
            </Button>
          ) : (
            <Button
              variant="outline"
              className="tap-target h-12 w-full"
              onClick={() => setAdjustOpen(true)}
            >
              <SlidersHorizontal className="size-4" aria-hidden />
              {t("stockAdjustment.action")}
            </Button>
          )}
        </StickyActionBar>
      ) : null}

      {canReceiveStock && stock ? (
        <ReceiveStockSheet
          open={receiveOpen}
          onOpenChange={setReceiveOpen}
          productId={stock.productId}
          variantId={stock.variantId}
          variantLabel={variantLabel}
          locations={locations}
          onRecorded={refreshAfterMovement}
        />
      ) : null}

      {canAdjustStock && stock ? (
        <AdjustStockSheet
          open={adjustOpen}
          onOpenChange={setAdjustOpen}
          productId={stock.productId}
          variantId={stock.variantId}
          variantLabel={variantLabel}
          quantityOnHand={quantity}
          locations={locations}
          onRecorded={refreshAfterMovement}
        />
      ) : null}
    </ScreenBleed>
  );
}
