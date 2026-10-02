/**
 * /app/inventory/count — Stock Count.
 *
 *   location → scan / search a product → counted quantity → review difference
 *   → confirm adjustment → recorded
 *
 * Every decision is the server's (src/server/inventory/stock-count.ts and
 * migration 053's record_stock_count_v1):
 *   - the product is resolved inside the caller's organization — another
 *     tenant's barcode reads exactly like an unknown one;
 *   - the system quantity and the difference come from the ledger, for exactly
 *     the chosen location;
 *   - confirming re-derives the system quantity and refuses ("stale") if it
 *     moved since the review, so the adjustment written is always the one the
 *     merchant saw; it is one `manual_adjustment` movement, never a balance;
 *   - inventory.adjust is re-checked on every call. The capability checks here
 *     only decide what is offered.
 *
 * Duplicate safety: one count key per confirmed count, held across retries of
 * the same request and released once the server recorded it.
 *
 * No price, cost or customer data is shown or sent from this screen.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Camera,
  CheckCircle2,
  ClipboardCheck,
  Minus,
  Plus,
  ScanLine,
  Search,
  Equal,
} from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { AppHeader, ScreenBleed, Section } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CameraScanSheet } from "@/components/barcode/CameraScanSheet";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import { LocationChoice } from "@/components/inventory/LocationChoice";
import { SCAN_INPUT_ATTRIBUTE, useBarcodeScanner } from "@/hooks/use-barcode-scanner";
import { useCapabilities } from "@/hooks/use-capabilities";
import { HOME_QUERY_PREFIX } from "@/lib/home-query";
import { createIdempotencyKeyHolder } from "@/lib/idempotency";
import {
  enforceInventoryCachePrincipal,
  formatQuantity,
  inventoryKeys,
  listInventoryLocations,
  locationName,
  type InventoryLocation,
} from "@/lib/inventory";
import {
  MAX_SEARCH_LENGTH,
  classifyStockCountError,
  compareStockCount,
  directionLabelKey,
  formatDifference,
  getStockCountItem,
  normalizeSearchQuery,
  parseCountedQuantity,
  previewStockCount,
  recordStockCount,
  resolveStockCountScan,
  searchStockCountProducts,
  stockCountErrorKey,
  stockCountRequestFingerprint,
  stockCountResultMessageKey,
  stockCountScanMessageKey,
  type StockAdjustmentDirection,
  type StockCountComparison,
  type StockCountItem,
  type StockCountRecord,
  type StockCountSearchHit,
} from "@/lib/stock-count";

export const Route = createFileRoute("/app/inventory/count")({
  head: () => ({
    meta: [
      { title: "Stock count — APSA" },
      { name: "description", content: "Count stock and reconcile it with the inventory record." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: StockCountRoute,
});

function StockCountRoute() {
  const { session, organizationId } = Route.useRouteContext();
  // Keyed by principal: a different member or organization in this tab starts
  // from a blank count, never from the previous member's product or figures.
  return (
    <StockCountScreen
      key={`${session.userId}/${organizationId}`}
      userId={session.userId}
      organizationId={organizationId}
    />
  );
}

type Step =
  | { kind: "find" }
  | { kind: "count"; item: StockCountItem }
  | { kind: "review"; item: StockCountItem; preview: StockCountComparison }
  | { kind: "done"; item: StockCountItem; count: StockCountRecord; replayed: boolean };

function StockCountScreen({ userId, organizationId }: { userId: string; organizationId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();

  const identityOk =
    Boolean(userId) &&
    Boolean(organizationId) &&
    (capabilities.state !== "ready" || capabilities.organizationId === organizationId);
  enforceInventoryCachePrincipal(queryClient, userId, organizationId);

  const canCount =
    identityOk &&
    capabilities.can("inventory.adjust") &&
    capabilities.can("inventory.read") &&
    capabilities.can("products.read");

  const [step, setStep] = useState<Step>({ kind: "find" });
  const [locationId, setLocationId] = useState<string | null>(null);
  const [codeText, setCodeText] = useState("");
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<StockCountSearchHit[] | null>(null);
  const [findMessage, setFindMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [countedText, setCountedText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const keyHolder = useRef(createIdempotencyKeyHolder());

  const locationsQuery = useQuery({
    queryKey: inventoryKeys.locations(userId, organizationId),
    queryFn: () => listInventoryLocations(),
    enabled: canCount,
  });
  const allLocations: readonly InventoryLocation[] = locationsQuery.data ?? [];
  const activeLocations = allLocations.filter((location) => location.status === "active");

  function openItem(item: StockCountItem) {
    setCodeText("");
    setCountedText("");
    setFormError(null);
    setFindMessage(null);
    setStep({ kind: "count", item });
  }

  async function resolveCode(raw: string) {
    const code = raw.trim();
    if (code === "" || busy) return;
    setBusy(true);
    setFindMessage(null);
    try {
      const result = await resolveStockCountScan(code, locationId);
      if (result.kind === "item") openItem(result.item);
      else setFindMessage(t(stockCountScanMessageKey(result) ?? "stockCount.scan.notFound"));
    } catch (err) {
      setFindMessage(t(stockCountErrorKey(classifyStockCountError(err))));
    } finally {
      setBusy(false);
    }
  }

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    const query = normalizeSearchQuery(searchText);
    if (query === null || busy) return;
    setBusy(true);
    setFindMessage(null);
    try {
      setSearchResults(await searchStockCountProducts(query));
    } catch (err) {
      setSearchResults(null);
      setFindMessage(t(stockCountErrorKey(classifyStockCountError(err))));
    } finally {
      setBusy(false);
    }
  }

  async function chooseResult(hit: StockCountSearchHit) {
    if (busy) return;
    setBusy(true);
    setFindMessage(null);
    try {
      const result = await getStockCountItem(hit.variantId, locationId);
      if (result.kind === "item") openItem(result.item);
      else setFindMessage(t(stockCountResultMessageKey(result) ?? "stockCount.error.generic"));
    } catch (err) {
      setFindMessage(t(stockCountErrorKey(classifyStockCountError(err))));
    } finally {
      setBusy(false);
    }
  }

  // Wedge scanners work on the find step only; the camera sheet takes over
  // while it is open so one code never arrives twice.
  useBarcodeScanner({
    enabled: canCount && step.kind === "find" && !cameraOpen,
    onScan: (code) => void resolveCode(code),
  });

  function submitCode(event: FormEvent) {
    event.preventDefault();
    void resolveCode(codeText);
  }

  const counted = parseCountedQuantity(countedText);

  async function review(item: StockCountItem) {
    if (counted === null || busy) return;
    setBusy(true);
    setFormError(null);
    try {
      const result = await previewStockCount({
        variantId: item.variantId,
        locationId: item.locationId,
        countedQuantity: counted,
      });
      if (result.kind === "preview") {
        setStep({
          kind: "review",
          item: { ...item, systemQuantity: result.preview.systemQuantity },
          preview: result.preview,
        });
      } else {
        setFormError(t(stockCountResultMessageKey(result) ?? "stockCount.error.generic"));
      }
    } catch (err) {
      setFormError(t(stockCountErrorKey(classifyStockCountError(err))));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(item: StockCountItem, preview: StockCountComparison) {
    if (busy) return;
    const request = {
      variantId: item.variantId,
      locationId: item.locationId,
      countedQuantity: preview.countedQuantity,
      expectedSystemQuantity: preview.systemQuantity,
    };
    // Same request → same key, so a retry after a lost response is replayed
    // by the server instead of adjusting stock twice.
    const countKey = keyHolder.current.keyFor(stockCountRequestFingerprint(request));
    setBusy(true);
    setFormError(null);
    try {
      const result = await recordStockCount(countKey, request);
      if (result.kind === "recorded") {
        keyHolder.current.release();
        void queryClient.invalidateQueries({
          queryKey: inventoryKeys.principal(userId, organizationId),
        });
        // Home's out-of-stock count is computed from the same ledger.
        void queryClient.invalidateQueries({ queryKey: HOME_QUERY_PREFIX });
        setStep({ kind: "done", item, count: result.count, replayed: result.replayed });
        return;
      }
      if (result.kind === "stale") {
        // The ledger moved: show the new difference and ask again. Nothing
        // was written; the next confirm is a new request with a new key.
        keyHolder.current.release();
        setStep({
          kind: "review",
          item: { ...item, systemQuantity: result.systemQuantity },
          preview: compareStockCount(result.systemQuantity, preview.countedQuantity),
        });
      }
      if (result.kind === "count_conflict") keyHolder.current.release();
      setFormError(t(stockCountResultMessageKey(result) ?? "stockCount.error.generic"));
    } catch (err) {
      // Key kept: retrying the same request after a network failure must
      // reach the server under the same key.
      setFormError(t(stockCountErrorKey(classifyStockCountError(err))));
    } finally {
      setBusy(false);
    }
  }

  function countNext() {
    setStep({ kind: "find" });
    setCountedText("");
    setSearchText("");
    setSearchResults(null);
    setFormError(null);
    setFindMessage(null);
  }

  const searchQuery = normalizeSearchQuery(searchText);

  return (
    <ScreenBleed surface="raised" bottom="none">
      <AppHeader
        title={t("stockCount.title")}
        subtitle={t("stockCount.subtitle")}
        onBack={() => void navigate({ to: "/app/inventory" })}
      />

      <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 pb-6 lg:max-w-[var(--screen-max-wide)]">
        {!canCount ? (
          <CapabilityDeniedState capabilities={capabilities} />
        ) : (
          <div className="content-in flex flex-col gap-4">
            {step.kind === "find" ? (
              <>
                {activeLocations.length > 0 ? (
                  <Section title={t("stockCount.location.title")}>
                    <div className="flex flex-col gap-1.5">
                      <LocationChoice
                        locations={activeLocations}
                        value={locationId}
                        onChange={setLocationId}
                        disabled={busy}
                        label={t("stockCount.location.label")}
                        noneLabel={t("stockCount.location.none")}
                        className="mx-0 px-0"
                      />
                      <span className="text-caption text-text-secondary">
                        {t("stockCount.location.hint")}
                      </span>
                    </div>
                  </Section>
                ) : null}

                <Section title={t("stockCount.scan.title")}>
                  <form className="flex flex-col gap-2" onSubmit={submitCode}>
                    <Label htmlFor="count-code" className="text-label text-text-secondary">
                      {t("stockCount.scan.label")}
                    </Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id="count-code"
                        className="tnum h-12 min-w-0 flex-1"
                        value={codeText}
                        autoComplete="off"
                        autoFocus
                        disabled={busy}
                        aria-describedby="count-code-hint"
                        placeholder={t("stockCount.scan.placeholder")}
                        onChange={(event) => setCodeText(event.target.value)}
                        {...{ [SCAN_INPUT_ATTRIBUTE]: "" }}
                      />
                      <button
                        type="button"
                        aria-label={t("barcodeScanner.open")}
                        onClick={() => setCameraOpen(true)}
                        className="press-tactile tap-target flex size-12 shrink-0 items-center justify-center rounded-2xl border border-border-default bg-surface-primary text-text-primary"
                      >
                        <Camera className="size-5" aria-hidden />
                      </button>
                    </div>
                    <span id="count-code-hint" className="text-caption text-text-secondary">
                      {t("stockCount.scan.hint")}
                    </span>
                    <Button
                      type="submit"
                      variant="outline"
                      className="tap-target h-12 gap-2"
                      disabled={busy || codeText.trim() === ""}
                      aria-busy={busy}
                    >
                      <ScanLine className="size-4" aria-hidden />
                      {busy ? t("stockCount.scan.finding") : t("stockCount.scan.find")}
                    </Button>
                  </form>
                </Section>

                <Section title={t("stockCount.search.title")}>
                  <form className="flex flex-col gap-2" onSubmit={(event) => void runSearch(event)}>
                    <Label htmlFor="count-search" className="text-label text-text-secondary">
                      {t("stockCount.search.label")}
                    </Label>
                    <Input
                      id="count-search"
                      className="h-12"
                      value={searchText}
                      autoComplete="off"
                      maxLength={MAX_SEARCH_LENGTH}
                      disabled={busy}
                      aria-describedby="count-search-hint"
                      placeholder={t("stockCount.search.placeholder")}
                      onChange={(event) => setSearchText(event.target.value)}
                    />
                    <span id="count-search-hint" className="text-caption text-text-secondary">
                      {t("stockCount.search.hint")}
                    </span>
                    <Button
                      type="submit"
                      variant="outline"
                      className="tap-target h-12 gap-2"
                      disabled={busy || searchQuery === null}
                      aria-busy={busy}
                    >
                      <Search className="size-4" aria-hidden />
                      {busy ? t("stockCount.search.searching") : t("stockCount.search.find")}
                    </Button>
                  </form>
                  {searchResults !== null ? (
                    searchResults.length === 0 ? (
                      <p className="text-caption pt-2 text-text-secondary" role="status">
                        {t("stockCount.search.empty")}
                      </p>
                    ) : (
                      <ul
                        className="flex flex-col gap-2 pt-3"
                        aria-label={t("stockCount.search.results")}
                      >
                        {searchResults.map((hit) => (
                          <li key={hit.variantId}>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void chooseResult(hit)}
                              className="press tap-target flex w-full flex-col items-start gap-0.5 rounded-xl border border-border-default bg-surface-primary px-3 py-2 text-start"
                            >
                              <span className="text-label text-text-primary" lang="km">
                                {hit.productNameKm}
                              </span>
                              <span className="text-body-sm text-text-secondary">
                                {[
                                  hit.productNameEn,
                                  hit.variantName || t("inventoryList.unnamedVariant"),
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </span>
                              {hit.sku ? (
                                <span className="text-caption text-text-muted">
                                  {t("inventoryList.sku")}: <span className="tnum">{hit.sku}</span>
                                </span>
                              ) : null}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )
                  ) : null}
                </Section>

                <div role="status" aria-live="polite">
                  {findMessage ? (
                    <p className="text-caption text-status-warning-text">{findMessage}</p>
                  ) : null}
                </div>
              </>
            ) : null}

            {step.kind === "count" ? (
              <>
                <ItemSummary item={step.item} locations={allLocations} />
                <Section title={t("stockCount.count.title")}>
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="count-quantity" className="text-label text-text-secondary">
                        {t("stockCount.count.quantity")}
                      </Label>
                      <Input
                        id="count-quantity"
                        inputMode="numeric"
                        className="tnum h-12"
                        value={countedText}
                        autoFocus
                        disabled={busy}
                        aria-invalid={countedText !== "" && counted === null ? true : undefined}
                        aria-describedby="count-quantity-hint"
                        onChange={(event) => setCountedText(event.target.value)}
                      />
                      <span id="count-quantity-hint" className="text-caption text-text-secondary">
                        {t("stockCount.count.hint")}
                      </span>
                    </div>
                    {formError ? (
                      <p className="text-caption text-status-danger-text" role="alert">
                        {formError}
                      </p>
                    ) : null}
                    <Button
                      className="tap-target h-12 w-full gap-2"
                      disabled={busy || counted === null}
                      aria-busy={busy}
                      onClick={() => void review(step.item)}
                    >
                      <ClipboardCheck className="size-4" aria-hidden />
                      {busy
                        ? t("stockCount.count.reviewing")
                        : counted === null
                          ? t("stockCount.count.reviewEmpty")
                          : t("stockCount.count.review")}
                    </Button>
                    <Button
                      variant="outline"
                      className="tap-target h-12 w-full"
                      disabled={busy}
                      onClick={countNext}
                    >
                      {t("stockCount.count.scanAnother")}
                    </Button>
                  </div>
                </Section>
              </>
            ) : null}

            {step.kind === "review" ? (
              <>
                <ItemSummary item={step.item} locations={allLocations} />
                <Section title={t("stockCount.preview.title")}>
                  <div className="flex flex-col gap-4">
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
                      <dt className="text-body-sm text-text-secondary">
                        {t("stockCount.preview.system")}
                      </dt>
                      <dd className="text-financial tnum text-end text-text-primary">
                        {formatQuantity(step.preview.systemQuantity)}
                      </dd>
                      <dt className="text-body-sm text-text-secondary">
                        {t("stockCount.preview.counted")}
                      </dt>
                      <dd className="text-financial tnum text-end text-text-primary">
                        {formatQuantity(step.preview.countedQuantity)}
                      </dd>
                      <dt className="text-body-sm text-text-secondary">
                        {t("stockCount.preview.difference")}
                      </dt>
                      <dd className="text-financial tnum text-end text-text-primary">
                        {formatDifference(step.preview.difference)}
                      </dd>
                      <dt className="text-body-sm text-text-secondary">
                        {t("stockCount.preview.result")}
                      </dt>
                      <dd className="text-financial tnum text-end text-text-primary">
                        {formatQuantity(step.preview.resultingQuantity)}
                      </dd>
                    </dl>
                    <DirectionNote direction={step.preview.direction} />
                    {step.preview.direction !== "none" ? (
                      <p className="text-caption text-text-secondary">
                        {t("stockCount.preview.note")}
                      </p>
                    ) : null}
                    {formError ? (
                      <p className="text-caption text-status-danger-text" role="alert">
                        {formError}
                      </p>
                    ) : null}
                    <Button
                      className="tap-target h-12 w-full gap-2"
                      disabled={busy}
                      aria-busy={busy}
                      onClick={() => void confirm(step.item, step.preview)}
                    >
                      <CheckCircle2 className="size-4" aria-hidden />
                      {busy
                        ? t("inventory.saving")
                        : step.preview.direction === "none"
                          ? t("stockCount.preview.confirmNoChange")
                          : t("stockCount.preview.confirm", {
                              difference: formatDifference(step.preview.difference),
                            })}
                    </Button>
                    <Button
                      variant="outline"
                      className="tap-target h-12 w-full"
                      disabled={busy}
                      onClick={() => {
                        setFormError(null);
                        setStep({ kind: "count", item: step.item });
                      }}
                    >
                      {t("stockCount.preview.edit")}
                    </Button>
                  </div>
                </Section>
              </>
            ) : null}

            {step.kind === "done" ? (
              <Section>
                <div className="flex flex-col items-center gap-3 py-2 text-center" role="status">
                  <CheckCircle2 className="size-8 text-status-success" aria-hidden />
                  <p className="text-h3 text-text-primary">
                    {step.replayed
                      ? t("stockCount.done.replayedTitle")
                      : step.count.difference === 0
                        ? t("stockCount.done.noChangeTitle")
                        : t("stockCount.done.title", {
                            difference: formatDifference(step.count.difference),
                          })}
                  </p>
                  <p className="text-body-sm text-text-secondary" lang="km">
                    {step.item.productNameKm}
                    {step.item.variantName ? ` · ${step.item.variantName}` : ""}
                  </p>
                  <p className="text-body-sm text-text-secondary">
                    {t("stockCount.done.onHand")}{" "}
                    <span className="text-financial tnum text-text-primary">
                      {formatQuantity(step.count.countedQuantity)}
                    </span>
                  </p>
                  {step.replayed ? (
                    <p className="text-caption text-text-secondary">
                      {t("stockCount.done.replayedBody")}
                    </p>
                  ) : null}
                  <div className="flex w-full flex-col gap-2 pt-2">
                    <Button className="tap-target h-12 w-full gap-2" onClick={countNext}>
                      <ScanLine className="size-4" aria-hidden />
                      {t("stockCount.done.next")}
                    </Button>
                    <Link
                      to="/app/inventory/$variantId"
                      params={{ variantId: step.item.variantId }}
                      className="press text-label tap-target flex h-12 items-center justify-center rounded-xl border border-border-default text-text-primary"
                    >
                      {t("stockCount.done.viewStock")}
                    </Link>
                  </div>
                </div>
              </Section>
            ) : null}
          </div>
        )}
      </main>

      {canCount ? (
        <CameraScanSheet
          open={cameraOpen}
          onOpenChange={setCameraOpen}
          onCode={(code) => void resolveCode(code)}
        />
      ) : null}
    </ScreenBleed>
  );
}

/** Direction in words and an icon — never conveyed by color alone. */
function DirectionNote({ direction }: { direction: StockAdjustmentDirection }) {
  const { t } = useTranslation();
  const Icon = direction === "increase" ? Plus : direction === "decrease" ? Minus : Equal;
  return (
    <p className="text-label flex items-center gap-2 text-text-primary">
      <Icon className="size-4 shrink-0" aria-hidden />
      {t(directionLabelKey(direction))}
    </p>
  );
}

function ItemSummary({
  item,
  locations,
}: {
  item: StockCountItem;
  locations: readonly InventoryLocation[];
}) {
  const { t } = useTranslation();
  const place = locationName(item.locationId, locations);
  return (
    <Section title={t("stockCount.product.title")}>
      <div className="flex flex-col gap-1">
        <p className="text-label text-text-primary" lang="km">
          {item.productNameKm}
        </p>
        {item.productNameEn ? (
          <p className="text-body-sm text-text-secondary">{item.productNameEn}</p>
        ) : null}
        <p className="text-body-sm text-text-secondary">
          {item.variantName || t("inventoryList.unnamedVariant")}
        </p>
        <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
          {item.sku ? (
            <span className="text-caption text-text-muted">
              {t("inventoryList.sku")}: <span className="tnum">{item.sku}</span>
            </span>
          ) : null}
          {item.barcode ? (
            <span className="text-caption text-text-muted">
              {t("stockCount.product.barcode")}: <span className="tnum">{item.barcode}</span>
            </span>
          ) : null}
        </div>
        <p className="text-caption text-text-muted">
          {t("stockCount.product.location", {
            location: place ?? t("stockCount.location.none"),
          })}
        </p>
      </div>
    </Section>
  );
}
