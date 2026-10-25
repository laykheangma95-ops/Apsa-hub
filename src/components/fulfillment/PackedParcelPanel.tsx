/**
 * Order detail — the packed parcel: its saved details (package count, weight,
 * shelf / bin) and "Undo packing" for a Mark Packed done by mistake.
 *
 * Undo is offered only while the parcel is still in the shop (the server's
 * packed state says it is not handed off) and only to members who may pack
 * (delivery.handoff). The server decides again under the order lock
 * (undo_order_packing_v1, migration 065): it refuses once the parcel is with
 * the courier, requires a reason, and writes the history and audit rows in one
 * transaction. Undo never touches payment, stock or the order's lifecycle.
 *
 * State isolation: same identity boundary as RetryDeliveryReadyAction — a user,
 * organization or order switch remounts a clean instance, and a late response
 * for an old identity is dropped.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, MapPin, PackageCheck, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BottomSheet } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { notifySuccess } from "@/lib/feedback";
import type { InitiatingPrincipal } from "@/lib/initiating-principal";
import {
  STAFF_REASON_MAX,
  isValidStaffReason,
  type ParcelPackDetails,
} from "@/lib/order-work-queue";
import { ordersKeys } from "@/lib/orders-query";
import { packingKeys } from "@/lib/packing-query";
import { fulfillmentKeys } from "@/lib/fulfillment-query";

export interface PackedParcelIdentity {
  userId: string;
  organizationId: string;
  orderId: string;
}

interface PackedParcelPanelProps extends PackedParcelIdentity {
  details: ParcelPackDetails | null;
  /** Offer Undo: packed, not handed off, member holds delivery.handoff. */
  canUndo: boolean;
  /** The order's delivery is 'ready' — undoing cancels that booking. */
  deliveryReady: boolean;
}

export function PackedParcelBoundary(props: PackedParcelPanelProps) {
  const identity = `${props.userId}\u0000${props.organizationId}\u0000${props.orderId}`;
  return <PackedParcelPanel key={identity} {...props} />;
}

type UndoNotice = "handed_off" | "not_packed" | "reason_required" | "failed" | null;

export function PackedParcelPanel({
  userId,
  organizationId,
  orderId,
  details,
  canUndo,
  deliveryReady,
}: PackedParcelPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<UndoNotice>(null);
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const undo = useMutation({
    mutationFn: async ({ startedAs, text }: { startedAs: InitiatingPrincipal; text: string }) => {
      const { undoOrderPackingFn } = await import("@/api/packing");
      return undoOrderPackingFn({ data: { orderId, reason: text, expectedPrincipal: startedAs } });
    },
    onSuccess: async (result) => {
      if (!activeRef.current) return;
      if (result.kind === "undone") {
        setOpen(false);
        setReason("");
        setNotice(null);
        notifySuccess(t("order.undoPacking.done"));
      } else {
        setNotice(
          result.kind === "handed_off" ||
            result.kind === "not_packed" ||
            result.kind === "reason_required"
            ? result.kind
            : "failed",
        );
      }
      // Either way the saved state may have moved: re-read it.
      const keys = [
        ordersKeys.principal(userId, organizationId),
        packingKeys.principal(userId, organizationId),
        fulfillmentKeys.readyToPack(userId, organizationId),
      ];
      await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    },
    onError: () => {
      if (activeRef.current) setNotice("failed");
    },
  });

  const reasonOk = isValidStaffReason(reason);

  return (
    <div className="flex flex-col gap-2">
      {details ? (
        <div className="rounded-xl border border-border-default bg-surface-primary px-3 py-2.5">
          <p className="text-label flex items-center gap-2 text-text-primary">
            <PackageCheck className="size-4 shrink-0 text-text-muted" aria-hidden />
            {t("order.packDetails.title")}
          </p>
          <p className="text-body-sm mt-1 flex flex-wrap gap-x-3 gap-y-1 text-text-secondary">
            <span>{t("order.packDetails.packages", { count: details.packageCount })}</span>
            {details.weightGrams !== null ? (
              <span className="tnum">
                {t("order.packDetails.weight", { grams: details.weightGrams })}
              </span>
            ) : null}
          </p>
          <p className="text-body-sm mt-1 flex items-start gap-1.5 text-text-secondary">
            <MapPin className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden />
            <span className="min-w-0 break-words">
              {details.storageLocation
                ? t("order.packDetails.shelf", { location: details.storageLocation })
                : t("order.packDetails.noShelf")}
            </span>
          </p>
        </div>
      ) : null}

      {canUndo ? (
        <Button
          type="button"
          variant="outline"
          className="tap-target h-11 w-full gap-2 rounded-xl"
          onClick={() => {
            setNotice(null);
            setOpen(true);
          }}
        >
          <Undo2 className="size-4" aria-hidden />
          {t("order.undoPacking.action")}
        </Button>
      ) : null}

      {notice && !open ? <UndoNoticeLine notice={notice} /> : null}

      <BottomSheet
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            setReason("");
            setNotice(null);
          }
          setOpen(next);
        }}
        title={t("order.undoPacking.title")}
        snap="half"
      >
        <p className="text-body-sm text-text-secondary">{t("order.undoPacking.body")}</p>
        {deliveryReady ? (
          <p className="text-body-sm mt-2 rounded-xl bg-status-warning-soft px-3 py-2 text-status-warning-text">
            {t("order.undoPacking.readyDelivery")}
          </p>
        ) : null}
        <div className="mt-4 flex flex-col gap-1.5">
          <Label htmlFor="undo-packing-reason" className="text-label text-text-secondary">
            {t("order.undoPacking.reason")}
          </Label>
          <Textarea
            id="undo-packing-reason"
            value={reason}
            maxLength={STAFF_REASON_MAX}
            aria-describedby="undo-packing-reason-hint"
            aria-required="true"
            onChange={(e) => setReason(e.target.value)}
          />
          <p id="undo-packing-reason-hint" className="text-caption text-text-muted">
            {t("order.undoPacking.reasonHint")}
          </p>
        </div>
        {notice ? (
          <div className="mt-3">
            <UndoNoticeLine notice={notice} />
          </div>
        ) : null}
        <div className="mt-5 flex flex-col gap-2">
          <Button
            className="tap-target h-12 w-full"
            variant="destructive"
            disabled={!reasonOk || undo.isPending}
            aria-busy={undo.isPending}
            onClick={() =>
              undo.mutate({ startedAs: { userId, organizationId }, text: reason.trim() })
            }
          >
            {t("order.undoPacking.submit")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="tap-target h-12 w-full"
            onClick={() => setOpen(false)}
          >
            {t("order.undoPacking.keep")}
          </Button>
        </div>
      </BottomSheet>
    </div>
  );
}

function UndoNoticeLine({ notice }: { notice: Exclude<UndoNotice, null> }) {
  const { t } = useTranslation();
  const key = {
    handed_off: "order.undoPacking.handedOff",
    not_packed: "order.undoPacking.notPacked",
    reason_required: "order.undoPacking.reasonRequired",
    failed: "order.undoPacking.failed",
  }[notice];
  // Status carried by icon + text, never colour alone.
  return (
    <p
      role="alert"
      className="text-body-sm flex items-start gap-2 rounded-xl bg-status-danger-soft px-3 py-2 text-status-danger-text"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      {t(key)}
    </p>
  );
}
