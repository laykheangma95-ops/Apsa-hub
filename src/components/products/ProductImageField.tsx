import { Camera, ImagePlus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ProductImage } from "@/components/products/ProductImage";
import { notifySuccess } from "@/lib/feedback";
import { PRODUCT_IMAGE_ACCEPT } from "@/lib/product-image";
import {
  classifyProductImageError,
  prepareImageForUpload,
  productImageErrorKey,
  removeProductImage,
  uploadProductImage,
  type PreparedImage,
} from "@/lib/product-image-client";
import type { ProductImageErrorKind } from "@/lib/product-image";

interface ProductImageFieldProps {
  /** Current photo (signed URL) of an existing product; null when none. */
  imageUrl: string | null;
  /**
   * Whether this member may change the photo. Presentation only: the server
   * re-checks products.update_basic on every request, so a hidden or shown
   * button never decides access.
   */
  canEdit: boolean;
  /**
   * Existing product → uploads/removes immediately.
   * Omitted (create flow) → the picked photo is held and handed to
   * onPendingChange; the create sheet uploads it once the product exists.
   */
  productId?: string | undefined;
  /** Called after a successful upload/remove on an existing product. */
  onChanged?: (() => void) | undefined;
  onPendingChange?: ((prepared: PreparedImage | null) => void) | undefined;
  disabled?: boolean | undefined;
}

type Busy = "preparing" | "uploading" | "removing" | null;

const RETRYABLE: ReadonlySet<ProductImageErrorKind> = new Set([
  "upload_failed",
  "network",
  "save_failed",
  "remove_failed",
]);

export function ProductImageField({
  imageUrl,
  canEdit,
  productId,
  onChanged,
  onPendingChange,
  disabled,
}: ProductImageFieldProps) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  // A ref, not state: a second tap in the same frame must not start a second upload.
  const inFlight = useRef(false);

  const [busy, setBusy] = useState<Busy>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<ProductImageErrorKind | null>(null);
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const [pending, setPending] = useState<PreparedImage | null>(null);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!pending) {
      setPendingUrl(null);
      return;
    }
    const url = URL.createObjectURL(pending.blob);
    setPendingUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pending]);

  useEffect(() => {
    return () => {
      if (uploadPreviewUrl) URL.revokeObjectURL(uploadPreviewUrl);
    };
  }, [uploadPreviewUrl]);

  const isDeferred = productId === undefined;
  const locked = Boolean(disabled) || busy !== null;
  const shownUrl = pendingUrl ?? uploadPreviewUrl ?? imageUrl;
  const hasPhoto = Boolean(shownUrl);

  function fail(err: unknown, again: () => void) {
    const kind = classifyProductImageError(err);
    setError(kind);
    setRetry(RETRYABLE.has(kind) ? () => again : null);
  }

  async function send(prepared: PreparedImage, fileName: string | undefined) {
    if (!productId) return;
    inFlight.current = true;
    setError(null);
    setRetry(null);
    setProgress(0);
    setBusy("uploading");
    setUploadPreviewUrl(URL.createObjectURL(prepared.blob));
    try {
      await uploadProductImage(productId, prepared, fileName, { onProgress: setProgress });
      setUploadPreviewUrl(null);
      notifySuccess(t("catalog.image.uploaded"));
      onChanged?.();
    } catch (err) {
      // The existing photo is untouched by a failed replace; show it again.
      setUploadPreviewUrl(null);
      fail(err, () => void send(prepared, fileName));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function onPicked(file: File | undefined) {
    if (!file || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setRetry(null);
    setBusy("preparing");
    try {
      const prepared = await prepareImageForUpload(file);
      inFlight.current = false;
      if (isDeferred) {
        setPending(prepared);
        onPendingChange?.(prepared);
        setBusy(null);
      } else {
        await send(prepared, file.name);
      }
    } catch (err) {
      inFlight.current = false;
      setBusy(null);
      fail(err, () => undefined);
      setRetry(null);
    }
  }

  async function remove() {
    if (inFlight.current) return;
    if (isDeferred) {
      setPending(null);
      onPendingChange?.(null);
      setError(null);
      return;
    }
    inFlight.current = true;
    setError(null);
    setRetry(null);
    setBusy("removing");
    try {
      await removeProductImage(productId);
      notifySuccess(t("catalog.image.removed"));
      onChanged?.();
    } catch (err) {
      fail(err, () => void remove());
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  function pick(input: React.RefObject<HTMLInputElement | null>) {
    // Clearing first lets the same file be picked again after a failure.
    if (input.current) input.current.value = "";
    input.current?.click();
  }

  const percent = Math.round(progress * 100);
  const status =
    busy === "preparing"
      ? t("catalog.image.preparing")
      : busy === "uploading"
        ? t("catalog.image.uploading", { percent })
        : busy === "removing"
          ? t("catalog.image.removing")
          : null;

  return (
    <div className="flex flex-col gap-3" data-product-image-field>
      <div className="flex items-start gap-3">
        <ProductImage src={shownUrl} className="size-24" eager />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {canEdit ? (
            <>
              <Button
                type="button"
                variant="outline"
                className="tap-target h-11 w-full justify-start gap-2"
                disabled={locked}
                onClick={() => pick(fileInput)}
              >
                <ImagePlus className="size-4 shrink-0" aria-hidden />
                <span className="chip-text min-w-0 truncate">
                  {hasPhoto ? t("catalog.image.replace") : t("catalog.image.choose")}
                </span>
              </Button>
              <Button
                type="button"
                variant="outline"
                className="tap-target h-11 w-full justify-start gap-2"
                disabled={locked}
                onClick={() => pick(cameraInput)}
              >
                <Camera className="size-4 shrink-0" aria-hidden />
                <span className="chip-text min-w-0 truncate">{t("catalog.image.take")}</span>
              </Button>
              {hasPhoto && !(busy === "uploading") ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="tap-target h-11 w-full justify-start gap-2 text-status-danger-text"
                  disabled={locked}
                  onClick={() => void remove()}
                >
                  <Trash2 className="size-4 shrink-0" aria-hidden />
                  <span className="chip-text min-w-0 truncate">{t("catalog.image.remove")}</span>
                </Button>
              ) : null}
            </>
          ) : (
            <p className="text-caption text-text-secondary">
              {hasPhoto ? null : t("catalog.image.none")}
            </p>
          )}
        </div>
      </div>

      {canEdit ? (
        <>
          <input
            ref={fileInput}
            type="file"
            accept={PRODUCT_IMAGE_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-label={t("catalog.image.choose")}
            onChange={(event) => void onPicked(event.target.files?.[0])}
          />
          <input
            ref={cameraInput}
            type="file"
            accept={PRODUCT_IMAGE_ACCEPT}
            capture="environment"
            className="sr-only"
            tabIndex={-1}
            aria-label={t("catalog.image.take")}
            onChange={(event) => void onPicked(event.target.files?.[0])}
          />
          <p className="text-caption text-text-secondary">
            {isDeferred ? t("catalog.image.pendingNote") : t("catalog.image.hint")}
          </p>
        </>
      ) : null}

      {status ? (
        <div role="status" className="flex flex-col gap-1.5">
          <span className="text-caption text-text-secondary">{status}</span>
          {busy === "uploading" ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-surface-secondary"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div
                className="h-full bg-action-primary transition-[width]"
                style={{ width: `${percent}%` }}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="flex flex-col items-start gap-2" role="alert">
          <p className="text-caption text-status-danger-text">{t(productImageErrorKey(error))}</p>
          {retry ? (
            <Button
              type="button"
              variant="outline"
              className="tap-target h-11 gap-2"
              disabled={locked}
              onClick={retry}
            >
              <RefreshCw className="size-4 shrink-0" aria-hidden />
              <span className="chip-text">{t("catalog.image.retry")}</span>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
