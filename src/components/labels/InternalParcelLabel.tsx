import { useTranslation } from "react-i18next";
import type { InternalParcelLabelViewModel } from "@/lib/labels/internal-parcel-label";

/**
 * One 100×150 mm INTERNAL APSA Parcel label (CORRECTION-003) — the order's
 * warehouse identity for packing, shelf lookup, handoff and returns. Not a
 * shipping label: no carrier, no tracking, no customer data. Its QR and Code
 * 128 both encode the same APSA parcel code; the courier never scans them.
 *
 * Pure black-on-white for any printer, like the shipping label. Status is
 * carried by words, never colour alone.
 */
export function InternalParcelLabel({ vm }: { vm: InternalParcelLabelViewModel }) {
  const { t } = useTranslation();

  return (
    <div
      data-testid="internal-parcel-label"
      className="flex h-full w-full flex-col gap-[2mm] overflow-hidden bg-white p-[4mm] text-black"
    >
      <header className="shrink-0 border-b-[0.4mm] border-black pb-[1.5mm]">
        <p className="line-clamp-2 break-words text-[11pt] font-bold leading-tight">
          {vm.merchantName}
        </p>
        <p className="text-[12pt] font-bold leading-tight">{t("labels.internal.title")}</p>
        <p className="text-[8pt] leading-tight">{t("labels.internal.notShipping")}</p>
      </header>

      {vm.qr ? (
        <div
          data-testid="internal-parcel-label-qr"
          className="mx-auto size-[60mm] shrink-0 [&>svg]:h-full [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: vm.qr.svg }}
        />
      ) : (
        <div className="mx-auto flex size-[60mm] shrink-0 items-center justify-center border-[0.3mm] border-dashed border-black p-[2mm] text-center text-[9pt]">
          {t("labels.internal.noCode")}
        </div>
      )}

      {vm.code128 ? (
        <section className="shrink-0" data-testid="internal-parcel-label-code128">
          <div className="h-[16mm] w-full" dangerouslySetInnerHTML={{ __html: vm.code128.svg }} />
        </section>
      ) : null}

      <section className="shrink-0 text-center">
        <p className="text-[7pt] font-semibold leading-tight">{t("labels.internal.parcelId")}</p>
        <p
          data-testid="internal-parcel-label-code"
          className="break-all font-mono text-[10pt] font-bold leading-tight"
        >
          {vm.parcelCode ?? "—"}
        </p>
      </section>

      <section className="flex min-h-0 flex-1 items-end justify-between gap-[2mm] border-t-[0.3mm] border-black pt-[1mm] text-[9pt] leading-tight">
        <div className="min-w-0">
          <p className="text-[7pt] font-semibold">{t("labels.parcel.order")}</p>
          <p className="break-all text-[13pt] font-bold tabular-nums">{vm.orderNumber}</p>
          <p>{t("labels.parcel.items", { count: vm.itemCount })}</p>
        </div>
        <p className="shrink-0 text-[7.5pt] tabular-nums">{vm.printedAt}</p>
      </section>
    </div>
  );
}
