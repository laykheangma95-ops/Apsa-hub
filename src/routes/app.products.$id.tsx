/**
 * /app/products/$id — one product: its details, its variants, and archiving.
 *
 * Everything on this screen is server-decided. The id in the URL is only ever
 * resolved inside the caller's own organization (repo.findProductById filters
 * on ctx.organizationId), so a product id copied from another business comes
 * back as a plain "not found" — the same answer as a made-up id, and nothing
 * is mutated on the way there.
 *
 * Cost is shown only when the server actually sent one. Without
 * products.view_cost the field is absent from the response and this screen
 * says so rather than inferring, defaulting, or back-calculating it.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Package, Pencil, Plus, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AppHeader,
  BottomSheet,
  Chip,
  ChipRow,
  DetailSkeleton,
  ScreenBleed,
  Section,
  StickyActionBar,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { OperationalState } from "@/components/common/OperationalState";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import { CategoryChoice } from "@/components/products/CategoryChoice";
import { VariantSheet } from "@/components/products/VariantSheet";
import { useCapabilities } from "@/hooks/use-capabilities";
import { notifyError, notifySuccess } from "@/lib/feedback";
import { formatMoney } from "@/lib/money";
import {
  CATALOG_QUERY_ROOT,
  archiveCatalogProduct,
  catalogErrorKey,
  catalogKeys,
  classifyCatalogError,
  enforceCatalogCachePrincipal,
  getCatalogProduct,
  isCatalogId,
  listCatalogCategories,
  updateCatalogProduct,
  updateCatalogVariant,
  visibleVariantCost,
  type CatalogProduct,
  type CatalogVariant,
} from "@/lib/catalog";

export const Route = createFileRoute("/app/products/$id")({
  head: () => ({
    meta: [
      { title: "Product — APSA" },
      { name: "description", content: "Product details, variants and prices." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ProductDetailScreen,
});

type VariantFilter = "ACTIVE" | "ARCHIVED";

function VariantRow({
  variant,
  canViewCost,
  canEdit,
  canArchive,
  busy,
  onEdit,
  onToggleStatus,
}: {
  variant: CatalogVariant;
  /**
   * The CURRENT capability, not a property of the cached variant. Passed
   * through rather than read off `variant.cost` directly so a revoked
   * products.view_cost masks the row immediately — see visibleVariantCost
   * in src/lib/catalog.ts.
   */
  canViewCost: boolean;
  canEdit: boolean;
  canArchive: boolean;
  busy: boolean;
  onEdit: () => void;
  onToggleStatus: () => void;
}) {
  const { t } = useTranslation();
  const archived = variant.status === "ARCHIVED";
  const cost = visibleVariantCost(variant, canViewCost);

  return (
    <li className="flex min-w-0 flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="text-label min-w-0 flex-1 text-text-primary">
          <span className="chip-text">{variant.name || t("catalog.variant.unnamed")}</span>
        </span>
        <span className="text-financial tnum shrink-0 text-text-primary">
          {formatMoney(variant.price)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {variant.sku ? (
          <span className="text-caption text-text-secondary">
            {t("catalog.variant.sku")}: <span className="tnum">{variant.sku}</span>
          </span>
        ) : null}
        {variant.barcode ? (
          <span className="text-caption text-text-secondary">
            {t("catalog.variant.barcode")}: <span className="tnum">{variant.barcode}</span>
          </span>
        ) : null}
        {variant.weightGrams !== null ? (
          <span className="text-caption text-text-secondary">
            {t("catalog.variant.weight")}: <span className="tnum">{variant.weightGrams}</span>
          </span>
        ) : null}
        {/*
         * `cost` is already masked by visibleVariantCost above: null both when
         * there is no cost recorded, when the server withheld it, and when
         * this row's cached data predates a since-revoked products.view_cost.
         * Never read `variant.cost` directly here.
         */}
        {cost ? (
          <span className="text-caption tnum text-text-secondary">
            {t("catalog.variant.cost")}: {formatMoney(cost)}
          </span>
        ) : null}
        {archived ? (
          <span className="text-label inline-flex items-center gap-1.5 rounded-full bg-surface-secondary px-2 py-0.5 text-text-secondary">
            <Archive className="size-3.5 shrink-0" aria-hidden />
            <span className="chip-text">{t("catalog.detail.variantsArchived")}</span>
          </span>
        ) : null}
      </div>

      {canEdit || canArchive ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {canEdit ? (
            <Button variant="outline" className="tap-target h-10" onClick={onEdit} disabled={busy}>
              <Pencil className="size-4" aria-hidden />
              {t("catalog.detail.editVariant")}
            </Button>
          ) : null}
          {canArchive ? (
            <Button
              variant="ghost"
              className="tap-target h-10"
              onClick={onToggleStatus}
              disabled={busy}
            >
              {archived ? (
                <RotateCcw className="size-4" aria-hidden />
              ) : (
                <Archive className="size-4" aria-hidden />
              )}
              {archived ? t("catalog.variant.restoreAction") : t("catalog.variant.archiveAction")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function ProductDetailScreen() {
  const { id } = Route.useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();

  /*
   * Identity for the catalog cache comes from the /app route guard's own
   * server-derived context — never from the capability snapshot. See
   * src/lib/catalog.ts's "React Query cache identity" section and the
   * matching comment in src/routes/app.products.tsx.
   */
  const { session, organizationId: routeOrganizationId } = Route.useRouteContext();
  const userId = session.userId;

  /*
   * Fail closed rather than fall back to a placeholder key: an incomplete
   * route identity, or a capability snapshot whose resolved organization has
   * diverged from the route's, disables every read and action on this screen
   * instead of guessing which principal's data to show.
   */
  const identityOk =
    Boolean(userId) &&
    Boolean(routeOrganizationId) &&
    (capabilities.state !== "ready" || capabilities.organizationId === routeOrganizationId);

  // Purges every catalog entry the instant this tab's principal changes —
  // independent, defense-in-depth isolation alongside Settings' full
  // queryClient.clear() on sign-out. A no-op unless the principal changed.
  enforceCatalogCachePrincipal(queryClient, userId, routeOrganizationId);

  const canReadProducts = identityOk && capabilities.can("products.read");
  const canUpdateBasic = identityOk && capabilities.can("products.update_basic");
  const canUpdatePrice = identityOk && capabilities.can("products.update_price");
  const canUpdateCost = identityOk && capabilities.can("products.update_cost");
  const canViewCost = identityOk && capabilities.can("products.view_cost");
  const canCreateProduct = identityOk && capabilities.can("products.create");
  const canArchiveProduct = identityOk && capabilities.can("products.archive");

  const organizationId = routeOrganizationId;

  /*
   * A malformed id is answered here instead of being sent to the server, which
   * would only reject it at the Zod validator anyway. This is presentation,
   * not a check: a well-formed id belonging to another organization looks
   * exactly like a valid one and is refused server-side, not here.
   */
  const idLooksValid = isCatalogId(id);

  const [variantFilter, setVariantFilter] = useState<VariantFilter>("ACTIVE");
  const [variantSheetOpen, setVariantSheetOpen] = useState(false);
  const [editingVariant, setEditingVariant] = useState<CatalogVariant | undefined>(undefined);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [variantBusyId, setVariantBusyId] = useState<string | null>(null);

  const productQuery = useQuery({
    // Archived variants are fetched too, so the Archived tab shows the truth
    // rather than an empty list. The read still requires products.read.
    queryKey: catalogKeys.product(userId, organizationId, id),
    queryFn: () => getCatalogProduct(id, true),
    enabled: canReadProducts && idLooksValid,
    retry: false,
  });

  const categoriesQuery = useQuery({
    queryKey: catalogKeys.categories(userId, organizationId),
    queryFn: () => listCatalogCategories(false),
    enabled: canReadProducts && canUpdateBasic,
  });

  const product = productQuery.data;
  const categories = useMemo(() => categoriesQuery.data ?? [], [categoriesQuery.data]);

  const [nameKm, setNameKm] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [descriptionKm, setDescriptionKm] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [nameTouched, setNameTouched] = useState(false);
  const [savingBasics, setSavingBasics] = useState(false);

  // Seed the form from the server's copy whenever a fresh one arrives, so the
  // fields always start from what is actually stored.
  useEffect(() => {
    if (!product) return;
    setNameKm(product.nameKm);
    setNameEn(product.nameEn ?? "");
    setDescriptionKm(product.descriptionKm ?? "");
    setCategoryId(product.categoryId);
    setNameTouched(false);
  }, [product]);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: [CATALOG_QUERY_ROOT, userId, organizationId] });
  }

  async function saveBasics() {
    if (!product) return;
    setNameTouched(true);
    if (nameKm.trim() === "") return;

    setSavingBasics(true);
    try {
      await updateCatalogProduct({
        productId: product.id,
        nameKm: nameKm.trim(),
        nameEn: nameEn.trim() === "" ? null : nameEn.trim(),
        descriptionKm: descriptionKm.trim() === "" ? null : descriptionKm.trim(),
        categoryId,
      });
      invalidate();
      notifySuccess(t("catalog.detail.saved"));
    } catch (err) {
      notifyError(t(catalogErrorKey(classifyCatalogError(err))));
    } finally {
      setSavingBasics(false);
    }
  }

  async function toggleVariantStatus(variant: CatalogVariant) {
    setVariantBusyId(variant.id);
    try {
      const next = variant.status === "ARCHIVED" ? "ACTIVE" : "ARCHIVED";
      await updateCatalogVariant({ variantId: variant.id, status: next });
      invalidate();
      notifySuccess(
        t(next === "ARCHIVED" ? "catalog.variant.archived" : "catalog.variant.restored"),
      );
    } catch (err) {
      notifyError(t(catalogErrorKey(classifyCatalogError(err))));
    } finally {
      setVariantBusyId(null);
    }
  }

  async function archive() {
    if (!product) return;
    setArchiving(true);
    try {
      await archiveCatalogProduct(product.id);
      invalidate();
      setArchiveOpen(false);
      notifySuccess(t("catalog.detail.archive.done"));
    } catch (err) {
      // The server's answer is reported as it is — a 409 or a refusal is never
      // presented as a success, and the product is left as the server left it.
      notifyError(t(catalogErrorKey(classifyCatalogError(err))));
    } finally {
      setArchiving(false);
    }
  }

  const notFound =
    !idLooksValid ||
    (productQuery.isError && classifyCatalogError(productQuery.error) === "not_found");

  const variants = useMemo(
    () => (product?.variants ?? []).filter((variant) => variant.status === variantFilter),
    [product, variantFilter],
  );

  const archived = product?.status === "ARCHIVED";
  const nameError = nameTouched && nameKm.trim() === "" ? t("catalog.detail.nameKmMissing") : null;

  return (
    <ScreenBleed surface="raised">
      <AppHeader
        title={product?.nameKm ?? t("catalog.detail.title")}
        onBack={() => void navigate({ to: "/app/products" })}
      />

      <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 pb-6 lg:max-w-[var(--screen-max-wide)]">
        {!canReadProducts ? <CapabilityDeniedState capabilities={capabilities} /> : null}

        {canReadProducts && notFound ? (
          <OperationalState
            title={t("catalog.detail.notFound.title")}
            body={t("catalog.detail.notFound.body")}
          />
        ) : null}

        {canReadProducts && !notFound && productQuery.isLoading ? <DetailSkeleton /> : null}

        {canReadProducts && !notFound && productQuery.isError ? (
          <OperationalState
            tone="danger"
            title={t("catalog.detail.error.title")}
            body={t("catalog.detail.error.body")}
            onRetry={() => void productQuery.refetch()}
          />
        ) : null}

        {canReadProducts && product ? (
          <div className="content-in flex flex-col gap-4">
            {archived ? (
              <p
                className="text-body-sm rounded-2xl border border-border-default bg-surface-secondary px-4 py-3 text-text-secondary"
                role="status"
              >
                {t("catalog.detail.archivedNotice")}
              </p>
            ) : null}

            {!canUpdateBasic ? (
              <p className="text-caption px-1 text-text-secondary" role="status">
                {t("catalog.detail.readOnly")}
              </p>
            ) : null}

            <Section title={t("catalog.detail.basics")}>
              <div className="space-y-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="detail-name-km" className="text-label text-text-secondary">
                    {t("catalog.detail.nameKm")}
                  </Label>
                  <Input
                    id="detail-name-km"
                    className="h-12"
                    lang="km"
                    value={nameKm}
                    disabled={!canUpdateBasic}
                    aria-invalid={nameError ? true : undefined}
                    onChange={(event) => setNameKm(event.target.value)}
                  />
                  {nameError ? (
                    <p className="text-caption text-status-danger-text" role="alert">
                      {nameError}
                    </p>
                  ) : (
                    <span className="text-caption text-text-secondary">
                      {t("catalog.detail.nameKmHint")}
                    </span>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="detail-name-en" className="text-label text-text-secondary">
                    {t("catalog.detail.nameEn")}
                  </Label>
                  <Input
                    id="detail-name-en"
                    className="h-12"
                    lang="en"
                    value={nameEn}
                    disabled={!canUpdateBasic}
                    onChange={(event) => setNameEn(event.target.value)}
                  />
                  <span className="text-caption text-text-secondary">
                    {t("catalog.detail.nameEnHint")}
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="detail-description-km" className="text-label text-text-secondary">
                    {t("catalog.detail.descriptionKm")}
                  </Label>
                  <Textarea
                    id="detail-description-km"
                    lang="km"
                    rows={3}
                    value={descriptionKm}
                    disabled={!canUpdateBasic}
                    onChange={(event) => setDescriptionKm(event.target.value)}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-label text-text-secondary">
                    {t("catalog.detail.category")}
                  </span>
                  <CategoryChoice
                    categories={categories}
                    value={categoryId}
                    onChange={setCategoryId}
                    label={t("catalog.detail.category")}
                    disabled={!canUpdateBasic}
                    noneLabel={t("catalog.detail.categoryNone")}
                    className="mx-0 px-0"
                  />
                </div>
              </div>
            </Section>

            <Section
              title={t("catalog.detail.variants")}
              {...(canCreateProduct
                ? {
                    action: (
                      <Button
                        variant="outline"
                        className="tap-target h-10"
                        onClick={() => {
                          setEditingVariant(undefined);
                          setVariantSheetOpen(true);
                        }}
                      >
                        <Plus className="size-4" aria-hidden />
                        {t("catalog.detail.addVariant")}
                      </Button>
                    ),
                  }
                : {})}
            >
              <div className="flex flex-col gap-3">
                <ChipRow label={t("catalog.detail.variants")} role="tablist" className="mx-0 px-0">
                  <Chip
                    role="tab"
                    selected={variantFilter === "ACTIVE"}
                    onClick={() => setVariantFilter("ACTIVE")}
                  >
                    {t("catalog.detail.variantsActive")}
                  </Chip>
                  <Chip
                    role="tab"
                    selected={variantFilter === "ARCHIVED"}
                    onClick={() => setVariantFilter("ARCHIVED")}
                  >
                    {t("catalog.detail.variantsArchived")}
                  </Chip>
                </ChipRow>

                {!canViewCost ? (
                  <p className="text-caption text-text-secondary">
                    {t("catalog.detail.costHidden")}
                  </p>
                ) : null}

                {variants.length === 0 ? (
                  <p className="text-body-sm text-text-secondary">
                    {t("catalog.detail.variantsEmpty")}
                  </p>
                ) : (
                  <ul className="divide-y divide-border-default">
                    {variants.map((variant) => (
                      <VariantRow
                        key={variant.id}
                        variant={variant}
                        canViewCost={canViewCost}
                        // Cost is never independently editable — editing it
                        // also requires products.update_basic (see
                        // variantFieldAccess in src/lib/catalog.ts) — so the
                        // Edit entry point only ever needs to check the two
                        // permissions that can unlock a field on their own.
                        canEdit={canUpdateBasic || canUpdatePrice}
                        canArchive={canUpdateBasic}
                        busy={variantBusyId === variant.id}
                        onEdit={() => {
                          setEditingVariant(variant);
                          setVariantSheetOpen(true);
                        }}
                        onToggleStatus={() => void toggleVariantStatus(variant)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </Section>
          </div>
        ) : null}
      </main>

      {canReadProducts && product ? (
        <StickyActionBar
          {...(canArchiveProduct && !archived
            ? {
                secondary: (
                  <Button
                    variant="ghost"
                    className="tap-target h-11 text-status-danger-text"
                    onClick={() => setArchiveOpen(true)}
                  >
                    <Archive className="size-4" aria-hidden />
                    {t("catalog.detail.archive.action")}
                  </Button>
                ),
              }
            : {})}
        >
          <Button
            className="tap-target h-12 w-full"
            disabled={!canUpdateBasic || savingBasics}
            onClick={() => void saveBasics()}
          >
            <Package className="size-4" aria-hidden />
            {savingBasics ? t("catalog.saving") : t("catalog.detail.save")}
          </Button>
        </StickyActionBar>
      ) : null}

      {product ? (
        <VariantSheet
          open={variantSheetOpen}
          onOpenChange={(next) => {
            setVariantSheetOpen(next);
            if (!next) setEditingVariant(undefined);
          }}
          productId={product.id}
          variant={editingVariant}
          permissions={{
            canCreate: canCreateProduct,
            canUpdateBasic,
            canUpdatePrice,
            canUpdateCost,
            canViewCost,
          }}
          onSaved={() => invalidate()}
        />
      ) : null}

      {product && canArchiveProduct ? (
        <BottomSheet
          open={archiveOpen}
          onOpenChange={setArchiveOpen}
          title={t("catalog.detail.archive.title")}
          description={t("catalog.detail.archive.body")}
          snap="peek"
        >
          <div className="space-y-3">
            <Button
              className="tap-target h-12 w-full"
              disabled={archiving}
              onClick={() => void archive()}
            >
              {archiving ? t("catalog.saving") : t("catalog.detail.archive.confirm")}
            </Button>
            <Button
              variant="outline"
              className="tap-target h-12 w-full"
              disabled={archiving}
              onClick={() => setArchiveOpen(false)}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </BottomSheet>
      ) : null}
    </ScreenBleed>
  );
}
