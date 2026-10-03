import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LabelSheet } from "./LabelSheet";
import { InternalParcelLabel } from "./InternalParcelLabel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/design-system";
import { reauthorizeCapability, useCapabilities } from "@/hooks/use-capabilities";
import { getInternalParcelLabelData } from "@/lib/api";
import {
  buildInternalParcelLabel,
  INTERNAL_PARCEL_LABEL_SIZE_MM,
  type InternalParcelLabelInput,
} from "@/lib/labels/internal-parcel-label";
import { runInternalPrePrint } from "@/lib/labels/internal-print-guard";
import {
  createPrintGuard,
  printIdentity,
  type PrintGuard,
} from "@/lib/labels/shipping-print-guard";
import { fulfillmentKeys } from "@/lib/fulfillment-query";

/**
 * INTERNAL APSA Parcel label preview + print (CORRECTION-003). One or many
 * orders; each prints as its own 100×150 mm page.
 *
 * Always available for an order in fulfillment — before packing and with or
 * without a carrier shipment. The server returns the order's APSA Parcel
 * (created with confirmation) and its permanent code, so the label always shows the same identity on
 * every (re)print; this dialog never creates or chooses one. Nothing prints
 * unless every label in the batch carries its code.
 *
 * ── NOTHING PRINTS FROM CACHE ────────────────────────────────────────────────
 *
 * Same security model as the shipping label. Before printing, the label query
 * is cancelled and a brand-new authoritative read is made — the server
 * re-checks orders.read + fulfillment.print_label and the order lifecycle on
 * it — the print capability is re-authorized, and the attempt must still
 * belong to the same open dialog, user, organization and orders. A revoked
 * permission, a cancelled order, a failed refresh or an identity change does
 * not print (src/lib/labels/internal-print-guard.ts).
 */
type PrintNotice = "changed" | "refreshFailed";

export interface InternalParcelLabelDialogProps {
  open: boolean;
  onClose: () => void;
  orderIds: string[];
  userId: string;
  organizationId: string;
}

export function InternalParcelLabelDialog({
  open,
  onClose,
  orderIds,
  userId,
  organizationId,
}: InternalParcelLabelDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canPrint = useCapabilities().can("fulfillment.print_label");
  const [printNotice, setPrintNotice] = useState<PrintNotice | null>(null);

  useEffect(() => {
    if (!open) setPrintNotice(null);
  }, [open]);

  // A print attempt is bound to who started it and for which orders: closing
  // or unmounting the dialog, or a user / organization / order change, retires
  // the attempt in flight before it can print.
  const guardRef = useRef<PrintGuard | null>(null);
  if (guardRef.current === null) guardRef.current = createPrintGuard();
  const printGuard = guardRef.current;
  printGuard.setContext(printIdentity(userId, organizationId, orderIds), open);
  useEffect(() => () => printGuard.retire(), [printGuard]);

  const labelsKey = fulfillmentKeys.internalLabels(userId, organizationId, orderIds);
  const fetchLabels = () => Promise.all(orderIds.map((id) => getInternalParcelLabelData(id)));
  const query = useQuery({
    queryKey: labelsKey,
    queryFn: fetchLabels,
    enabled: open && orderIds.length > 0 && canPrint,
  });

  if (!open) return null;

  /** Pre-print hook: only a fresh, verified, authorized, still-live attempt prints. */
  async function handleBeforePrint(): Promise<React.ReactNode[] | null> {
    const live = printGuard.begin();
    setPrintNotice(null);
    let verified: InternalParcelLabelInput[] | null = null;
    const result = await runInternalPrePrint({
      onVerified: (fresh) => {
        verified = fresh;
      },
      displayed: canPrint ? (query.data ?? []) : [],
      queryClient,
      queryKey: labelsKey,
      read: fetchLabels,
      live,
      reauthorize: () =>
        reauthorizeCapability(queryClient, userId, organizationId, "fulfillment.print_label"),
    });
    if (result === "ok") {
      // The print target is built from the server's verified labels.
      return (
        (verified as InternalParcelLabelInput[] | null)?.map((d) => (
          <InternalParcelLabel key={d.order.id} vm={buildInternalParcelLabel(d)} />
        )) ?? null
      );
    }
    if (result === "retired") return null;
    if (result === "denied" || result === "refreshFailed") {
      // Fail closed: the label that could not be re-confirmed leaves the cache,
      // so the preview reloads from the server (a refusal shows as an error).
      void queryClient.cancelQueries({ queryKey: labelsKey, exact: true }).catch(() => undefined);
      queryClient.removeQueries({ queryKey: labelsKey, exact: true });
      setPrintNotice("refreshFailed");
      return null;
    }
    if (result === "changed") setPrintNotice("changed");
    return null;
  }

  const data = canPrint ? (query.data ?? []) : [];
  const allCoded = data.length > 0 && data.every((d) => !!d.parcelCode);
  const title =
    orderIds.length > 1
      ? t("labels.internal.bulkTitle", { count: orderIds.length })
      : t("labels.internal.dialogTitle");

  return (
    <LabelSheet
      open={open}
      onClose={onClose}
      title={title}
      pageSize={INTERNAL_PARCEL_LABEL_SIZE_MM}
      printable={canPrint && query.isSuccess && allCoded}
      onBeforePrint={handleBeforePrint}
      controls={
        canPrint && printNotice ? (
          <div role="alert" className="flex items-center justify-between gap-2">
            <p className="text-caption text-text-muted">
              {t(`labels.internal.printNotice.${printNotice}`)}
            </p>
            <Button
              type="button"
              variant="outline"
              className="tap-target h-9 shrink-0 rounded-xl"
              onClick={() => {
                setPrintNotice(null);
                void query.refetch();
              }}
            >
              {t("common.retry")}
            </Button>
          </div>
        ) : undefined
      }
    >
      {!canPrint ? (
        <div className="flex h-full items-center justify-center p-[6mm] text-center text-[10pt] text-black">
          {t("labels.internal.denied")}
        </div>
      ) : query.isPending ? (
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      ) : query.isError ? (
        <div className="flex h-full items-center justify-center p-[6mm] text-center text-[10pt] text-black">
          {t("labels.internal.error")}
        </div>
      ) : (
        data.map((d) => <InternalParcelLabel key={d.order.id} vm={buildInternalParcelLabel(d)} />)
      )}
    </LabelSheet>
  );
}
