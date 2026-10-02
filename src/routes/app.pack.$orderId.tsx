import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Package, PackageCheck, ScanBarcode, XCircle } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppHeader, BottomNav, DetailSkeleton, ScreenBleed, Spinner } from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import { useCapabilities } from "@/hooks/use-capabilities";
import { useBarcodeScanner, SCAN_INPUT_ATTRIBUTE } from "@/hooks/use-barcode-scanner";
import { packingKeys } from "@/lib/packing-query";
import {
  createPackSession,
  computePackProgress,
  getPackPhase,
  validateParcelScan,
  applyParcelScan,
  validateProductScan,
  applyAcceptedPackScan,
  type PackSession,
  type PackRequirement,
  type ParcelScanResult,
  type ProductScanResult,
} from "@/lib/pack";
import { looksLikeParcelCode } from "@/lib/barcode/parcel-code";

export const Route = createFileRoute("/app/pack/$orderId")({
  head: () => ({
    meta: [
      { title: "Scan to Pack — APSA" },
      {
        name: "description",
        content: "Scan parcel and products to pack an order for shipment.",
      },
    ],
  }),
  component: PackScreen,
});

type FeedbackEntry = {
  id: number;
  result: ParcelScanResult | ProductScanResult;
  timestamp: number;
};

function ParcelFeedback({ entry }: { entry: FeedbackEntry }) {
  const { t } = useTranslation();
  const r = entry.result as ParcelScanResult;

  if (r.kind === "parcel_accepted") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-status-success bg-status-success-soft px-4 py-3">
        <CheckCircle2 className="size-6 shrink-0 text-status-success-text" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-label text-status-success-text">{t("packSession.parcel.accepted")}</p>
        </div>
      </div>
    );
  }

  if (r.kind === "wrong_parcel") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-status-danger bg-status-danger-soft px-4 py-3">
        <XCircle className="size-6 shrink-0 text-status-danger-text" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-label text-status-danger-text">{t("packSession.parcel.wrong")}</p>
        </div>
      </div>
    );
  }

  if (r.kind === "parcel_already_verified") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-status-success bg-status-success-soft px-4 py-3">
        <CheckCircle2 className="size-6 shrink-0 text-status-success-text" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-label text-status-success-text">
            {t("packSession.parcel.alreadyVerified")}
          </p>
        </div>
      </div>
    );
  }

  return null;
}

function ProductFeedback({ entry }: { entry: FeedbackEntry }) {
  const { t } = useTranslation();
  const r = entry.result as ProductScanResult;

  if (r.kind === "accepted") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-status-success bg-status-success-soft px-4 py-3">
        <CheckCircle2 className="size-6 shrink-0 text-status-success-text" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-label text-status-success-text">{t("packSession.product.accepted")}</p>
          <p className="text-body-sm text-text-secondary">{r.productName}</p>
        </div>
      </div>
    );
  }

  if (r.kind === "wrong_product") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-status-danger bg-status-danger-soft px-4 py-3">
        <XCircle className="size-6 shrink-0 text-status-danger-text" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-label text-status-danger-text">
            {t("packSession.product.wrongProduct")}
          </p>
          <p className="text-body-sm text-text-secondary">{r.scannedBarcode}</p>
        </div>
      </div>
    );
  }

  if (r.kind === "wrong_variant") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-status-danger bg-status-danger-soft px-4 py-3">
        <XCircle className="size-6 shrink-0 text-status-danger-text" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-label text-status-danger-text">
            {t("packSession.product.wrongVariant")}
          </p>
        </div>
      </div>
    );
  }

  if (r.kind === "duplicate_scan") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-status-warning bg-status-warning-soft px-4 py-3">
        <XCircle className="size-6 shrink-0 text-status-warning-text" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-label text-status-warning-text">
            {t("packSession.product.duplicate")}
          </p>
          <p className="text-body-sm text-text-secondary">{r.productName}</p>
        </div>
      </div>
    );
  }

  if (r.kind === "already_complete") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-status-success bg-status-success-soft px-4 py-3">
        <CheckCircle2 className="size-6 shrink-0 text-status-success-text" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-label text-status-success-text">
            {t("packSession.product.alreadyComplete")}
          </p>
        </div>
      </div>
    );
  }

  return null;
}

function ScanFeedback({ entry }: { entry: FeedbackEntry }) {
  const r = entry.result;
  if ("parcelCode" in r || "scannedCode" in r || r.kind === "parcel_already_verified") {
    return <ParcelFeedback entry={entry} />;
  }
  return <ProductFeedback entry={entry} />;
}

function ProgressBar({ packed, total }: { packed: number; total: number }) {
  const percent = total > 0 ? Math.round((packed / total) * 100) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-heading-sm tnum text-text-primary">
          {packed} / {total}
        </span>
        <span className="text-caption tnum text-text-muted">{percent}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-tertiary">
        <div
          className="h-full rounded-full bg-brand-primary transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function PackScreen() {
  const { t } = useTranslation();
  const { orderId } = Route.useParams();
  const navigate = useNavigate();
  const capabilities = useCapabilities();
  const { session, organizationId } = Route.useRouteContext();

  const canRead = capabilities.can("orders.read");

  const query = useQuery({
    queryKey: packingKeys.requirements(session.userId, organizationId, orderId),
    queryFn: async () => {
      const { getPackRequirementsFn } = await import("@/api/packing");
      return getPackRequirementsFn({ data: { orderId } });
    },
    enabled: canRead,
  });

  const packData = query.data;
  const requirements: readonly PackRequirement[] = useMemo(
    () => (packData?.requirements ?? []) as PackRequirement[],
    [packData],
  );
  const orderNumber = packData?.orderNumber ?? "";
  const parcelCode = packData?.parcelCode ?? "";

  const [packSession, setPackSession] = useState<PackSession | null>(null);
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);
  const feedbackIdRef = useRef(0);
  const scanInputRef = useRef<HTMLInputElement>(null);

  const sessionReady = packSession !== null;
  if (!sessionReady && requirements.length > 0 && parcelCode) {
    setPackSession(createPackSession(orderId, orderNumber, parcelCode, requirements));
  }

  const progress = useMemo(
    () => (packSession ? computePackProgress(packSession) : null),
    [packSession],
  );

  const phase = packSession ? getPackPhase(packSession) : null;

  const handleScan = useCallback(
    (scannedValue: string) => {
      if (!packSession) return;

      const id = ++feedbackIdRef.current;

      if (!packSession.parcelVerified) {
        const result = validateParcelScan(packSession, scannedValue);
        setFeedback((prev) => [{ id, result, timestamp: Date.now() }, ...prev].slice(0, 10));
        if (result.kind === "parcel_accepted") {
          setPackSession((prev) => (prev ? applyParcelScan(prev, result) : prev));
        }
        return;
      }

      if (looksLikeParcelCode(scannedValue)) {
        const result = validateParcelScan(packSession, scannedValue);
        setFeedback((prev) => [{ id, result, timestamp: Date.now() }, ...prev].slice(0, 10));
        return;
      }

      const result = validateProductScan(packSession, scannedValue);
      setFeedback((prev) => [{ id, result, timestamp: Date.now() }, ...prev].slice(0, 10));
      if (result.kind === "accepted") {
        setPackSession((prev) => (prev ? applyAcceptedPackScan(prev, result) : prev));
      }
    },
    [packSession],
  );

  useBarcodeScanner({
    enabled: canRead && packSession !== null && phase !== "complete",
    onScan: handleScan,
  });

  const handleManualEntry = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const input = scanInputRef.current;
      if (!input) return;
      const value = input.value.trim();
      if (value.length > 0) {
        handleScan(value);
        input.value = "";
      }
    },
    [handleScan],
  );

  return (
    <ScreenBleed bottom="nav" surface="raised">
      <AppHeader
        title={t("packSession.title")}
        onBack={() => void navigate({ to: "/app/orders/$id", params: { id: orderId } })}
      />

      <main className="mx-auto flex w-full max-w-[var(--screen-max)] flex-col gap-4 px-4 pt-3 pb-6 lg:max-w-[var(--screen-max-wide)]">
        {!canRead ? <CapabilityDeniedState capabilities={capabilities} /> : null}

        {canRead && query.isLoading ? <DetailSkeleton /> : null}

        {canRead && query.isError ? (
          <OperationalState
            tone="danger"
            title={t("packSession.error.title")}
            body={t("packSession.error.body")}
            onRetry={() => void query.refetch()}
          />
        ) : null}

        {canRead && query.isSuccess && requirements.length === 0 ? (
          <OperationalState
            title={t("packSession.empty.title")}
            body={t("packSession.empty.body")}
          />
        ) : null}

        {canRead && packSession ? (
          <>
            {/* Order info */}
            <section className="rounded-2xl border border-border-default bg-surface-primary p-4">
              <div className="flex items-center gap-2 mb-1">
                <PackageCheck className="size-5 text-text-muted" aria-hidden />
                <h2 className="text-label text-text-primary">{t("packSession.orderInfo")}</h2>
              </div>
              <p className="text-body-sm text-text-secondary">{orderNumber}</p>
            </section>

            {/* Parcel verification */}
            {phase === "awaiting_parcel" ? (
              <section className="rounded-2xl border border-border-default bg-surface-primary p-4">
                <div className="flex items-center gap-2 mb-3">
                  <ScanBarcode className="size-5 text-text-muted" aria-hidden />
                  <h2 className="text-label text-text-primary">
                    {t("packSession.parcel.scanPrompt")}
                  </h2>
                </div>
                <p className="text-body-sm text-text-secondary mb-3">
                  {t("packSession.parcel.scanHint")}
                </p>
                <form onSubmit={handleManualEntry} className="flex gap-2">
                  <input
                    ref={scanInputRef}
                    type="text"
                    className="h-12 min-w-0 flex-1 rounded-xl border border-border-default bg-surface-primary px-4 text-body text-text-primary placeholder:text-text-muted focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
                    placeholder={t("packSession.parcel.placeholder")}
                    autoComplete="off"
                    autoFocus
                    {...{ [SCAN_INPUT_ATTRIBUTE]: "" }}
                  />
                  <button
                    type="submit"
                    className="tap-target h-12 shrink-0 rounded-xl bg-brand-primary px-4 text-label text-white active:opacity-90"
                  >
                    {t("packSession.submit")}
                  </button>
                </form>
              </section>
            ) : null}

            {/* Product scanning */}
            {phase === "scanning_products" ? (
              <>
                {/* Parcel verified badge */}
                <div className="flex items-center gap-2 rounded-xl bg-status-success-soft px-3 py-2">
                  <CheckCircle2 className="size-5 text-status-success-text" aria-hidden />
                  <span className="text-label text-status-success-text">
                    {t("packSession.parcel.verified")}
                  </span>
                </div>

                {/* Progress */}
                <section className="rounded-2xl border border-border-default bg-surface-primary p-4">
                  <h2 className="text-label mb-3 text-text-primary">{t("packSession.progress")}</h2>
                  {progress ? (
                    <ProgressBar packed={progress.totalPacked} total={progress.totalRequired} />
                  ) : null}
                </section>

                {/* Scanner input */}
                <section className="rounded-2xl border border-border-default bg-surface-primary p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <ScanBarcode className="size-5 text-text-muted" aria-hidden />
                    <h2 className="text-label text-text-primary">
                      {t("packSession.product.scanPrompt")}
                    </h2>
                  </div>
                  <form onSubmit={handleManualEntry} className="flex gap-2">
                    <input
                      ref={scanInputRef}
                      type="text"
                      className="h-12 min-w-0 flex-1 rounded-xl border border-border-default bg-surface-primary px-4 text-body text-text-primary placeholder:text-text-muted focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
                      placeholder={t("packSession.product.placeholder")}
                      autoComplete="off"
                      autoFocus
                      {...{ [SCAN_INPUT_ATTRIBUTE]: "" }}
                    />
                    <button
                      type="submit"
                      className="tap-target h-12 shrink-0 rounded-xl bg-brand-primary px-4 text-label text-white active:opacity-90"
                    >
                      {t("packSession.submit")}
                    </button>
                  </form>
                </section>
              </>
            ) : null}

            {/* Complete state */}
            {phase === "complete" ? (
              <>
                <div className="flex items-center gap-2 rounded-xl bg-status-success-soft px-3 py-2">
                  <CheckCircle2 className="size-5 text-status-success-text" aria-hidden />
                  <span className="text-label text-status-success-text">
                    {t("packSession.parcel.verified")}
                  </span>
                </div>

                <section className="rounded-2xl border border-border-default bg-surface-primary p-4">
                  <h2 className="text-label mb-3 text-text-primary">{t("packSession.progress")}</h2>
                  {progress ? (
                    <ProgressBar packed={progress.totalPacked} total={progress.totalRequired} />
                  ) : null}
                  <div className="mt-3 flex items-center gap-2 rounded-xl bg-status-success-soft px-3 py-2">
                    <PackageCheck className="size-5 text-status-success-text" aria-hidden />
                    <span className="text-label text-status-success-text">
                      {t("packSession.readyToSeal")}
                    </span>
                  </div>
                </section>
              </>
            ) : null}

            {/* Scan feedback */}
            {feedback.length > 0 ? (
              <section className="flex flex-col gap-2">
                {feedback.map((entry) => (
                  <ScanFeedback key={entry.id} entry={entry} />
                ))}
              </section>
            ) : null}

            {/* Pack list */}
            {(phase === "scanning_products" || phase === "complete") && progress ? (
              <section className="overflow-hidden rounded-2xl border border-border-default">
                <div className="border-b border-border-default bg-surface-secondary px-4 py-2.5">
                  <h2 className="text-label text-text-primary">{t("packSession.itemList")}</h2>
                </div>
                {progress.lines.map((line) => (
                  <div
                    key={line.orderItemId}
                    className="flex items-center gap-3 border-b border-border-default bg-surface-primary px-4 py-3 last:border-b-0"
                  >
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg">
                      {line.isComplete ? (
                        <CheckCircle2 className="size-6 text-status-success-text" aria-hidden />
                      ) : (
                        <Package className="size-6 text-text-muted" aria-hidden />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-label truncate ${line.isComplete ? "text-text-muted line-through" : "text-text-primary"}`}
                      >
                        {line.productName}
                      </p>
                      {line.variantName ? (
                        <p className="text-body-sm text-text-secondary">{line.variantName}</p>
                      ) : null}
                      {line.sku ? <p className="text-caption text-text-muted">{line.sku}</p> : null}
                    </div>
                    <div className="shrink-0 text-right">
                      <span
                        className={`text-label tnum ${line.isComplete ? "text-status-success-text" : "text-text-primary"}`}
                      >
                        {line.quantityPacked} / {line.quantityRequired}
                      </span>
                    </div>
                  </div>
                ))}
              </section>
            ) : null}
          </>
        ) : null}
      </main>

      <BottomNav />
    </ScreenBleed>
  );
}
