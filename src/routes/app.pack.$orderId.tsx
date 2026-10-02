import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Camera,
  CheckCircle2,
  Hand,
  Package,
  PackageCheck,
  ScanBarcode,
  Search,
  Tag,
  XCircle,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AppHeader,
  BottomNav,
  DetailSkeleton,
  ScreenBleed,
  Spinner,
  StickyActionBar,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { OperationalState } from "@/components/common/OperationalState";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import { CameraScanSheet } from "@/components/barcode/CameraScanSheet";
import { useCapabilities } from "@/hooks/use-capabilities";
import { useBarcodeScanner, SCAN_INPUT_ATTRIBUTE } from "@/hooks/use-barcode-scanner";
import { packingKeys } from "@/lib/packing-query";
import { ordersKeys } from "@/lib/orders-query";
import { fulfillmentKeys } from "@/lib/fulfillment-query";
import { deliveryTransitionInvalidationKeys } from "@/lib/deliveries-query";
import { notifyError, notifySuccess } from "@/lib/feedback";
import { normalizeScanInput } from "@/lib/barcode/normalize";
import { classifyScan } from "@/lib/barcode/scan-router";
import {
  createPackSession,
  computePackProgress,
  applyServerParcelAccepted,
  applyServerProductAccepted,
  buildPackedLines,
  canMarkPacked,
  confirmLineManually,
  filterPackLines,
  resolveAcceptedLine,
  type MarkPackedResult,
  type PackSession,
  type PackRequirement,
  type ServerParcelScanResult,
  type ServerProductScanResult,
} from "@/lib/pack";

export const Route = createFileRoute("/app/pack/$orderId")({
  head: () => ({
    meta: [
      { title: "Pack Order — APSA" },
      {
        name: "description",
        content: "Scan or confirm each item into the labelled parcel, then mark the order packed.",
      },
    ],
  }),
  component: PackScreen,
});

type FeedbackResult =
  | ServerParcelScanResult
  | ServerProductScanResult
  | { kind: "manual_accepted"; productName: string }
  | { kind: "parcel_already_verified" }
  | { kind: "duplicate_scan"; productName: string }
  | { kind: "already_complete" };

type FeedbackEntry = {
  id: number;
  result: FeedbackResult;
};

type Tone = "success" | "danger" | "warning";

const TONE_CLASS: Record<Tone, { box: string; text: string }> = {
  success: {
    box: "border-status-success bg-status-success-soft",
    text: "text-status-success-text",
  },
  danger: { box: "border-status-danger bg-status-danger-soft", text: "text-status-danger-text" },
  warning: {
    box: "border-status-warning bg-status-warning-soft",
    text: "text-status-warning-text",
  },
};

function feedbackCopy(
  r: FeedbackResult,
): { tone: Tone; key: string; detail?: string | undefined } | null {
  switch (r.kind) {
    case "accepted":
      return { tone: "success", key: "packSession.product.accepted", detail: r.productName };
    case "manual_accepted":
      return { tone: "success", key: "packSession.product.manualAccepted", detail: r.productName };
    case "wrong_product":
      return { tone: "danger", key: "packSession.product.wrongProduct", detail: r.scannedBarcode };
    case "wrong_variant":
      return {
        tone: "danger",
        key: "packSession.product.wrongVariant",
        detail: r.expectedVariantName ?? undefined,
      };
    case "duplicate_scan":
      return { tone: "warning", key: "packSession.product.duplicate", detail: r.productName };
    case "already_complete":
      return { tone: "success", key: "packSession.product.alreadyComplete" };
    case "parcel_accepted":
      return { tone: "success", key: "packSession.parcel.accepted" };
    case "parcel_already_verified":
      return { tone: "success", key: "packSession.parcel.alreadyVerified" };
    case "wrong_parcel":
      return { tone: "danger", key: "packSession.parcel.wrong" };
    case "invalid_order":
      return { tone: "danger", key: "packSession.error.title" };
  }
}

function ScanFeedback({ entry }: { entry: FeedbackEntry }) {
  const { t } = useTranslation();
  const copy = feedbackCopy(entry.result);
  if (!copy) return null;
  const tone = TONE_CLASS[copy.tone];
  // Status is carried by icon + text, never by colour alone.
  const Icon = copy.tone === "success" ? CheckCircle2 : XCircle;
  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${tone.box}`}>
      <Icon className={`size-6 shrink-0 ${tone.text}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className={`text-label ${tone.text}`}>{t(copy.key)}</p>
        {copy.detail ? (
          <p className="text-body-sm break-words text-text-secondary">{copy.detail}</p>
        ) : null}
      </div>
    </div>
  );
}

function ProgressBar({ packed, total }: { packed: number; total: number }) {
  const { t } = useTranslation();
  const percent = total > 0 ? Math.round((packed / total) * 100) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-heading-sm tnum text-text-primary">
          {t("packSession.packedCount", { packed, total })}
        </span>
        <span className="text-caption tnum text-text-muted">{percent}%</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-surface-tertiary"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={packed}
        aria-label={t("packSession.progress")}
      >
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
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();
  const { session, organizationId } = Route.useRouteContext();

  const canRead = capabilities.can("orders.read");
  // Mark Packed requires the same operational grant as courier handoff (V1;
  // a dedicated packing grant is an APSA V2 TODO). This only hides the control.
  const canMark = capabilities.can("delivery.handoff");

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
  // Packing never requires a delivery; the server says whether it is packed.
  const alreadyPacked = packData?.packed ?? false;

  const [packSession, setPackSession] = useState<PackSession | null>(null);
  // Scans are processed strictly in order, each against the latest session, so
  // a fast wedge burst is never dropped and a duplicate is never double-counted.
  const sessionRef = useRef<PackSession | null>(null);
  const scanQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [pendingScans, setPendingScans] = useState(0);
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [search, setSearch] = useState("");
  const feedbackIdRef = useRef(0);
  const scanInputRef = useRef<HTMLInputElement>(null);

  const commit = useCallback((next: PackSession) => {
    sessionRef.current = next;
    setPackSession(next);
  }, []);

  if (packSession === null && requirements.length > 0 && parcelCode) {
    const initial = createPackSession(orderId, orderNumber, parcelCode, requirements);
    sessionRef.current = initial;
    setPackSession(initial);
  }

  const progress = useMemo(
    () => (packSession ? computePackProgress(packSession) : null),
    [packSession],
  );
  const visibleLines = useMemo(
    () => (progress ? filterPackLines(progress.lines, search) : []),
    [progress, search],
  );

  const addFeedback = useCallback((result: FeedbackResult) => {
    const id = ++feedbackIdRef.current;
    setFeedback((prev) => [{ id, result }, ...prev].slice(0, 5));
  }, []);

  const processScan = useCallback(
    async (raw: string) => {
      const current = sessionRef.current;
      if (!current) return;
      const code = normalizeScanInput(raw);
      if (code === null) return;

      // The shared APSA scan router decides what was scanned; the server decides
      // whether it belongs to this order.
      if (classifyScan(code).kind === "apsa-parcel") {
        if (current.parcelVerified) {
          addFeedback({ kind: "parcel_already_verified" });
          return;
        }
        const { validatePackParcelScanFn } = await import("@/api/packing");
        const result = await validatePackParcelScanFn({ data: { orderId, scannedCode: code } });
        addFeedback(result);
        if (result.kind === "parcel_accepted" && sessionRef.current) {
          commit(applyServerParcelAccepted(sessionRef.current));
        }
        return;
      }

      if (computePackProgress(current).isComplete) {
        addFeedback({ kind: "already_complete" });
        return;
      }

      const { validatePackProductScanFn } = await import("@/api/packing");
      const result = await validatePackProductScanFn({ data: { orderId, barcode: code } });
      const latest = sessionRef.current;
      if (result.kind !== "accepted" || !latest) {
        addFeedback(result);
        return;
      }

      const lineId = resolveAcceptedLine(latest, result.variantId);
      if (lineId === null) {
        addFeedback({ kind: "duplicate_scan", productName: result.productName });
        return;
      }
      commit(
        applyServerProductAccepted(latest, { orderItemId: lineId, variantId: result.variantId }),
      );
      addFeedback(result);
    },
    [orderId, addFeedback, commit],
  );

  const handleScan = useCallback(
    (raw: string) => {
      setPendingScans((n) => n + 1);
      scanQueueRef.current = scanQueueRef.current
        .then(() => processScan(raw))
        .catch(() => addFeedback({ kind: "invalid_order" }))
        .finally(() => setPendingScans((n) => n - 1));
    },
    [processScan, addFeedback],
  );

  const handleManualConfirm = useCallback(
    (orderItemId: string) => {
      const current = sessionRef.current;
      if (!current) return;
      const { session: next, result } = confirmLineManually(current, orderItemId);
      if (result.kind === "accepted") {
        commit(next);
        addFeedback({ kind: "manual_accepted", productName: result.productName });
      } else if (result.kind === "duplicate_scan") {
        addFeedback({ kind: "duplicate_scan", productName: result.productName });
      }
    },
    [addFeedback, commit],
  );

  const scanActive = canRead && packSession !== null && !alreadyPacked && !cameraOpen;
  useBarcodeScanner({ enabled: scanActive, onScan: handleScan });

  const handleTypedEntry = useCallback(
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

  const markPacked = useMutation({
    mutationFn: async (): Promise<MarkPackedResult> => {
      const current = sessionRef.current;
      if (!current) return { kind: "incomplete" };
      const { markOrderPackedFn } = await import("@/api/packing");
      return markOrderPackedFn({ data: { orderId, packedLines: buildPackedLines(current) } });
    },
    onSuccess: async (result) => {
      if (result.kind === "packed" || result.kind === "already_packed") {
        const keys = [
          ...deliveryTransitionInvalidationKeys(session.userId, organizationId, orderId),
          ordersKeys.principal(session.userId, organizationId),
          fulfillmentKeys.readyToPack(session.userId, organizationId),
          packingKeys.principal(session.userId, organizationId),
        ];
        await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
        notifySuccess(
          t(
            result.kind === "packed"
              ? "packSession.markPacked.success"
              : "packSession.markPacked.alreadyPacked",
          ),
          t("packSession.markPacked.packedBody"),
        );
        void navigate({ to: "/app/orders/$id", params: { id: orderId } });
        return;
      }
      notifyError(t(markPackedErrorKey(result)));
    },
    onError: () => notifyError(t("packSession.markPacked.failed")),
  });

  const ready = packSession !== null && canMarkPacked(packSession);
  const remaining = progress?.remaining ?? 0;

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

        {canRead && packSession && progress ? (
          <>
            {/* Order + labelled parcel */}
            <section className="rounded-2xl border border-border-default bg-surface-primary p-4">
              <div className="mb-1 flex items-center gap-2">
                <PackageCheck className="size-5 text-text-muted" aria-hidden />
                <h2 className="text-label text-text-primary">{t("packSession.orderInfo")}</h2>
              </div>
              <p className="text-body-sm tnum text-text-secondary">{orderNumber}</p>
              <p className="text-body-sm mt-2 flex items-start gap-2 text-text-secondary">
                <Tag className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden />
                <span>{t("packSession.labelHint")}</span>
              </p>
              {packSession.parcelVerified ? (
                <p className="text-label mt-2 flex items-center gap-2 text-status-success-text">
                  <CheckCircle2 className="size-4" aria-hidden />
                  {t("packSession.parcel.verified")}
                </p>
              ) : null}
            </section>

            {alreadyPacked ? (
              <OperationalState
                title={t("packSession.markPacked.alreadyPacked")}
                body={t("packSession.markPacked.packedBody")}
              />
            ) : null}

            {/* Progress */}
            <section className="rounded-2xl border border-border-default bg-surface-primary p-4">
              <h2 className="text-label mb-3 text-text-primary">{t("packSession.progress")}</h2>
              <ProgressBar packed={progress.totalPacked} total={progress.totalRequired} />
              {progress.isComplete ? (
                <div className="mt-3 flex items-center gap-2 rounded-xl bg-status-success-soft px-3 py-2">
                  <PackageCheck className="size-5 text-status-success-text" aria-hidden />
                  <span className="text-label text-status-success-text">
                    {t("packSession.readyToSeal")}
                  </span>
                </div>
              ) : null}
            </section>

            {/* Scan: camera (primary on phones), hardware scanner, or typed code */}
            {!progress.isComplete && !alreadyPacked ? (
              <section className="rounded-2xl border border-border-default bg-surface-primary p-4">
                <div className="mb-3 flex items-center gap-2">
                  <ScanBarcode className="size-5 text-text-muted" aria-hidden />
                  <h2 className="text-label text-text-primary">
                    {t("packSession.product.scanPrompt")}
                  </h2>
                </div>
                <Button
                  type="button"
                  className="tap-target mb-3 h-12 w-full gap-2 rounded-xl"
                  onClick={() => setCameraOpen(true)}
                >
                  <Camera className="size-5" aria-hidden />
                  {t("packSession.camera")}
                </Button>
                <form onSubmit={handleTypedEntry} className="flex gap-2">
                  <input
                    ref={scanInputRef}
                    type="text"
                    aria-label={t("packSession.product.placeholder")}
                    className="h-12 min-w-0 flex-1 rounded-xl border border-border-default bg-surface-primary px-4 text-body text-text-primary placeholder:text-text-muted focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
                    placeholder={t("packSession.product.placeholder")}
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    maxLength={100}
                    {...{ [SCAN_INPUT_ATTRIBUTE]: "" }}
                  />
                  <button
                    type="submit"
                    className="tap-target h-12 shrink-0 rounded-xl bg-brand-primary px-4 text-label text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40 active:opacity-90"
                  >
                    {pendingScans > 0 ? <Spinner className="size-5" /> : t("packSession.submit")}
                  </button>
                </form>
              </section>
            ) : null}

            {/* Scan feedback */}
            {feedback.length > 0 ? (
              <section className="flex flex-col gap-2" aria-live="polite">
                {feedback.map((entry) => (
                  <ScanFeedback key={entry.id} entry={entry} />
                ))}
              </section>
            ) : null}

            {/* Items — manual search and manual confirm */}
            <section className="overflow-hidden rounded-2xl border border-border-default">
              <div className="flex flex-col gap-2 border-b border-border-default bg-surface-secondary px-4 py-2.5">
                <h2 className="text-label text-text-primary">{t("packSession.itemList")}</h2>
                <label className="relative block">
                  <span className="sr-only">{t("packSession.manual.searchLabel")}</span>
                  <Search
                    className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted"
                    aria-hidden
                  />
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t("packSession.manual.searchPlaceholder")}
                    autoComplete="off"
                    className="h-11 w-full rounded-xl border border-border-default bg-surface-primary pr-3 pl-9 text-body text-text-primary placeholder:text-text-muted focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
                  />
                </label>
              </div>
              {visibleLines.length === 0 ? (
                <p className="text-body-sm bg-surface-primary px-4 py-3 text-text-secondary">
                  {t("packSession.manual.noResults")}
                </p>
              ) : null}
              {visibleLines.map((line) => (
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
                      className={`text-label break-words ${line.isComplete ? "text-text-muted line-through" : "text-text-primary"}`}
                    >
                      {line.productName}
                    </p>
                    {line.variantName ? (
                      <p className="text-body-sm text-text-secondary">{line.variantName}</p>
                    ) : null}
                    {line.sku ? <p className="text-caption text-text-muted">{line.sku}</p> : null}
                    {line.barcode === null ? (
                      <p className="text-caption text-text-muted">
                        {t("packSession.manual.noBarcode")}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <span
                      className={`text-label tnum ${line.isComplete ? "text-status-success-text" : "text-text-primary"}`}
                    >
                      {line.quantityPacked} / {line.quantityRequired}
                    </span>
                    {!line.isComplete && !alreadyPacked ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="tap-target h-11 gap-1.5 rounded-xl"
                        aria-label={t("packSession.manual.confirmAria", {
                          name: line.variantName
                            ? `${line.productName} ${line.variantName}`
                            : line.productName,
                        })}
                        onClick={() => handleManualConfirm(line.orderItemId)}
                      >
                        <Hand className="size-4" aria-hidden />
                        {t("packSession.manual.confirm")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </section>
          </>
        ) : null}
      </main>

      {canRead && packSession && !alreadyPacked ? (
        <StickyActionBar
          aboveNav
          lead={
            <p className="text-body-sm text-text-secondary">
              {!canMark
                ? t("packSession.markPacked.noPermission")
                : ready
                  ? t("packSession.markPacked.ready")
                  : t("packSession.markPacked.remaining", { count: remaining })}
            </p>
          }
        >
          <Button
            className="press-tactile tap-target elevation-action h-12 w-full gap-2 rounded-2xl"
            disabled={!ready || !canMark || markPacked.isPending}
            aria-busy={markPacked.isPending}
            onClick={() => markPacked.mutate()}
          >
            {markPacked.isPending ? <Spinner /> : <PackageCheck className="size-5" aria-hidden />}
            {t("packSession.markPacked.action")}
          </Button>
        </StickyActionBar>
      ) : null}

      <CameraScanSheet open={cameraOpen} onOpenChange={setCameraOpen} onCode={handleScan} />

      <BottomNav />
    </ScreenBleed>
  );
}

function markPackedErrorKey(result: MarkPackedResult): string {
  switch (result.kind) {
    case "incomplete":
      return "packSession.markPacked.incomplete";
    default:
      return "packSession.markPacked.failed";
  }
}
