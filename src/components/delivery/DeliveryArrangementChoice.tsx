import { Link } from "@tanstack/react-router";
import { Clock, Truck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * The two next steps after a merchant finishes an order (COD or paid by bank):
 *
 *   Arrange delivery now → the order opens with the delivery sheet up
 *                          (`?arrange=delivery`). Creating the delivery
 *                          generates the parcel identity, and the label opens
 *                          print-ready.
 *   Add delivery later   → nothing else happens: the order is already saved and
 *                          stays Awaiting Delivery Arrangement. No parcel
 *                          identity is generated; Print Label explains
 *                          "Arrange delivery first" until it is arranged.
 *
 * Presentation only. Whether a delivery may be created is the server's call
 * (createDelivery requires delivery.create and a confirmed, non-terminal order).
 */
export function DeliveryArrangementChoice({
  orderId,
  className,
}: {
  orderId: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [later, setLater] = useState(false);

  if (later) {
    // Status carried by icon + words, never colour alone.
    return (
      <div
        role="status"
        data-testid="delivery-choice-awaiting"
        className={`flex w-full items-start gap-2 rounded-xl border border-border-default bg-surface-secondary px-3 py-2.5 text-left ${className ?? ""}`}
      >
        <Clock className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden />
        <div className="min-w-0">
          <p className="text-label text-text-primary">{t("order.deliveryChoice.awaiting")}</p>
          <p className="text-caption text-text-muted">{t("order.deliveryChoice.awaitingBody")}</p>
        </div>
      </div>
    );
  }

  return (
    <section
      aria-labelledby={`delivery-choice-${orderId}`}
      data-testid="delivery-choice"
      className={`w-full space-y-2 text-left ${className ?? ""}`}
    >
      <div>
        <p id={`delivery-choice-${orderId}`} className="text-label text-text-primary">
          {t("order.deliveryChoice.title")}
        </p>
        <p className="text-caption text-text-muted">{t("order.deliveryChoice.body")}</p>
      </div>
      <Link
        to="/app/orders/$id"
        params={{ id: orderId }}
        search={{ arrange: "delivery" }}
        className="press tap-target text-label flex w-full items-center justify-center gap-2 rounded-full bg-brand-primary px-4 py-3 text-text-inverse"
      >
        <Truck className="size-4" aria-hidden />
        {t("order.deliveryChoice.arrangeNow")}
      </Link>
      <button
        type="button"
        onClick={() => setLater(true)}
        className="press tap-target text-label flex w-full items-center justify-center rounded-full border border-border-default px-4 py-3 text-text-primary"
      >
        {t("order.deliveryChoice.later")}
      </button>
    </section>
  );
}
