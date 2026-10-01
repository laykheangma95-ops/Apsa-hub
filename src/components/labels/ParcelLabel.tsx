import { useTranslation } from "react-i18next";
import type { ParcelLabelViewModel } from "@/lib/labels/parcel-label";

/**
 * One 100×150 mm parcel/shipping label (§13). Black-on-white for scannability
 * and print fidelity (see ProductLabel for the design-token exception). Contains
 * exactly the fulfillment PII the view model carries (name, phone, address) and
 * never anything else (§14). Payment is shown as PAID or an amount to collect,
 * both derived from authoritative data upstream — never recomputed here (§18).
 *
 * Status is never colour-only: PAID / COD are words, not just a tint (CLAUDE.md).
 */
export function ParcelLabel({ vm }: { vm: ParcelLabelViewModel }) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full w-full flex-col gap-[2mm] p-[4mm] text-black">
      {/* Merchant */}
      <div className="flex items-start justify-between gap-[2mm] border-b border-black pb-[2mm]">
        <div className="min-w-0">
          <p className="text-[7pt] tracking-wide text-neutral-600">{t("labels.parcel.from")}</p>
          <p className="truncate text-[11pt] font-bold">{vm.merchantName}</p>
        </div>
        {/* Re-issue marker — a word, never colour alone (§19). */}
        {vm.reprint ? (
          <span className="shrink-0 border border-black px-[1.5mm] py-[0.5mm] text-[7pt] font-bold tracking-wide">
            {t("labels.parcel.reprint")}
          </span>
        ) : null}
      </div>

      {/* Customer (fulfillment PII only) */}
      <div className="border-b border-black pb-[2mm]">
        <p className="text-[7pt] tracking-wide text-neutral-600">{t("labels.parcel.to")}</p>
        {vm.customer.name ? (
          <p className="text-[12pt] font-bold leading-tight">{vm.customer.name}</p>
        ) : null}
        {vm.customer.phone ? (
          <p className="text-[10pt] leading-tight tabular-nums">
            {t("labels.parcel.phone")}: {vm.customer.phone}
          </p>
        ) : null}
        {vm.customer.address ? (
          <p className="text-[9pt] leading-snug">{vm.customer.address}</p>
        ) : (
          <p className="text-[9pt] leading-snug font-semibold">{t("labels.parcel.noAddress")}</p>
        )}
        {!vm.customer.addressConfirmed ? (
          <p className="mt-[0.5mm] border border-black px-[1mm] py-[0.5mm] text-[7pt] font-bold leading-tight">
            ⚠ {t("labels.parcel.addressNotConfirmed")}
          </p>
        ) : null}
      </div>

      {/* Order + items */}
      <div className="flex min-h-0 flex-1 flex-col border-b border-black pb-[2mm]">
        <div className="flex shrink-0 items-baseline justify-between">
          <p className="text-[11pt] font-bold tabular-nums">{vm.orderNumber}</p>
          <p className="text-[8pt] text-neutral-700">
            {t("labels.parcel.items", { count: vm.itemCount })}
          </p>
        </div>
        <ul className="mt-[1mm] min-h-0 flex-1 space-y-[0.5mm] overflow-hidden">
          {vm.items.map((line, i) => (
            <li key={i} className="truncate text-[8pt] leading-tight">
              {line.text}
            </li>
          ))}
        </ul>
        {vm.overflowCount > 0 ? (
          <p className="mt-[0.5mm] shrink-0 text-[7pt] text-neutral-600">
            {t("labels.parcel.moreItems", { count: vm.overflowCount })}
          </p>
        ) : null}
      </div>

      {/* Payment + QR + Code128 */}
      <div className="flex items-end justify-between gap-[3mm]">
        <div className="min-w-0 flex-1">
          {vm.payment.paid ? (
            <p className="inline-block border-2 border-black px-[2mm] py-[1mm] text-[12pt] font-bold">
              {t("labels.parcel.paid")}
            </p>
          ) : (
            <div>
              <p className="text-[9pt] font-semibold">{t("labels.parcel.cod")}</p>
              <p className="text-[7pt] text-neutral-700">{t("labels.parcel.amountToCollect")}</p>
              <p className="text-[15pt] font-bold leading-none tabular-nums">
                {vm.payment.collectFormatted}
              </p>
            </div>
          )}
          {vm.delivery ? (
            <p className="mt-[1.5mm] text-[7pt] text-neutral-700">
              {vm.delivery.providerName}
              {vm.delivery.trackingNumber ? ` · ${vm.delivery.trackingNumber}` : ""}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-[1mm]">
          <div className="size-[24mm]" dangerouslySetInnerHTML={{ __html: vm.qr.svg }} />
          {vm.code128 ? (
            <div className="h-[10mm] w-[24mm]">
              <div className="h-full w-full" dangerouslySetInnerHTML={{ __html: vm.code128.svg }} />
            </div>
          ) : null}
        </div>
      </div>

      {/* Human-readable parcel code + print timestamp */}
      <div className="flex items-baseline justify-between gap-[2mm] border-t border-black pt-[1mm]">
        {vm.parcelCode ? (
          <p className="min-w-0 truncate text-[7pt] font-mono tabular-nums">{vm.parcelCode}</p>
        ) : (
          <span />
        )}
        <p className="shrink-0 text-[6pt] text-neutral-500 tabular-nums">{vm.printTimestamp}</p>
      </div>
    </div>
  );
}
