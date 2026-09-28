import type { ProductLabelViewModel } from "@/lib/labels/product-label";

/**
 * One 50×30 mm product label (§6). Deliberately black-on-white with explicit
 * colours: a scanner needs true #000 bars on #fff, so this is the one place the
 * design-token rule yields to print fidelity. APSA branding stays extremely
 * restrained here (§6) — the label is an operational artifact, not marketing.
 *
 * SVGs are our own generated markup (rects only) — safe to inline.
 */
export function ProductLabel({ vm }: { vm: ProductLabelViewModel }) {
  return (
    <div className="flex h-full w-full flex-col justify-between p-[2mm] text-black">
      <div className="min-w-0">
        <p className="truncate text-[9pt] leading-tight font-semibold">{vm.productName}</p>
        {vm.variantName ? (
          <p className="truncate text-[7pt] leading-tight text-neutral-700">{vm.variantName}</p>
        ) : null}
      </div>

      <div className="flex items-end justify-between gap-[2mm]">
        <div className="min-w-0 flex-1">
          <p className="text-[10pt] leading-none font-bold tabular-nums">{vm.priceFormatted}</p>
          {vm.barcodeSvg ? (
            <div className="mt-[1mm]">
              <div
                className="h-[8mm] w-full"
                // Generated Code 128 SVG (rects only) — our own markup, never user HTML.
                dangerouslySetInnerHTML={{ __html: vm.barcodeSvg }}
              />
              {vm.barcode ? (
                <p className="mt-[0.5mm] text-center text-[6pt] leading-none tracking-wide tabular-nums">
                  {vm.barcode}
                </p>
              ) : null}
            </div>
          ) : null}
          {vm.sku && !vm.barcodeSvg ? (
            <p className="mt-[1mm] text-[6pt] leading-none tabular-nums">{vm.sku}</p>
          ) : null}
        </div>

        {vm.qr ? (
          <div
            className="size-[10mm] shrink-0"
            // Generated QR SVG (rects only) — our own markup, never user HTML.
            dangerouslySetInnerHTML={{ __html: vm.qr.svg }}
          />
        ) : null}
      </div>
    </div>
  );
}
