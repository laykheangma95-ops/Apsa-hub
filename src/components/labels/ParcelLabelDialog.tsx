import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LabelSheet } from "./LabelSheet";
import { ParcelLabel } from "./ParcelLabel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/design-system";
import { ShippingDestinationSheet } from "@/components/orders/ShippingDestinationSheet";
import {
  reauthorizeCapability,
  useCapabilities,
  useSensitiveCapabilityRevalidation,
} from "@/hooks/use-capabilities";
import { getParcelLabelData } from "@/lib/api";
import { buildParcelLabel, PARCEL_LABEL_SIZE_MM } from "@/lib/labels/parcel-label";
import type { ParcelLabelInput } from "@/lib/labels/parcel-label";
import { fulfillmentKeys } from "@/lib/fulfillment-query";
import {
  createPrintGuard,
  printIdentity,
  shippingLabelIssues,
  verifyFreshLabels,
  type PrintGuard,
} from "@/lib/labels/shipping-print-guard";

/**
 * SHIPPING label preview + print (§13, §17). Accepts one or many order ids; each
 * order prints as its own 100×150 mm page (§17 bulk print).
 *
 * ── SHIPPING LABEL VS APSA PARCEL LABEL (CORRECTION-003) ─────────────────────
 *
 * This is the carrier-facing label: carrier, tracking (Code 128), sender,
 * receiver, COD. It exists only for a carrier shipment — an order without one
 * is not printable and is told so. It never creates or changes the APSA
 * Parcel: the parcel ID appears as secondary text only. The scannable internal
 * identity is printed by InternalParcelLabelDialog, always available.
 *
 * A cancelled shipment is not printable (its carrier/tracking are void); the
 * replacement shipment prints a NEW shipping label with the SAME parcel ID.
 *
 * ── ORDER-AUTHORITATIVE DESTINATION (§9, §13, migration 047) ──────────────────
 *
 * A label's destination is the ORDER's shipping snapshot, never the mutable
 * customer default. An order whose snapshot is not confirmed
 * (addressConfirmed === false) is NOT printable.
 *
 * ── PII IS FAIL-CLOSED (§12) ──────────────────────────────────────────────────
 *
 * The label payload carries customer name, phone and delivery address, so the
 * query key is principal-partitioned and the fetch is gated on
 * `canSensitive("fulfillment.print_label")`.
 */
type PrintNotice = "changed" | "invalid" | "refreshFailed";

/** A recoverable problem: what is wrong, and a way to try again. */
function RecoverableError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex items-center justify-between gap-2">
      <p className="text-caption text-text-muted">{message}</p>
      <Button
        type="button"
        variant="outline"
        className="tap-target h-9 shrink-0 rounded-xl"
        onClick={onRetry}
      >
        {t("common.retry")}
      </Button>
    </div>
  );
}

export interface ParcelLabelDialogProps {
  open: boolean;
  onClose: () => void;
  orderIds: string[];
  userId: string;
  organizationId: string;
}

export function ParcelLabelDialog({
  open,
  onClose,
  orderIds,
  userId,
  organizationId,
}: ParcelLabelDialogProps) {
  const { t } = useTranslation();
  const capabilities = useCapabilities();
  const queryClient = useQueryClient();
  const canPrint = capabilities.canSensitive("fulfillment.print_label");
  const canConfirm = capabilities.can("orders.update");

  useSensitiveCapabilityRevalidation(userId, organizationId, open);

  const [confirmOrderId, setConfirmOrderId] = useState<string | null>(null);
  const [printNotice, setPrintNotice] = useState<PrintNotice | null>(null);

  useEffect(() => {
    if (!canPrint || !open) setConfirmOrderId(null);
    if (!open) setPrintNotice(null);
  }, [canPrint, open]);

  /*
   * A print attempt is bound to who started it and for which orders: closing
   * the dialog, unmounting it (navigation), a user or organization switch, or
   * a different batch retires the attempt in flight before it can print.
   */
  const guardRef = useRef<PrintGuard | null>(null);
  if (guardRef.current === null) guardRef.current = createPrintGuard();
  const printGuard = guardRef.current;
  printGuard.setContext(printIdentity(userId, organizationId, orderIds), open);
  useEffect(() => () => printGuard.retire(), [printGuard]);

  const labelsKey = fulfillmentKeys.parcelLabels(userId, organizationId, orderIds);
  const fetchLabels = () => Promise.all(orderIds.map((id) => getParcelLabelData(id)));
  const query = useQuery({
    queryKey: labelsKey,
    queryFn: fetchLabels,
    enabled: open && orderIds.length > 0 && canPrint,
    // Never reopen onto, or keep, an earlier opening's shipment/payment data.
    gcTime: 0,
    refetchOnMount: "always",
  });

  if (!open) return null;

  async function reauthorizePrint(): Promise<boolean> {
    const ok = await reauthorizeCapability(
      queryClient,
      userId,
      organizationId,
      "fulfillment.print_label",
    );
    if (!ok) {
      setConfirmOrderId(null);
      const queryKey = fulfillmentKeys.parcelLabelsPrefix(userId, organizationId);
      void queryClient.cancelQueries({ queryKey }).catch(() => undefined);
      queryClient.removeQueries({ queryKey });
    }
    return ok;
  }

  /**
   * Pre-print hook — nothing prints from cache:
   *   1. the labels on screen must be complete (the Print button is hidden
   *      otherwise too);
   *   2. FRESH authoritative label data is fetched now and must match what is
   *      shown — same parcel, same shipment (a replacement has a new id), same
   *      tracking, same payment state and COD amount. A difference replaces the
   *      preview and asks the merchant to review instead of printing;
   *   3. the attempt must still belong to the same open dialog, user,
   *      organization and orders after every await;
   *   4. the print capability is re-authorized server-side.
   */
  async function handleBeforePrint(): Promise<boolean> {
    const displayed: ParcelLabelInput[] = canPrint ? (query.data ?? []) : [];
    if (displayed.length === 0 || displayed.some((d) => shippingLabelIssues(d).length > 0)) {
      return false;
    }
    const live = printGuard.begin();
    setPrintNotice(null);
    let fresh: ParcelLabelInput[];
    try {
      fresh = await queryClient.fetchQuery({
        queryKey: labelsKey,
        queryFn: fetchLabels,
        staleTime: 0,
      });
    } catch {
      // The refusal may be a revoked grant: re-authorize so a denial evicts
      // the label PII and shows the denied state (fail closed). Only a still
      // authorized member is told the refresh failed and offered a retry.
      const stillAllowed = await reauthorizePrint();
      if (stillAllowed && live()) setPrintNotice("refreshFailed");
      return false;
    }
    if (!live()) return false;
    const verdict = verifyFreshLabels(displayed, fresh);
    if (verdict.kind !== "ok") {
      setPrintNotice(verdict.kind);
      return false;
    }
    const allowed = await reauthorizePrint();
    return allowed && live();
  }

  const data: ParcelLabelInput[] = canPrint ? (query.data ?? []) : [];
  const confirmTarget =
    canPrint && canConfirm && confirmOrderId
      ? (data.find((d) => d.order.id === confirmOrderId) ?? null)
      : null;
  const unconfirmed = data.filter((d) => !d.customer.addressConfirmed);
  const confirmed = data.filter((d) => d.customer.addressConfirmed);
  const allConfirmed = data.length > 0 && unconfirmed.length === 0;
  // Complete labels only: parcel + its QR, shipment, tracking, renderable
  // tracking barcode (CORRECTION-003). An incomplete one is shown as an error,
  // never printed with a placeholder.
  const issuesByOrder = new Map(data.map((d) => [d.order.id, shippingLabelIssues(d)]));
  const allComplete =
    data.length > 0 && data.every((d) => (issuesByOrder.get(d.order.id) ?? []).length === 0);

  const title =
    orderIds.length > 1
      ? t("labels.parcel.bulkTitle", { count: orderIds.length })
      : t("labels.parcel.title");

  function evictAndRefetch() {
    void queryClient.invalidateQueries({
      queryKey: fulfillmentKeys.parcelLabelsPrefix(userId, organizationId),
    });
    void queryClient.invalidateQueries({
      queryKey: fulfillmentKeys.readyToPack(userId, organizationId),
    });
  }

  return (
    <>
      <LabelSheet
        open={open}
        onClose={onClose}
        title={title}
        pageSize={PARCEL_LABEL_SIZE_MM}
        printable={canPrint && allConfirmed && allComplete}
        active={confirmTarget === null}
        onBeforePrint={handleBeforePrint}
        controls={
          canPrint && query.isError ? (
            <RecoverableError
              message={t("labels.parcel.error")}
              onRetry={() => void query.refetch()}
            />
          ) : canPrint && query.isSuccess ? (
            <div className="space-y-2">
              {printNotice ? (
                <RecoverableError
                  message={t(`labels.parcel.printNotice.${printNotice}`)}
                  onRetry={() => {
                    setPrintNotice(null);
                    void query.refetch();
                  }}
                />
              ) : null}
              {!allComplete ? (
                <RecoverableError
                  message={t("labels.parcel.cannotPrint")}
                  onRetry={() => void query.refetch()}
                />
              ) : null}
              {unconfirmed.length > 0 ? (
                <div>
                  <p className="text-label text-text-primary">
                    {t("labels.parcel.needsConfirmTitle")}
                  </p>
                  <p className="text-caption text-text-muted">
                    {unconfirmed.length === 1
                      ? t("labels.parcel.needsConfirmOne")
                      : t("labels.parcel.needsConfirmBody", { count: unconfirmed.length })}
                  </p>
                </div>
              ) : null}
              {unconfirmed.length > 0 || canConfirm ? (
                <ul className="space-y-1.5">
                  {data
                    .filter((d) => !d.customer.addressConfirmed || canConfirm)
                    .map((d) => (
                      <li
                        key={d.order.id}
                        className="flex items-center justify-between gap-2 rounded-xl border border-border-default px-3 py-2"
                      >
                        <span className="text-label tnum min-w-0 flex-1 truncate text-text-primary">
                          {d.order.orderNumber}
                        </span>
                        {canConfirm ? (
                          <Button
                            type="button"
                            variant="outline"
                            className="tap-target h-9 shrink-0 rounded-xl"
                            onClick={() => setConfirmOrderId(d.order.id)}
                          >
                            {d.customer.addressConfirmed
                              ? t("labels.parcel.editCta")
                              : t("labels.parcel.confirmCta")}
                          </Button>
                        ) : null}
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : undefined
        }
      >
        {!canPrint ? (
          <div className="flex h-full items-center justify-center p-[6mm] text-center text-[10pt] text-black">
            {t("labels.parcel.denied")}
          </div>
        ) : query.isPending ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : query.isError ? (
          <div className="flex h-full items-center justify-center p-[6mm] text-center text-[10pt] text-black">
            {t("labels.parcel.error")}
          </div>
        ) : (
          confirmed.map((d) => {
            const issues = issuesByOrder.get(d.order.id) ?? [];
            return issues.length > 0 ? (
              <div
                key={d.order.id}
                role="alert"
                data-testid="shipping-label-invalid"
                className="flex h-full flex-col items-center justify-center gap-[2mm] p-[6mm] text-center text-[10pt] text-black"
              >
                <p className="font-bold">
                  {t("labels.parcel.cannotPrint")} · {d.order.orderNumber}
                </p>
                <ul className="space-y-[1mm]">
                  {issues.map((issue) => (
                    <li key={issue}>{t(`labels.parcel.issue.${issue}`)}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <ParcelLabel key={d.order.id} vm={buildParcelLabel(d)} />
            );
          })
        )}
      </LabelSheet>

      {confirmTarget ? (
        <ShippingDestinationSheet
          key={confirmTarget.order.id}
          open
          onOpenChange={(next) => {
            if (!next) setConfirmOrderId(null);
          }}
          orderId={confirmTarget.order.id}
          orderNumber={confirmTarget.order.orderNumber}
          initial={{
            name: confirmTarget.customer.name ?? "",
            phone: confirmTarget.customer.phone ?? "",
            address: confirmTarget.customer.address ?? "",
          }}
          editing={confirmTarget.customer.addressConfirmed}
          onSaved={() => {
            setConfirmOrderId(null);
            evictAndRefetch();
          }}
        />
      ) : null}
    </>
  );
}
