/**
 * Confirm / edit an order's shipping destination snapshot (§9, §10).
 *
 * Opened when a parcel label cannot print because the order has no confirmed
 * destination (a pre-snapshot order, or one placed for pickup that now ships),
 * and for correcting a destination before the parcel goes out. It writes the
 * order-authoritative snapshot via updateOrderShipping (server requires
 * orders.update and refuses once fulfillment is terminal); on success the caller
 * evicts the stale label cache so the label refetches with the confirmed
 * destination.
 *
 * The server owns validation — this only surfaces the two required-field
 * messages locally so the merchant is not sent a round trip for a blank form.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { ShippingDestinationFields } from "@/components/orders/ShippingDestinationFields";
import {
  type ShippingDestinationValue,
  shippingDestinationPayload,
} from "@/lib/shipping-destination";
import { updateOrderShipping } from "@/lib/api";
import type { InitiatingPrincipal } from "@/lib/initiating-principal";
import { classifyOrderError } from "@/lib/orders";

export interface ShippingDestinationSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string;
  /** Merchant-facing order code, for the sheet header context. */
  orderNumber: string;
  /** Prefill (e.g. the customer's on-file name/phone) — a suggestion, not authority. */
  initial?: Partial<ShippingDestinationValue>;
  /** True when the order already has a snapshot (edit) vs. none yet (confirm). */
  editing?: boolean;
  /** Fires after a successful save, so the caller can evict the label cache and refetch. */
  onSaved: () => void;
  /**
   * The member + organization the host screen acts as. Captured when Save is
   * tapped and sent as a refuse-only precondition (CORRECTIONS.md,
   * CORRECTION-004): the server refuses the edit, writing nothing, if a member
   * or organization switch lands before it is handled. Never authorization.
   */
  principal: InitiatingPrincipal;
}

export function ShippingDestinationSheet({
  open,
  onOpenChange,
  orderId,
  orderNumber,
  initial,
  editing = false,
  onSaved,
  principal,
}: ShippingDestinationSheetProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState<ShippingDestinationValue>({
    name: initial?.name ?? "",
    phone: initial?.phone ?? "",
    address: initial?.address ?? "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<"validation" | "permission" | "generic" | null>(null);
  const submittingRef = useRef(false);

  // Re-seed when the sheet opens for a different order (the component may be
  // reused across orders in a bulk print).
  useEffect(() => {
    if (open) {
      setValue({
        name: initial?.name ?? "",
        phone: initial?.phone ?? "",
        address: initial?.address ?? "",
      });
      setFailure(null);
      setSubmitting(false);
      submittingRef.current = false;
    }
    // initial is intentionally not a dependency: it is a per-open snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orderId]);

  async function save() {
    if (submittingRef.current) return;
    const startedAs = principal;
    const payload = shippingDestinationPayload(value);
    if (!payload || !payload.name || !payload.address) {
      setFailure("validation");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      await updateOrderShipping(orderId, payload, startedAs);
      onSaved();
      onOpenChange(false);
    } catch (error) {
      setFailure(classifyOrderError(error) === "forbidden" ? "permission" : "generic");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t(editing ? "shipping.editTitle" : "shipping.confirmTitle")}
      snap="full"
      className="lg:max-w-[480px]"
      footer={
        <Button
          className="tap-target h-12 w-full"
          disabled={submitting}
          onClick={() => void save()}
        >
          {submitting ? t("shipping.saving") : t("shipping.save")}
        </Button>
      }
    >
      <section className="space-y-4 pb-4">
        <div className="rounded-xl border border-border-default bg-surface-secondary px-3 py-2.5">
          <p className="text-label tnum text-text-primary">{orderNumber}</p>
          <p className="text-caption mt-0.5 text-text-muted">
            {t(editing ? "shipping.note" : "shipping.confirmBody")}
          </p>
        </div>

        <ShippingDestinationFields
          idPrefix={`confirm-${orderId}`}
          value={value}
          onChange={setValue}
        />

        {failure === "validation" ? (
          <p className="text-caption text-status-danger-text">
            {!value.name.trim() ? t("shipping.nameRequired") : t("shipping.addressRequired")}
          </p>
        ) : null}

        {failure === "permission" || failure === "generic" ? (
          <OperationalState
            tone="danger"
            title={t("shipping.error")}
            body={t("shipping.error")}
            onRetry={() => void save()}
          />
        ) : null}
      </section>
    </BottomSheet>
  );
}
