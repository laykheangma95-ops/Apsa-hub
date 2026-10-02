import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { createParcel, getParcelLabelData } from "@/lib/api";
import { buildParcelLabel, PARCEL_LABEL_SIZE_MM } from "@/lib/labels/parcel-label";
import type { ParcelLabelInput } from "@/lib/labels/parcel-label";
import { fulfillmentKeys } from "@/lib/fulfillment-query";

/**
 * Parcel label preview + print (§13, §17). Accepts one or many order ids; each
 * order prints as its own 100×150 mm page (§17 bulk print).
 *
 * ── PARCEL IDENTITY INTEGRATION ──────────────────────────────────────────────
 *
 * When the labels load, every order without a parcel code gets one created via
 * createParcelFn (idempotent), and the labels refetch. Orders that already have
 * a parcel code reuse it unchanged — reprinting never generates a new identity.
 * The QR and the Code 128 barcode both encode that same parcel identity.
 *
 * Printing is blocked until EVERY label in the batch carries its parcel code, so
 * a label can never go to the printer without its codes, or with a legacy
 * order-UUID QR. A member who cannot create parcels (and whose orders have no
 * code yet) is told to ask someone who can.
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
  const canCreateParcel = capabilities.can("fulfillment.create_parcel");

  useSensitiveCapabilityRevalidation(userId, organizationId, open);

  const [confirmOrderId, setConfirmOrderId] = useState<string | null>(null);

  useEffect(() => {
    if (!canPrint || !open) setConfirmOrderId(null);
  }, [canPrint, open]);

  const query = useQuery({
    queryKey: fulfillmentKeys.parcelLabels(userId, organizationId, orderIds),
    queryFn: () => Promise.all(orderIds.map((id) => getParcelLabelData(id))),
    enabled: open && orderIds.length > 0 && canPrint,
  });

  /**
   * Ensure every order in the batch has a parcel identity. Idempotent:
   * createParcel returns the existing parcel if one exists. After creating
   * missing parcels, refetch label data so the codes appear on the labels.
   */
  const ensureParcelsMutation = useMutation({
    mutationFn: async (labelData: ParcelLabelInput[]) => {
      const needsParcel = labelData.filter((d) => !d.parcelCode);
      if (needsParcel.length === 0) return;
      await Promise.all(needsParcel.map((d) => createParcel(d.order.id)));
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: fulfillmentKeys.parcelLabelsPrefix(userId, organizationId),
      }),
  });

  // One automatic attempt per opened batch — a failure is shown, never retried
  // in a loop.
  const batchKey = orderIds.join(",");
  const attemptedBatch = useRef<string | null>(null);
  const loaded = canPrint && query.isSuccess ? query.data : null;
  const missingCodes = loaded ? loaded.some((d) => !d.parcelCode) : false;
  useEffect(() => {
    if (!open) {
      attemptedBatch.current = null;
      return;
    }
    if (!loaded || !missingCodes || !canCreateParcel) return;
    if (attemptedBatch.current === batchKey) return;
    attemptedBatch.current = batchKey;
    ensureParcelsMutation.mutate(loaded);
  }, [open, loaded, missingCodes, canCreateParcel, batchKey, ensureParcelsMutation]);

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
   * Pre-print hook: never print a label without its parcel code (the Print
   * button is hidden in that case too), then reauthorize server-side.
   */
  async function handleBeforePrint(): Promise<boolean> {
    const currentData: ParcelLabelInput[] = canPrint ? (query.data ?? []) : [];
    if (currentData.length === 0 || currentData.some((d) => !d.parcelCode)) return false;
    return reauthorizePrint();
  }

  const data: ParcelLabelInput[] = canPrint ? (query.data ?? []) : [];
  const confirmTarget =
    canPrint && canConfirm && confirmOrderId
      ? (data.find((d) => d.order.id === confirmOrderId) ?? null)
      : null;
  const unconfirmed = data.filter((d) => !d.customer.addressConfirmed);
  const confirmed = data.filter((d) => d.customer.addressConfirmed);
  const allConfirmed = data.length > 0 && unconfirmed.length === 0;
  const allCoded = data.length > 0 && data.every((d) => !!d.parcelCode);
  // Creation failed, or succeeded yet the refetched labels still lack a code.
  const codeError =
    ensureParcelsMutation.isError ||
    (ensureParcelsMutation.isSuccess && !query.isFetching && missingCodes);
  const assigningCodes = missingCodes && canCreateParcel && !codeError;

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
        printable={canPrint && allConfirmed && allCoded}
        active={confirmTarget === null}
        onBeforePrint={handleBeforePrint}
        controls={
          canPrint && query.isSuccess ? (
            <div className="space-y-2">
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
              {missingCodes && !canCreateParcel ? (
                <p role="status" className="text-caption text-text-muted">
                  {t("labels.parcel.needsParcelCode")}
                </p>
              ) : null}
              {codeError ? (
                <div role="alert" className="flex items-center justify-between gap-2">
                  <p className="text-caption text-text-muted">
                    {t("labels.parcel.parcelCodeError")}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="tap-target h-9 shrink-0 rounded-xl"
                    onClick={() => ensureParcelsMutation.mutate(data)}
                  >
                    {t("common.retry")}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : undefined
        }
      >
        {!canPrint ? (
          <div className="flex h-full items-center justify-center p-[6mm] text-center text-[10pt] text-black">
            {t("labels.parcel.denied")}
          </div>
        ) : query.isPending || ensureParcelsMutation.isPending || assigningCodes ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : query.isError ? (
          <div className="flex h-full items-center justify-center p-[6mm] text-center text-[10pt] text-black">
            {t("labels.parcel.error")}
          </div>
        ) : (
          confirmed.map((d) => <ParcelLabel key={d.order.id} vm={buildParcelLabel(d)} />)
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
