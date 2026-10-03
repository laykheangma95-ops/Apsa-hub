/**
 * "Create APSA Parcel" — Order detail recovery for a CONFIRMED order that owns
 * no APSA Parcel (its confirmation committed but the parcel write failed).
 * Survives a refresh: the condition comes from the server's order read, not
 * from the failed confirmation's in-memory error.
 *
 * Never a lifecycle change and never a pretend draft. The server re-decides,
 * under the order row lock, that the order is still confirmed and still has no
 * parcel, and creates exactly one (migration 059). Offered only to members
 * holding orders.confirm — the same authority as confirmation; the server
 * checks it again.
 *
 * State isolation (same pattern as RetryDeliveryReadyBoundary): the mutation,
 * its pending state and its notice belong to exactly one user + organization +
 * order. Any change of identity remounts a clean instance, and a late response
 * for an old identity is dropped — it neither notifies, nor shows a notice,
 * nor touches caches.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, PackagePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { recoverRealOrderParcel } from "@/lib/api";
import { notifySuccess } from "@/lib/feedback";
import { classifyOrderError } from "@/lib/orders";
import { ordersKeys } from "@/lib/orders-query";
import { packingKeys } from "@/lib/packing-query";

export interface ParcelRecoveryIdentity {
  userId: string;
  organizationId: string;
  orderId: string;
}

export interface ParcelRecoveryProps extends ParcelRecoveryIdentity {
  /** The member holds orders.confirm. Decides what is OFFERED, never what is allowed. */
  canRecover: boolean;
}

/**
 * Keys the stateful action by every identity dimension, so an order, user or
 * organization switch never carries a pending recovery or its notice over.
 */
export function ParcelRecoveryBoundary(props: ParcelRecoveryProps) {
  const identity = `${props.userId}\u0000${props.organizationId}\u0000${props.orderId}`;
  return <ParcelRecoveryAction key={identity} {...props} />;
}

type RecoveryNotice = "not_confirmed" | "failed" | null;

export function ParcelRecoveryAction({
  userId,
  organizationId,
  orderId,
  canRecover,
}: ParcelRecoveryProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<RecoveryNotice>(null);
  // Identity is fixed for this instance (the boundary remounts on any change).
  // Once it unmounts, an in-flight result belongs to an old identity.
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const detailKey = ordersKeys.detail(userId, organizationId, orderId);

  const recover = useMutation({
    mutationFn: () => recoverRealOrderParcel(orderId),
    onSuccess: async (detail) => {
      if (!activeRef.current) return;
      setNotice(null);
      // The server's own answer: parcel present, so this action disappears.
      queryClient.setQueryData(detailKey, detail);
      notifySuccess(t("order.createParcelDone"));
      await Promise.all(
        [
          ordersKeys.detailDeliveries(userId, organizationId, orderId),
          packingKeys.orderState(userId, organizationId, orderId),
          ordersKeys.list(userId, organizationId),
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey, exact: true })),
      );
    },
    onError: async (error) => {
      if (!activeRef.current) return;
      const kind = classifyOrderError(error);
      // Cancelled (or otherwise moved) meanwhile: say so and re-read the order.
      if (kind === "stale" || kind === "not_found") {
        setNotice("not_confirmed");
        await queryClient.invalidateQueries({ queryKey: detailKey, exact: true });
      } else {
        setNotice("failed");
      }
    },
  });

  return (
    <section
      aria-labelledby="order-parcel-missing-title"
      className="flex flex-col gap-2 rounded-2xl border border-status-warning-border bg-status-warning-soft px-4 py-3"
    >
      {/* Status carried by icon + text, never colour alone. */}
      <p
        id="order-parcel-missing-title"
        className="text-body-sm flex items-start gap-2 font-semibold text-status-warning-text"
      >
        <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
        {t("order.parcelMissingTitle")}
      </p>
      <p className="text-body-sm text-text-secondary">{t("order.parcelMissingBody")}</p>
      {canRecover ? (
        <Button
          type="button"
          className="tap-target h-11 w-full gap-2 rounded-xl"
          disabled={recover.isPending}
          aria-busy={recover.isPending}
          onClick={() => {
            setNotice(null);
            recover.mutate();
          }}
        >
          <PackagePlus className="size-4" aria-hidden />
          {t("order.createParcel")}
        </Button>
      ) : (
        <p className="text-caption text-text-muted">{t("order.parcelMissingNoPermission")}</p>
      )}
      {notice ? (
        <p
          role="alert"
          className="text-body-sm flex items-start gap-2 rounded-xl bg-status-danger-soft px-3 py-2 text-status-danger-text"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t(
            notice === "not_confirmed"
              ? "order.createParcelNotConfirmed"
              : "order.createParcelFailed",
          )}
        </p>
      ) : null}
    </section>
  );
}
