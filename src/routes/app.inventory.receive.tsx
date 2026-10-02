/**
 * /app/inventory/receive — Receive Inventory.
 *
 *   (optional) supplier → scan / type a barcode → confirm quantity → recorded
 *
 * Every decision is the server's (src/server/inventory/receiving.ts):
 *   - the code is resolved inside the caller's organization — another tenant's
 *     barcode reads exactly like an unknown one;
 *   - the receipt appends one `restock` movement to the ledger and the new
 *     balance is derived from the ledger, never written;
 *   - inventory.receive_stock is re-checked on every call. The capability
 *     checks here only decide what is offered.
 *
 * Duplicate safety: one receipt key per receipt, held across retries of the
 * same request (a lost response, a double tap) and released once the server
 * confirmed it. A repeated key is replayed by the server without adding stock.
 *
 * No price, cost or customer data is shown or sent from this screen.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, CheckCircle2, PackagePlus, ScanLine } from "lucide-react";
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
  type InventoryLocation,
} from "@/lib/inventory";
import {
  MAX_SUPPLIER_NAME_LENGTH,
  classifyReceivingError,
  isSupplierInputValid,
  normalizeSupplierInput,
  parseReceiveQuantity,
  receiptRequestFingerprint,
  receiveInventory,
  receiveResultMessageKey,
  receivingErrorKey,
  receivingScanMessageKey,
  resolveReceivingScan,
  type InventoryReceipt,
  type ReceivingProduct,
} from "@/lib/receiving";

export const Route = createFileRoute("/app/inventory/receive")({
  head: () => ({
    meta: [
      { title: "Receive stock — APSA" },
      { name: "description", content: "Scan products and record stock as it arrives." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ReceiveRoute,
});

function ReceiveRoute() {
  const { session, organizationId } = Route.useRouteContext();
  // Keyed by principal: a different member or organization in this tab starts
  // from a blank receipt, never from the previous member's scanned product.
  return (
    <ReceiveScreen
      key={`${session.userId}/${organizationId}`}
      userId={session.userId}
      organizationId={organizationId}
    />
  );
}

type Step =
  | { kind: "scan" }
  | { kind: "confirm"; product: ReceivingProduct }
  | {
      kind: "done";
      product: ReceivingProduct;
      receipt: InventoryReceipt;
      replayed: boolean;
      quantityOnHand: number | null;
    };

function ReceiveScreen({ userId, organizationId }: { userId: string; organizationId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();

  const identityOk =
    Boolean(userId) &&
    Boolean(organizationId) &&
    (capabilities.state !== "ready" || capabilities.organizationId === organizationId);
  enforceInventoryCachePrincipal(queryClient, userId, organizationId);

  const canReceive =
    identityOk && capabilities.can("inventory.receive_stock") && capabilities.can("products.read");
  const canReadStock = identityOk && capabilities.can("inventory.read");

  const [step, setStep] = useState<Step>({ kind: "scan" });
  const [supplierText, setSupplierText] = useState("");
  const [codeText, setCodeText] = useState("");
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [quantityText, setQuantityText] = useState("");
  const [locationId, setLocationId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const keyHolder = useRef(createIdempotencyKeyHolder());

  const locationsQuery = useQuery({
    queryKey: inventoryKeys.locations(userId, organizationId),
    queryFn: () => listInventoryLocations(),
    enabled: canReceive && canReadStock,
  });
  const activeLocations: readonly InventoryLocation[] = (locationsQuery.data ?? []).filter(
    (location) => location.status === "active",
  );

  async function resolveCode(raw: string) {
    const code = raw.trim();
    if (code === "" || resolving) return;
    setResolving(true);
    setScanMessage(null);
    try {
      const result = await resolveReceivingScan(code);
      if (result.kind === "product") {
        setCodeText("");
        setQuantityText("");
        setFormError(null);
        setStep({ kind: "confirm", product: result.product });
      } else {
        setScanMessage(t(receivingScanMessageKey(result) ?? "receiving.scan.notFound"));
      }
    } catch (err) {
      setScanMessage(t(receivingErrorKey(classifyReceivingError(err))));
    } finally {
      setResolving(false);
    }
  }

  // Wedge scanners work on the scan step only; the camera sheet takes over
  // while it is open so one code never arrives twice.
  useBarcodeScanner({
    enabled: canReceive && step.kind === "scan" && !cameraOpen,
    onScan: (code) => void resolveCode(code),
  });

  function submitCode(event: FormEvent) {
    event.preventDefault();
    void resolveCode(codeText);
  }

  const supplierValid = isSupplierInputValid(supplierText);
  const quantity = parseReceiveQuantity(quantityText);

  async function confirmReceipt(product: ReceivingProduct) {
    if (quantity === null || !supplierValid || saving) return;
    const request = {
      variantId: product.variantId,
      quantity,
      locationId,
      supplierName: normalizeSupplierInput(supplierText),
    };
    // Same request → same key, so a retry after a lost response is replayed
    // by the server instead of receiving the stock twice.
    const receiptKey = keyHolder.current.keyFor(receiptRequestFingerprint(request));
    setSaving(true);
    setFormError(null);
    try {
      const result = await receiveInventory(receiptKey, request);
      if (result.kind === "received") {
        keyHolder.current.release();
        void queryClient.invalidateQueries({
          queryKey: inventoryKeys.principal(userId, organizationId),
        });
        // Home's out-of-stock count is computed from the same ledger.
        void queryClient.invalidateQueries({ queryKey: HOME_QUERY_PREFIX });
        setStep({
          kind: "done",
          product,
          receipt: result.receipt,
          replayed: result.replayed,
          quantityOnHand: result.quantityOnHand,
        });
        return;
      }
      if (result.kind === "receipt_conflict") keyHolder.current.release();
      setFormError(t(receiveResultMessageKey(result) ?? "receiving.error.generic"));
    } catch (err) {
      // Key kept: retrying the same request after a network failure must
      // reach the server under the same key.
      setFormError(t(receivingErrorKey(classifyReceivingError(err))));
    } finally {
      setSaving(false);
    }
  }

  function receiveNext() {
    setStep({ kind: "scan" });
    setQuantityText("");
    setLocationId(null);
    setFormError(null);
    setScanMessage(null);
  }

  return (
    <ScreenBleed surface="raised" bottom="none">
      <AppHeader
        title={t("receiving.title")}
        subtitle={t("receiving.subtitle")}
        onBack={() => void navigate({ to: "/app/inventory" })}
      />

      <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 pb-6 lg:max-w-[var(--screen-max-wide)]">
        {!canReceive ? (
          <CapabilityDeniedState capabilities={capabilities} />
        ) : (
          <div className="content-in flex flex-col gap-4">
            <Section title={t("receiving.supplier.title")}>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="receive-supplier" className="text-label text-text-secondary">
                  {t("receiving.supplier.label")}
                </Label>
                <Input
                  id="receive-supplier"
                  className="h-12"
                  value={supplierText}
                  maxLength={MAX_SUPPLIER_NAME_LENGTH + 20}
                  disabled={saving}
                  aria-invalid={supplierValid ? undefined : true}
                  aria-describedby="receive-supplier-hint"
                  placeholder={t("receiving.supplier.placeholder")}
                  onChange={(event) => setSupplierText(event.target.value)}
                />
                <span id="receive-supplier-hint" className="text-caption text-text-secondary">
                  {supplierValid
                    ? t("receiving.supplier.hint")
                    : t("receiving.supplier.tooLong", { count: MAX_SUPPLIER_NAME_LENGTH })}
                </span>
              </div>
            </Section>

            {step.kind === "scan" ? (
              <Section title={t("receiving.scan.title")}>
                <form className="flex flex-col gap-2" onSubmit={submitCode}>
                  <Label htmlFor="receive-code" className="text-label text-text-secondary">
                    {t("receiving.scan.label")}
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="receive-code"
                      className="tnum h-12 min-w-0 flex-1"
                      value={codeText}
                      autoComplete="off"
                      autoFocus
                      disabled={resolving}
                      aria-describedby="receive-code-hint"
                      placeholder={t("receiving.scan.placeholder")}
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
                  <span id="receive-code-hint" className="text-caption text-text-secondary">
                    {t("receiving.scan.hint")}
                  </span>
                  <Button
                    type="submit"
                    variant="outline"
                    className="tap-target h-12 gap-2"
                    disabled={resolving || codeText.trim() === ""}
                    aria-busy={resolving}
                  >
                    <ScanLine className="size-4" aria-hidden />
                    {resolving ? t("receiving.scan.finding") : t("receiving.scan.find")}
                  </Button>
                  <div role="status" aria-live="polite">
                    {scanMessage ? (
                      <p className="text-caption text-status-warning-text">{scanMessage}</p>
                    ) : null}
                  </div>
                </form>
              </Section>
            ) : null}

            {step.kind === "confirm" ? (
              <>
                <ProductSummary product={step.product} />
                <Section title={t("receiving.confirm.title")}>
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="receive-quantity" className="text-label text-text-secondary">
                        {t("receiving.confirm.quantity")}
                      </Label>
                      <Input
                        id="receive-quantity"
                        inputMode="numeric"
                        className="tnum h-12"
                        value={quantityText}
                        autoFocus
                        disabled={saving}
                        aria-invalid={quantityText !== "" && quantity === null ? true : undefined}
                        aria-describedby="receive-quantity-hint"
                        onChange={(event) => setQuantityText(event.target.value)}
                      />
                      <span id="receive-quantity-hint" className="text-caption text-text-secondary">
                        {t("receiving.confirm.quantityHint")}
                      </span>
                    </div>
                    {activeLocations.length > 0 ? (
                      <LocationChoice
                        locations={activeLocations}
                        value={locationId}
                        onChange={setLocationId}
                        disabled={saving}
                        label={t("receiveStock.location")}
                        noneLabel={t("receiveStock.noLocation")}
                        className="mx-0 px-0"
                      />
                    ) : null}
                    {formError ? (
                      <p className="text-caption text-status-danger-text" role="alert">
                        {formError}
                      </p>
                    ) : null}
                    <Button
                      className="tap-target h-12 w-full gap-2"
                      disabled={saving || quantity === null || !supplierValid}
                      aria-busy={saving}
                      onClick={() => void confirmReceipt(step.product)}
                    >
                      <PackagePlus className="size-4" aria-hidden />
                      {saving
                        ? t("inventory.saving")
                        : quantity === null
                          ? t("receiving.confirm.submitEmpty")
                          : t("receiving.confirm.submit", { count: quantity })}
                    </Button>
                    <Button
                      variant="outline"
                      className="tap-target h-12 w-full"
                      disabled={saving}
                      onClick={receiveNext}
                    >
                      {t("receiving.confirm.scanAnother")}
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
                      ? t("receiving.done.replayedTitle")
                      : t("receiving.done.title", { count: step.receipt.quantity })}
                  </p>
                  <p className="text-body-sm text-text-secondary" lang="km">
                    {step.product.productNameKm}
                    {step.product.variantName ? ` · ${step.product.variantName}` : ""}
                  </p>
                  {step.quantityOnHand !== null ? (
                    <p className="text-body-sm text-text-secondary">
                      {t("receiving.done.onHand")}{" "}
                      <span className="text-financial tnum text-text-primary">
                        {formatQuantity(step.quantityOnHand)}
                      </span>
                    </p>
                  ) : null}
                  {step.receipt.supplierName ? (
                    <p className="text-caption text-text-muted">
                      {t("receiving.done.supplier", { supplier: step.receipt.supplierName })}
                    </p>
                  ) : null}
                  {step.replayed ? (
                    <p className="text-caption text-text-secondary">
                      {t("receiving.done.replayedBody")}
                    </p>
                  ) : null}
                  <div className="flex w-full flex-col gap-2 pt-2">
                    <Button className="tap-target h-12 w-full gap-2" onClick={receiveNext}>
                      <ScanLine className="size-4" aria-hidden />
                      {t("receiving.done.next")}
                    </Button>
                    {canReadStock ? (
                      <Link
                        to="/app/inventory/$variantId"
                        params={{ variantId: step.product.variantId }}
                        className="press text-label tap-target flex h-12 items-center justify-center rounded-xl border border-border-default text-text-primary"
                      >
                        {t("receiving.done.viewStock")}
                      </Link>
                    ) : null}
                  </div>
                </div>
              </Section>
            ) : null}
          </div>
        )}
      </main>

      {canReceive ? (
        <CameraScanSheet
          open={cameraOpen}
          onOpenChange={setCameraOpen}
          onCode={(code) => void resolveCode(code)}
        />
      ) : null}
    </ScreenBleed>
  );
}

function ProductSummary({ product }: { product: ReceivingProduct }) {
  const { t } = useTranslation();
  return (
    <Section title={t("receiving.product.title")}>
      <div className="flex flex-col gap-1">
        <p className="text-label text-text-primary" lang="km">
          {product.productNameKm}
        </p>
        {product.productNameEn ? (
          <p className="text-body-sm text-text-secondary">{product.productNameEn}</p>
        ) : null}
        <p className="text-body-sm text-text-secondary">
          {product.variantName || t("inventoryList.unnamedVariant")}
        </p>
        <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
          {product.sku ? (
            <span className="text-caption text-text-muted">
              {t("inventoryList.sku")}: <span className="tnum">{product.sku}</span>
            </span>
          ) : null}
          {product.barcode ? (
            <span className="text-caption text-text-muted">
              {t("receiving.product.barcode")}: <span className="tnum">{product.barcode}</span>
            </span>
          ) : null}
        </div>
        {product.quantityOnHand !== null ? (
          <p className="text-body-sm pt-1 text-text-secondary">
            {t("receiving.product.onHand")}{" "}
            <span className="text-financial tnum text-text-primary">
              {formatQuantity(product.quantityOnHand)}
            </span>
          </p>
        ) : null}
      </div>
    </Section>
  );
}
