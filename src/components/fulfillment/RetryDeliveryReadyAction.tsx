/**
 * "Retry delivery ready" — Order detail recovery for a packed order whose
 * delivery was left pending/preparing (readying it after Arrange Delivery is
 * best-effort). Never repacks; the server re-checks, under row locks, that the
 * order is still packed and that the member holds delivery.handoff.
 *
 * State isolation (same pattern as Pack Order's PackOrderIdentityBoundary):
 * the mutation, its pending state and its failure notice belong to exactly one
 * user + organization + order. Any change of identity remounts a clean
 * instance, and a late response for an old identity is dropped — it neither
 * notifies, nor shows a notice, nor touches caches.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { notifySuccess } from "@/lib/feedback";
import { ordersKeys } from "@/lib/orders-query";
import { packingKeys } from "@/lib/packing-query";

export interface RetryDeliveryReadyIdentity {
  userId: string;
  organizationId: string;
  orderId: string;
}

/**
 * Keys the stateful action by every identity dimension, so an order, user or
 * organization switch never carries a pending retry or its notice over.
 */
export function RetryDeliveryReadyBoundary(props: RetryDeliveryReadyIdentity) {
  const identity = `${props.userId}\u0000${props.organizationId}\u0000${props.orderId}`;
  return <RetryDeliveryReadyAction key={identity} {...props} />;
}

type RetryNotice = "not_packed" | "failed" | null;

export function RetryDeliveryReadyAction({
  userId,
  organizationId,
  orderId,
}: RetryDeliveryReadyIdentity) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<RetryNotice>(null);
  // Identity is fixed for this instance (the boundary remounts on any change).
  // Once it unmounts, an in-flight result belongs to an old identity.
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const retry = useMutation({
    mutationFn: async () => {
      const { retryPackedDeliveryReadyFn } = await import("@/api/packing");
      return retryPackedDeliveryReadyFn({ data: { orderId } });
    },
    onSuccess: async (result) => {
      if (!activeRef.current) return;
      if (result.kind === "ready" || result.kind === "already_ready") {
        setNotice(null);
        notifySuccess(t("order.retryDeliveryReadyDone"));
      } else {
        setNotice(result.kind === "not_packed" ? "not_packed" : "failed");
      }
      const keys = [
        ordersKeys.detail(userId, organizationId, orderId),
        ordersKeys.detailDeliveries(userId, organizationId, orderId),
        packingKeys.orderState(userId, organizationId, orderId),
      ];
      await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    },
    onError: () => {
      if (activeRef.current) setNotice("failed");
    },
  });

  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        className="tap-target h-11 w-full gap-2 rounded-xl"
        disabled={retry.isPending}
        aria-busy={retry.isPending}
        aria-describedby="order-retry-ready-hint"
        onClick={() => {
          setNotice(null);
          retry.mutate();
        }}
      >
        <RotateCw className="size-4" aria-hidden />
        {t("order.retryDeliveryReady")}
      </Button>
      <p id="order-retry-ready-hint" className="text-caption text-text-muted">
        {t("order.retryDeliveryReadyHint")}
      </p>
      {notice ? (
        // Status carried by icon + text, never colour alone.
        <p
          role="alert"
          className="text-body-sm flex items-start gap-2 rounded-xl bg-status-danger-soft px-3 py-2 text-status-danger-text"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t(
            notice === "not_packed"
              ? "order.retryDeliveryReadyNotPacked"
              : "order.retryDeliveryReadyFailed",
          )}
        </p>
      ) : null}
    </div>
  );
}
