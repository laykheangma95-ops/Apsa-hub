import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Package, ScanBarcode, XCircle } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppHeader, BottomNav, DetailSkeleton, ScreenBleed, Spinner } from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import { useCapabilities } from "@/hooks/use-capabilities";
import { useBarcodeScanner, SCAN_INPUT_ATTRIBUTE } from "@/hooks/use-barcode-scanner";
import { pickingKeys } from "@/lib/picking-query";
import {
  createPickSession,
  computeProgress,
  validateScan,
  applyAcceptedScan,
  type PickSession,
  type PickRequirement,
  type ScanResult,
} from "@/lib/pick";

export const Route = createFileRoute("/app/pick/$orderId")({
  head: () => ({
    meta: [
      { title: "Scan to Pick — APSA" },
      {
        name: "description",
        content: "Scan products to pick an order for fulfillment.",
      },
    ],
  }),
  component: PickScreen,
});

type FeedbackEntry = {
  id: number;
  result: ScanResult;
  timestamp: number;
};

function ScanFeedback({ entry }: { entry: FeedbackEntry }) {
  const { t } = useTranslation();
  const r = entry.result;

  if (r.kind === "accepted") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-status-success bg-status-success-soft px-4 py-3">
        <CheckCircle2 className="size-6 shrink-0 text-status-success-text" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-label text-status-success-text">{t("pick.scan.accepted")}</p>
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
          <p className="text-label text-status-danger-text">{t("pick.scan.wrongProduct")}</p>
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
          <p className="text-label text-status-danger-text">{t("pick.scan.wrongVariant")}</p>
        </div>
      </div>
    );
  }

  if (r.kind === "over_quantity") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-status-warning bg-status-warning-soft px-4 py-3">
        <XCircle className="size-6 shrink-0 text-status-warning-text" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-label text-status-warning-text">{t("pick.scan.overQuantity")}</p>
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
          <p className="text-label text-status-success-text">{t("pick.scan.alreadyComplete")}</p>
        </div>
      </div>
    );
  }

  return null;
}

function ProgressBar({ picked, total }: { picked: number; total: number }) {
  const percent = total > 0 ? Math.round((picked / total) * 100) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-heading-sm tnum text-text-primary">
          {picked} / {total}
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

function PickScreen() {
  const { t } = useTranslation();
  const { orderId } = Route.useParams();
  const navigate = useNavigate();
  const capabilities = useCapabilities();
  const { session, organizationId } = Route.useRouteContext();

  const canRead = capabilities.can("orders.read");

  const query = useQuery({
    queryKey: pickingKeys.requirements(session.userId, organizationId, orderId),
    queryFn: async () => {
      const { getPickRequirementsFn } = await import("@/api/picking");
      return getPickRequirementsFn({ data: { orderId } });
    },
    enabled: canRead,
  });

  const requirements: readonly PickRequirement[] = useMemo(
    () => (query.data ?? []) as PickRequirement[],
    [query.data],
  );

  const [pickSession, setPickSession] = useState<PickSession | null>(null);
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);
  const feedbackIdRef = useRef(0);
  const scanInputRef = useRef<HTMLInputElement>(null);

  // Initialize pick session when requirements load
  const sessionReady = pickSession !== null;
  if (!sessionReady && requirements.length > 0) {
    setPickSession(createPickSession(orderId, "", requirements));
  }

  const progress = useMemo(
    () => (pickSession ? computeProgress(pickSession) : null),
    [pickSession],
  );

  const handleScan = useCallback(
    (barcode: string) => {
      if (!pickSession) return;

      const result = validateScan(pickSession, barcode);
      const id = ++feedbackIdRef.current;
      setFeedback((prev) => [{ id, result, timestamp: Date.now() }, ...prev].slice(0, 10));

      if (result.kind === "accepted") {
        setPickSession((prev) => (prev ? applyAcceptedScan(prev, result) : prev));
      }
    },
    [pickSession],
  );

  useBarcodeScanner({
    enabled: canRead && pickSession !== null && !(progress?.isComplete ?? false),
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
        title={t("pick.title")}
        onBack={() => void navigate({ to: "/app/orders/$id", params: { id: orderId } })}
      />

      <main className="mx-auto flex w-full max-w-[var(--screen-max)] flex-col gap-4 px-4 pt-3 pb-6 lg:max-w-[var(--screen-max-wide)]">
        {!canRead ? <CapabilityDeniedState capabilities={capabilities} /> : null}

        {canRead && query.isLoading ? <DetailSkeleton /> : null}

        {canRead && query.isError ? (
          <OperationalState
            tone="danger"
            title={t("pick.error.title")}
            body={t("pick.error.body")}
            onRetry={() => void query.refetch()}
          />
        ) : null}

        {canRead && query.isSuccess && requirements.length === 0 ? (
          <OperationalState title={t("pick.empty.title")} body={t("pick.empty.body")} />
        ) : null}

        {canRead && progress ? (
          <>
            {/* Progress */}
            <section className="rounded-2xl border border-border-default bg-surface-primary p-4">
              <h2 className="text-label mb-3 text-text-primary">{t("pick.progress")}</h2>
              <ProgressBar picked={progress.totalPicked} total={progress.totalRequired} />

              {progress.isComplete ? (
                <div className="mt-3 flex items-center gap-2 rounded-xl bg-status-success-soft px-3 py-2">
                  <CheckCircle2 className="size-5 text-status-success-text" aria-hidden />
                  <span className="text-label text-status-success-text">{t("pick.allPicked")}</span>
                </div>
              ) : null}
            </section>

            {/* Scanner input */}
            {!progress.isComplete ? (
              <section className="rounded-2xl border border-border-default bg-surface-primary p-4">
                <div className="flex items-center gap-2 mb-3">
                  <ScanBarcode className="size-5 text-text-muted" aria-hidden />
                  <h2 className="text-label text-text-primary">{t("pick.scanPrompt")}</h2>
                </div>
                <form onSubmit={handleManualEntry} className="flex gap-2">
                  <input
                    ref={scanInputRef}
                    type="text"
                    className="h-12 min-w-0 flex-1 rounded-xl border border-border-default bg-surface-primary px-4 text-body text-text-primary placeholder:text-text-muted focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
                    placeholder={t("pick.scanPlaceholder")}
                    autoComplete="off"
                    autoFocus
                    {...{ [SCAN_INPUT_ATTRIBUTE]: "" }}
                  />
                  <button
                    type="submit"
                    className="tap-target h-12 shrink-0 rounded-xl bg-brand-primary px-4 text-label text-white active:opacity-90"
                  >
                    {t("pick.submit")}
                  </button>
                </form>
              </section>
            ) : null}

            {/* Scan feedback */}
            {feedback.length > 0 ? (
              <section className="flex flex-col gap-2">
                {feedback.map((entry) => (
                  <ScanFeedback key={entry.id} entry={entry} />
                ))}
              </section>
            ) : null}

            {/* Pick list */}
            <section className="overflow-hidden rounded-2xl border border-border-default">
              <div className="border-b border-border-default bg-surface-secondary px-4 py-2.5">
                <h2 className="text-label text-text-primary">{t("pick.itemList")}</h2>
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
                      {line.quantityPicked} / {line.quantityRequired}
                    </span>
                  </div>
                </div>
              ))}
            </section>
          </>
        ) : null}
      </main>

      <BottomNav />
    </ScreenBleed>
  );
}
