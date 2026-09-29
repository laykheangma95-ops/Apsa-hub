import { Package } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ProductImageProps {
  /** Signed display URL from the server; absent/null renders the fallback. */
  src?: string | null | undefined;
  /**
   * Decorative by default: the product name is always rendered next to the
   * image, and identity is the product/variant id, never the picture.
   */
  alt?: string;
  /** Fixed square edge (Tailwind size class) — reserves space, so no layout shift. */
  className?: string;
  /** Replaces the default APSA placeholder (e.g. POS keeps its colour tile). */
  fallback?: ReactNode;
  /** Above-the-fold images should not be lazy. */
  eager?: boolean;
}

/**
 * Square product thumbnail with a clean fallback.
 *
 * - Fixed box + object-cover: no layout shift, no tall rows, aspect ratio kept
 *   by cropping to the centre rather than stretching.
 * - loading="lazy" + decoding="async": list rows below the fold cost nothing.
 * - A missing URL, an expired signed URL, a 404 or a corrupt file all land on
 *   the same fallback — never a broken-image icon, never an error that could
 *   get in the way of selling or ordering.
 */
export function ProductImage({ src, alt = "", className, fallback, eager }: ProductImageProps) {
  const [failed, setFailed] = useState(false);

  // A new URL (replace, refetch after expiry) deserves a fresh attempt.
  useEffect(() => {
    setFailed(false);
  }, [src]);

  const showImage = Boolean(src) && !failed;

  if (!showImage) {
    return (
      <span
        aria-hidden
        data-product-image="fallback"
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-secondary text-text-muted",
          className,
        )}
      >
        {fallback ?? <Package className="size-1/2" aria-hidden />}
      </span>
    );
  }

  return (
    <span
      data-product-image="photo"
      className={cn("block shrink-0 overflow-hidden rounded-xl bg-surface-secondary", className)}
    >
      <img
        src={src as string}
        alt={alt}
        {...(alt === "" ? { "aria-hidden": true } : {})}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        draggable={false}
        onError={() => setFailed(true)}
        className="size-full object-cover"
      />
    </span>
  );
}
