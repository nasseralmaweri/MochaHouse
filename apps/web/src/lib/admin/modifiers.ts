import {
  MODIFIER_MAX_PRICE_ADJUSTMENT_MINOR_UNITS,
  MODIFIER_MAX_SELECTIONS_LIMIT,
} from "@mocha-house/contracts";
import { formatPrice, parseDollarInput } from "@/lib/money";

// Product Modifier Management — Admin wording and form parsing. The API
// re-checks every rule; these only give the admin an immediate, plain
// answer. Admins work in dollars; amounts reach the API as integer cents.

// "Required · choose 1", "Optional · up to 3", "Required · choose 2–4".
export function selectionRuleLabel(
  minSelections: number,
  maxSelections: number | null,
): string {
  const required = minSelections >= 1;
  const prefix = required ? "Required" : "Optional";
  if (maxSelections === null) {
    return required
      ? `${prefix} · choose at least ${minSelections}`
      : `${prefix} · choose any number`;
  }
  if (!required) {
    return `${prefix} · choose up to ${maxSelections}`;
  }
  return minSelections === maxSelections
    ? `${prefix} · choose ${minSelections}`
    : `${prefix} · choose ${minSelections}–${maxSelections}`;
}

// "+$0.50", or "No extra charge".
export function priceAdjustmentLabel(cents: number, currency = "USD"): string {
  return cents === 0 ? "No extra charge" : `+${formatPrice(cents, currency)}`;
}

// The sentence every shared-group screen shows.
export function sharedGroupNotice(productCount: number): string {
  if (productCount === 0) {
    return "Not on any product yet.";
  }
  return productCount === 1
    ? "Used by 1 product. Changes here apply to it."
    : `Used by ${productCount} products. Changes here apply to all of them.`;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

// An option's extra charge in dollars: blank means none.
export function parsePriceAdjustmentInput(raw: string): ParseResult<number> {
  const parsed = parseDollarInput(raw);
  const max = MODIFIER_MAX_PRICE_ADJUSTMENT_MINOR_UNITS;
  const range = `Enter an extra charge from $0.00 to ${formatPrice(max, "USD")}, or leave it blank.`;
  if (!parsed.ok) {
    return { ok: false, error: range };
  }
  const cents = parsed.cents ?? 0;
  if (cents > max) {
    return { ok: false, error: range };
  }
  return { ok: true, value: cents };
}

// The group's selection settings, as the API's rules: minimum 0–20;
// maximum none, or from max(minimum, 1) to 20. "Required" follows from a
// minimum of 1 or more.
export function parseSelectionInputs(
  minRaw: string,
  maxRaw: string,
  noLimit: boolean,
): ParseResult<{ minSelections: number; maxSelections: number | null }> {
  const limit = MODIFIER_MAX_SELECTIONS_LIMIT;
  const minSelections = wholeNumber(minRaw);
  if (minSelections === null || minSelections > limit) {
    return {
      ok: false,
      error: `Enter a minimum from 0 to ${limit}.`,
    };
  }
  if (noLimit) {
    return { ok: true, value: { minSelections, maxSelections: null } };
  }
  const maxSelections = wholeNumber(maxRaw);
  const lowest = Math.max(minSelections, 1);
  if (maxSelections === null || maxSelections < lowest || maxSelections > limit) {
    return {
      ok: false,
      error: `Enter a maximum from ${lowest} to ${limit}, or choose "No limit".`,
    };
  }
  return { ok: true, value: { minSelections, maxSelections } };
}

function wholeNumber(raw: string): number | null {
  const trimmed = raw.trim();
  return /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : null;
}

// The list with the item at `index` moved one place up (-1) or down (+1);
// unchanged when it is already at that end.
export function moveItem<T>(items: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) {
    return [...items];
  }
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
