/**
 * §4 / §5: extracted variant text is only meaningful once it is matched against
 * the merchant's real catalog. This module maps candidate items onto products
 * without ever guessing: an ambiguous match returns candidates, not a decision.
 */
import { normalizeMessage } from "./normalize";
import { scan } from "./scan";
import type { LineItemCandidate } from "./types";
import type { Product } from "@/types";

export interface CatalogAttributes {
  color?: string;
  size?: string;
}

/** Map a catalog option value ("ខ្មៅ", "Black", "Size M") onto canonical slugs. */
export function catalogAttributes(value: string): CatalogAttributes {
  const tokens = scan(normalizeMessage(value));
  const color = tokens.find((token) => token.kinds.includes("color"))?.value;
  const size = tokens.find((token) => token.kinds.includes("size"))?.value;
  return {
    ...(typeof color === "string" ? { color } : {}),
    ...(size !== undefined ? { size: String(size) } : {}),
  };
}

export interface ResolvedItem {
  item: LineItemCandidate;
  /** set only when exactly one catalog product matches every stated attribute */
  productId?: string;
  /** every product that matches, when the message is not specific enough */
  candidateProductIds: string[];
  /** attributes the catalog has no value for */
  unmatchedAttributes: string[];
}

function productAttributes(product: Product): CatalogAttributes[] {
  const values = (product.options ?? []).flatMap((option) => option.values);
  return values.map(catalogAttributes);
}

function productHas(product: Product, key: keyof CatalogAttributes, value: string): boolean {
  return productAttributes(product).some((attributes) => attributes[key] === value);
}

/**
 * Match candidate line items against a catalog.
 *
 * A product qualifies only when it carries every attribute the customer stated.
 * When several products qualify, `productId` stays undefined — the caller must
 * ask the customer (or the merchant) rather than pre-filling an order.
 */
export function resolveAgainstCatalog(
  items: LineItemCandidate[],
  products: Product[],
): ResolvedItem[] {
  return items.map((item) => {
    const stated: Array<[keyof CatalogAttributes, string]> = [];
    if (item.color) stated.push(["color", item.color]);
    if (item.size) stated.push(["size", item.size]);

    if (stated.length === 0) {
      return { item, candidateProductIds: [], unmatchedAttributes: [] };
    }

    const matches = products.filter((product) =>
      stated.every(([key, value]) => productHas(product, key, value)),
    );

    const unmatchedAttributes = stated
      .filter(([key, value]) => !products.some((product) => productHas(product, key, value)))
      .map(([, value]) => value);

    const candidateProductIds = matches.map((product) => product.id);
    return {
      item,
      ...(candidateProductIds.length === 1 && candidateProductIds[0] !== undefined
        ? { productId: candidateProductIds[0] }
        : {}),
      candidateProductIds,
      unmatchedAttributes,
    };
  });
}
