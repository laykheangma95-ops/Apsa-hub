import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
// Direct module, not the barrel: the barrel re-exports BottomNav, whose Apsi
// console renders this sheet — importing the barrel here would be a cycle.
import { BottomSheet } from "@/design-system/BottomSheet";
import { useCameraBarcodeScanner } from "@/hooks/use-camera-barcode-scanner";
import { normalizeScannedCode, type CameraScanStatus } from "@/lib/barcode/camera-scan";
import { cn } from "@/lib/utils";

/**
 * Scan a barcode with the phone camera, or type it.
 *
 * A capability surface, not a domain owner: it produces one barcode string and
 * hands it to `onCode`. What that code means (add to cart, open a stock page)
 * is the caller's, resolved through the org-scoped server lookup. The typed
 * field is always present, so a blocked, missing or unsupported camera never
 * blocks the sale.
 */
export function CameraScanSheet({
  open,
  onOpenChange,
  onCode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCode: (code: string) => void;
}) {
  const { t } = useTranslation();
  const [manual, setManual] = useState("");

  const finish = (code: string) => {
    setManual("");
    onOpenChange(false);
    onCode(code);
  };

  const { status, videoRef, retry } = useCameraBarcodeScanner({ active: open, onDetected: finish });

  const submitManual = (event: FormEvent) => {
    event.preventDefault();
    const code = normalizeScannedCode(manual);
    if (code !== null) finish(code);
  };

  const showVideo = status.kind === "starting" || status.kind === "scanning";
  const canRetry = status.kind === "failed" || status.kind === "paused";

  return (
    <BottomSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setManual("");
        onOpenChange(next);
      }}
      title={t("barcodeScanner.title")}
      description={t("barcodeScanner.hint")}
      snap="full"
    >
      <div
        className={cn(
          "relative aspect-[4/3] w-full overflow-hidden rounded-2xl bg-surface-secondary",
          !showVideo && "hidden",
        )}
      >
        {/* playsInline + muted: iOS Safari refuses inline camera video otherwise. */}
        <video
          ref={videoRef}
          className="size-full object-cover"
          playsInline
          muted
          autoPlay
          aria-hidden
        />
        {/* Aiming guide only; decoding reads the whole frame. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-8 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-action-primary"
        />
      </div>

      <p
        role="status"
        aria-live="polite"
        className={cn(
          "text-body-sm mt-3",
          status.kind === "failed" ? "text-status-warning-text" : "text-text-secondary",
        )}
      >
        {t(statusMessageKey(status))}
      </p>

      {canRetry ? (
        <Button
          type="button"
          variant="outline"
          className="tap-target mt-3 h-12 w-full"
          onClick={retry}
        >
          {t("barcodeScanner.retry")}
        </Button>
      ) : null}

      <form className="mt-5 flex flex-col gap-1.5" onSubmit={submitManual}>
        <Label htmlFor="camera-scan-manual" className="text-label text-text-secondary">
          {t("barcodeScanner.manualLabel")}
        </Label>
        <div className="flex gap-2">
          <Input
            id="camera-scan-manual"
            className="h-12 min-w-0 flex-1"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            maxLength={100}
          />
          <Button
            type="submit"
            className="tap-target h-12 shrink-0"
            disabled={normalizeScannedCode(manual) === null}
          >
            {t("barcodeScanner.manualSubmit")}
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}

function statusMessageKey(status: CameraScanStatus): string {
  switch (status.kind) {
    case "idle":
    case "starting":
      return "barcodeScanner.starting";
    case "scanning":
    case "detected":
      return "barcodeScanner.scanning";
    case "paused":
      return "barcodeScanner.paused";
    case "failed":
      switch (status.reason) {
        case "denied":
          return "barcodeScanner.denied";
        case "no_camera":
          return "barcodeScanner.noCamera";
        case "busy":
          return "barcodeScanner.busy";
        case "unsupported":
          return "barcodeScanner.unsupported";
        case "error":
          return "barcodeScanner.error";
      }
  }
}
