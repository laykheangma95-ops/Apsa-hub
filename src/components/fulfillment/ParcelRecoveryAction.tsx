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
 * order + PERMISSION GENERATION. Any change of identity, and any change of the
 * recovery permission, remounts a clean instance; a late response for an old
 * instance is dropped — it neither notifies, nor shows a notice, nor touches
 * caches. The generation only ever increases, so restoring the permission
 * never makes a request from an earlier generation eligible again. The server
 * remains the authority: this decides only which responses the UI accepts.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, PackagePlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { recoverRealOrderParcel } from "@/lib/api";
import type { InitiatingPrincipal } from "@/lib/initiating-principal";
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
 * A counter that increases every time the recovery permission changes, in
 * either direction (true → false → true is two new generations, never a return
 * to the first). Adjusted during render — React's sanctioned pattern for state
 * derived from a changing prop — so the new generation is in effect on the very
 * render that sees the new permission.
 */
function usePermissionGeneration(canRecover: boolean): number {
  const [seen, setSeen] = useState({ canRecover, generation: 0 });
  if (seen.canRecover !== canRecover) {
    const next = { canRecover, generation: seen.generation + 1 };
    setSeen(next);
    return next.generation;
  }
  return seen.generation;
}

/**
 * Keys the stateful action by every identity dimension AND the permission
 * generation, so an order, user or organization switch — or a change of the
 * recovery permission — never carries a pending recovery, its notice, or its
 * late response over to the new instance.
 */
export function ParcelRecoveryBoundary(props: ParcelRecoveryProps) {
  const generation = usePermissionGeneration(props.canRecover);
  const identity = `${props.userId}\u0000${props.organizationId}\u0000${props.orderId}\u0000${generation}`;
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
  // Identity and permission generation are fixed for this instance (the
  // boundary remounts on any change). Once it unmounts, an in-flight result
  // belongs to an old identity or an old permission generation.
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);
  // Each request gets a token; only the latest request of a mounted instance
  // may touch state or caches.
  const latestRequestRef = useRef(0);
  const isCurrent = useCallback(
    (token: number) => activeRef.current && token === latestRequestRef.current,
    [],
  );

  const detailKey = ordersKeys.detail(userId, organizationId, orderId);

  const recover = useMutation({
    // The principal is captured at the tap and sent as a refuse-only
    // precondition (CORRECTION-004): the instance is keyed by member +
    // organization, but a request already in flight is decided by the server,
    // which refuses it if the principal changed before it was handled.
    mutationFn: ({ startedAs }: { token: number; startedAs: InitiatingPrincipal }) =>
      recoverRealOrderParcel(orderId, startedAs),
    onSuccess: async (detail, { token }) => {
      if (!isCurrent(token)) return;
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
    onError: async (error, { token }) => {
      if (!isCurrent(token)) return;
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
            latestRequestRef.current += 1;
            recover.mutate({
              token: latestRequestRef.current,
              startedAs: { userId, organizationId },
            });
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
