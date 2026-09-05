/**
 * §16 Multi-item grouping.
 *
 * A single message can carry several line items ("black M 1, white L 1",
 * "យកខ្មៅមួយ សមួយ"). Items are split on explicit separators and on attribute
 * conflicts — a second colour, size, or quantity starts a new item — so two
 * variants are never flattened into quantity 2 of one variant.
 */
import type { IntentToken, LineItemCandidate } from "./types";

function isEmpty(item: LineItemCandidate): boolean {
  return item.color === undefined && item.size === undefined && item.quantity === undefined;
}

export function groupItems(tokens: IntentToken[]): LineItemCandidate[] {
  const items: LineItemCandidate[] = [];
  let current: LineItemCandidate = {};

  const flush = () => {
    if (!isEmpty(current)) items.push(current);
    current = {};
  };

  for (const token of tokens) {
    if (token.kinds.includes("separator")) {
      flush();
      continue;
    }

    if (token.kinds.includes("color") && typeof token.value === "string") {
      if (current.color !== undefined && current.color !== token.value) flush();
      current.color = token.value;
    }

    if (token.kinds.includes("size") && token.value !== undefined) {
      const size = String(token.value);
      if (current.size !== undefined && current.size !== size) flush();
      current.size = size;
    }

    if (token.kinds.includes("quantity") && typeof token.value === "number") {
      if (current.quantity !== undefined) flush();
      current.quantity = token.value;
    }

    if (token.kinds.includes("unit") && typeof token.value === "string") {
      current.unit ??= token.value;
    }
  }

  flush();
  return items;
}
