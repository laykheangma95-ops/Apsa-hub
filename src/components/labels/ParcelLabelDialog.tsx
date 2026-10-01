import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LabelSheet } from "./LabelSheet";
import { ParcelLabel } from "./ParcelLabel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
 * On print, every order without a parcel code gets one created via
 * createParcelFn (idempotent). Orders that already have a parcel code reuse it
 * unchanged — reprinting never generates a new identity. The QR and optional
 * Code 128 barcode both encode the same parcel identity.
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
  const [includeCode128, setIncludeCode128] = useState(false);

  useEffect(() => {
    if (!canPrint || !open) setConfirmOrderId(null);
  }, [canPrint, open]);

  const query = useQuery({
    queryKey: fulfillmentKeys.parcelLabels(userId, organizationId, orderIds),
    queryFn: () => Promise.all(orderIds.map((id) => getParcelLabelData(id))),
    enabled: open && orderIds.length > 0 && canPrint,
  });

  /**
   * Ensure every order in the batch has a parcel identity before printing.
   * Idempotent: createParcel returns the existing parcel if one exists.
   * After creating missing parcels, refetch label data so the parcel codes
   * appear on the labels.
   */
  const ensureParcelsMutation = useMutation({
    mutationFn: async (labelData: ParcelLabelInput[]) => {
      const needsParcel = labelData.filter((d) => !d.parcelCode);
      if (needsParcel.length === 0) return;
      await Promise.all(needsParcel.map((d) => createParcel(d.order.id)));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: fulfillmentKeys.parcelLabelsPrefix(userId, organizationId),
      });
    },
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
   * Pre-print hook: ensure parcel identities exist, then reauthorize.
   * If any order is missing a parcel code, create it first, refetch, and only
   * then proceed to the authorization check and print.
   */
  async function handleBeforePrint(): Promise<boolean> {
    const currentData: ParcelLabelInput[] = canPrint ? (query.data ?? []) : [];
    const needsParcel = currentData.some((d) => !d.parcelCode);

    if (needsParcel && canCreateParcel) {
      try {
        await ensureParcelsMutation.mutateAsync(currentData);
        // Wait for the refetch to complete so labels show parcel codes.
        await queryClient.refetchQueries({
          queryKey: fulfillmentKeys.parcelLabels(userId, organizationId, orderIds),
        });
      } catch {
        return false;
      }
    }

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
        printable={canPrint && allConfirmed}
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
              <label className="flex items-center gap-2 pt-1">
                <Checkbox
                  checked={includeCode128}
                  onCheckedChange={(c) => setIncludeCode128(c === true)}
                  aria-label={t("labels.parcel.includeCode128")}
                />
                <span className="text-body-sm text-text-secondary">
                  {t("labels.parcel.includeCode128")}
                </span>
              </label>
            </div>
          ) : undefined
        }
      >
        {!canPrint ? (
          <div className="flex h-full items-center justify-center p-[6mm] text-center text-[10pt] text-black">
            {t("labels.parcel.denied")}
          </div>
        ) : query.isPending || ensureParcelsMutation.isPending ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : query.isError ? (
          <div className="flex h-full items-center justify-center p-[6mm] text-center text-[10pt] text-black">
            {t("labels.parcel.error")}
          </div>
        ) : (
          confirmed.map((d) => (
            <ParcelLabel key={d.order.id} vm={buildParcelLabel({ ...d, includeCode128 })} />
          ))
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
