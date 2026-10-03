import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ParcelLabelViewModel } from "@/lib/labels/parcel-label";

/**
 * One 100×150 mm parcel/shipping label (§13). Pure black-on-white: no greys,
 * tints or screen-only colours, so it prints the same on a thermal printer, a
 * mono laser or a colour inkjet (see ProductLabel for the design-token
 * exception). Contains exactly the fulfillment PII the view model carries (name,
 * phone, address) and never anything else (§14).
 *
 * Reading order, top to bottom, for a packer or courier at a glance:
 *   1. shop (logo + name + phone)   2–3. receiver + address
 *   4. carrier / tracking           5. items
 *   6. payment (COD / PAID / CHECK) 7. QR + Code 128 of the parcel identity
 *   8. order number + print time
 *
 * Text wraps (break-words) instead of truncating, so long Khmer or English names
 * are never clipped mid-glyph. Status is never colour-only: every payment state
 * is a word with its own border style (CLAUDE.md).
 */
export function ParcelLabel({ vm }: { vm: ParcelLabelViewModel }) {
  const { t } = useTranslation();
  const [logoFailed, setLogoFailed] = useState(false);
  const logo = vm.merchant.logoUrl && !logoFailed ? vm.merchant.logoUrl : null;

  return (
    <div
      data-testid="parcel-label"
      className="flex h-full w-full flex-col gap-[1.5mm] overflow-hidden bg-white p-[4mm] text-black"
    >
      {/*
       * Fixed vertical budget. The BOTTOM block (payment + QR, Code 128, footer)
       * is shrink-0 and always gets its full height; the TOP block takes only
       * what is left (flex-1 min-h-0) and clips inside itself. So no address,
       * name or item list can ever overlap the COD amount or push the codes or
       * footer off the 150 mm page. The address and item budgets in
       * buildParcelLabel keep the top block's content within that space.
       */}
      <div
        data-testid="parcel-label-top"
        className="flex min-h-0 flex-1 flex-col gap-[1.5mm] overflow-hidden"
      >
        {/* 1. Shop / sender */}
        <header className="flex shrink-0 items-center gap-[2mm] border-b-[0.4mm] border-black pb-[1.5mm]">
          {logo ? (
            <img
              src={logo}
              alt=""
              data-testid="parcel-label-logo"
              className="size-[11mm] shrink-0 object-contain"
              onError={() => setLogoFailed(true)}
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <p className="text-[7pt] font-semibold leading-tight">{t("labels.parcel.from")}</p>
            <p className="line-clamp-2 break-words text-[11pt] font-bold leading-tight">
              {vm.merchant.name}
            </p>
            {vm.merchant.phone ? (
              <p className="text-[9pt] leading-tight tabular-nums">
                {t("labels.parcel.phone")}: {vm.merchant.phone}
              </p>
            ) : null}
          </div>
          {/* Re-issue marker — a word, never colour alone (§19). */}
          {vm.reprint ? (
            <span className="shrink-0 border-[0.4mm] border-black px-[1.5mm] py-[0.5mm] text-[8pt] font-bold">
              {t("labels.parcel.reprint")}
            </span>
          ) : null}
        </header>

        {/* 2–3. Receiver + delivery address (order shipping snapshot only) */}
        <section className="shrink-0 border-b-[0.4mm] border-black pb-[1.5mm]">
          <p className="text-[7pt] font-semibold leading-tight">{t("labels.parcel.to")}</p>
          {vm.customer.name ? (
            <p className="line-clamp-2 break-words text-[15pt] font-bold leading-tight">
              {vm.customer.name}
            </p>
          ) : null}
          {vm.customer.phone ? (
            <p className="line-clamp-1 break-all text-[13pt] font-bold leading-tight tabular-nums">
              {vm.customer.phone}
            </p>
          ) : null}
          {vm.customer.address ? (
            <p
              data-testid="parcel-label-address"
              className={`mt-[0.5mm] overflow-hidden whitespace-pre-line break-words leading-snug ${
                vm.addressCompact ? "text-[9pt]" : "text-[10.5pt]"
              }`}
              // Clamp to the lines the vertical budget allotted (buildParcelLabel).
              style={{
                display: "-webkit-box",
                WebkitBoxOrient: "vertical",
                WebkitLineClamp: vm.addressLines,
              }}
            >
              {vm.customer.address}
            </p>
          ) : (
            <p className="text-[9pt] font-semibold leading-snug">{t("labels.parcel.noAddress")}</p>
          )}
          {vm.addressTruncated ? (
            <p
              data-testid="parcel-label-address-truncated"
              className="mt-[0.5mm] text-[7pt] font-bold leading-tight"
            >
              {t("labels.parcel.addressTruncated")}
            </p>
          ) : null}
          {!vm.customer.addressConfirmed ? (
            <p className="mt-[0.5mm] border-[0.3mm] border-black px-[1mm] py-[0.5mm] text-[7pt] font-bold leading-tight">
              ⚠ {t("labels.parcel.addressNotConfirmed")}
            </p>
          ) : null}
        </section>

        {/* 4. Carrier / tracking */}
        <section
          data-testid="parcel-label-carrier"
          className="shrink-0 border-b-[0.4mm] border-black pb-[1.5mm] text-[9pt] leading-tight"
        >
          {vm.delivery ? (
            <p className="line-clamp-2 break-words">
              <span className="font-semibold">{t("labels.parcel.carrier")}: </span>
              <span className="font-bold">{vm.delivery.carrierName}</span>
              {vm.delivery.serviceName ? <span> · {vm.delivery.serviceName}</span> : null}
              {vm.delivery.trackingNumber ? (
                <>
                  <span className="font-semibold"> · {t("labels.parcel.tracking")}: </span>
                  <span className="break-all font-mono font-bold">
                    {vm.delivery.trackingNumber}
                  </span>
                </>
              ) : null}
            </p>
          ) : (
            <p>
              <span className="font-semibold">{t("labels.parcel.carrier")}: </span>
              {t("labels.parcel.carrierNotAssigned")}
            </p>
          )}
        </section>

        {/* 5. Items */}
        <section
          data-testid="parcel-label-items"
          className="flex min-h-0 flex-1 flex-col overflow-hidden border-b-[0.4mm] border-black pb-[1.5mm]"
        >
          <p className="shrink-0 text-[8pt] font-semibold leading-tight">
            {t("labels.parcel.items", { count: vm.itemCount })}
          </p>
          <ul className="mt-[0.5mm] min-h-0 space-y-[0.4mm] overflow-hidden">
            {vm.items.map((line, i) => (
              <li key={i} className="line-clamp-2 break-words text-[9pt] leading-tight">
                <span className="font-bold tabular-nums">{line.quantity} ×</span>{" "}
                {line.productName.trim()}
                {line.variantName?.trim() ? ` — ${line.variantName.trim()}` : ""}
              </li>
            ))}
          </ul>
          {vm.overflowCount > 0 ? (
            <p
              data-testid="parcel-label-more-items"
              className="mt-[0.5mm] shrink-0 text-[8pt] font-semibold leading-tight"
            >
              {t("labels.parcel.moreItems", { count: vm.overflowCount })}
            </p>
          ) : null}
        </section>
      </div>

      <div data-testid="parcel-label-bottom" className="flex shrink-0 flex-col gap-[1.5mm]">
        {/* 6. Payment  +  7a. QR */}
        <section className="flex shrink-0 items-center gap-[3mm]">
          <div className="min-w-0 flex-1" data-testid="parcel-label-payment">
            {vm.payment.state === "cod" ? (
              <div className="border-[0.8mm] border-black px-[2mm] py-[1.5mm]">
                <p className="text-[10pt] font-bold leading-tight">
                  {t("labels.parcel.codToCollect")}
                </p>
                <p
                  data-testid="parcel-label-cod-amount"
                  className="break-all text-[22pt] font-bold leading-none tabular-nums"
                >
                  {vm.payment.collectFormatted}
                </p>
                {vm.payment.partial ? (
                  <p className="mt-[0.5mm] text-[7.5pt] leading-tight">
                    {t("labels.parcel.balanceDue")}
                  </p>
                ) : null}
              </div>
            ) : vm.payment.state === "paid" ? (
              <div>
                <p className="inline-block border-[0.5mm] border-black px-[2mm] py-[0.5mm] text-[11pt] font-bold">
                  ✓ {t("labels.parcel.paid")}
                </p>
                <p className="mt-[0.5mm] text-[8pt] leading-tight">
                  {t("labels.parcel.paidNoCollect")}
                </p>
              </div>
            ) : (
              <div className="border-[0.8mm] border-dashed border-black px-[2mm] py-[1.5mm]">
                <p className="text-[13pt] font-bold leading-tight">
                  ⚠ {t("labels.parcel.checkPayment")}
                </p>
                <p className="mt-[0.5mm] text-[8pt] leading-tight">
                  {t("labels.parcel.checkPaymentBody")}
                </p>
                {vm.payment.checkReason ? (
                  <p className="mt-[0.5mm] text-[7pt] leading-tight">
                    {t(`labels.parcel.checkReason.${vm.payment.checkReason}`)}
                  </p>
                ) : null}
              </div>
            )}
          </div>

          <div className="size-[30mm] shrink-0" data-testid="parcel-label-qr">
            {vm.qr ? (
              <div
                className="h-full w-full [&>svg]:h-full [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: vm.qr.svg }}
              />
            ) : (
              /*
               * "Not assigned yet" is only true before delivery is arranged —
               * arranging it generates the parcel identity. After that a missing
               * code is in flight, never "not assigned".
               */
              <div
                data-testid="parcel-label-codes-placeholder"
                className="flex h-full w-full flex-col items-center justify-center border-[0.3mm] border-dashed border-black p-[1.5mm] text-center text-[7pt]"
              >
                {vm.deliveryArranged ? (
                  t("labels.parcel.codesAssigning")
                ) : (
                  <>
                    <span>{t("labels.parcel.codesPending")}</span>
                    <span className="font-bold">{t("labels.parcel.arrangeFirst")}</span>
                  </>
                )}
              </div>
            )}
          </div>
        </section>

        {/* 7b. Code 128 — full label width so each module stays scannable. */}
        {vm.code128 ? (
          <section className="shrink-0" data-testid="parcel-label-code128">
            <div className="h-[12mm] w-full" dangerouslySetInnerHTML={{ __html: vm.code128.svg }} />
            <p className="mt-[0.5mm] break-all text-center font-mono text-[8pt] leading-tight">
              {vm.parcelCode}
            </p>
          </section>
        ) : null}

        {/* 8. Small references */}
        <footer
          data-testid="parcel-label-footer"
          className="flex shrink-0 items-baseline justify-between gap-[2mm] border-t-[0.3mm] border-black pt-[1mm] text-[7.5pt] leading-tight"
        >
          <p className="min-w-0 break-all">
            {t("labels.parcel.order")}:{" "}
            <span className="font-bold tabular-nums">{vm.orderNumber}</span>
          </p>
          <p className="shrink-0 tabular-nums">{vm.printedAt}</p>
        </footer>
      </div>
    </div>
  );
}
