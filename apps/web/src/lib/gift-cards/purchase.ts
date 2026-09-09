import type { GiftCardPurchaseOptions } from "@mocha-house/contracts";

// Milestone 7H — the pure client-side helpers for the customer gift-card
// purchase + balance-lookup page. No network, no React: amount validation
// that mirrors the server's rule (a preset OR, when enabled, a custom
// amount within the fixed bounds), code normalization, and the display
// grouping. The server (GiftCardPurchaseService / GiftCardBalanceService)
// re-validates everything authoritatively — these only keep the form honest
// and the two round-trips agreeing.
//
// The full gift-card code is only ever sent in a POST body and shown once
// on the success screen — never a URL, query string, redirect, localStorage,
// or analytics. These helpers never persist it.

export type CustomAmountParse =
  | { ok: true; minorUnits: number }
  | { ok: false; error: string };

// Parse the customer's custom-amount entry (dollars) into integer minor
// units WITHOUT floating-point multiplication, then bound-check it against
// the HQ-configured window. Empty / malformed / out-of-range all return a
// friendly error rather than a value.
export function parseCustomAmount(
  raw: string,
  options: Pick<
    GiftCardPurchaseOptions,
    "customAmountMinMinorUnits" | "customAmountMaxMinorUnits"
  >,
): CustomAmountParse {
  const cleaned = raw.trim().replace(/^\$/, "").trim();
  if (cleaned === "") {
    return { ok: false, error: "Enter an amount." };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return { ok: false, error: "Enter an amount like 25 or 25.00." };
  }
  const [whole, fraction = ""] = cleaned.split(".");
  const minorUnits = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (minorUnits < options.customAmountMinMinorUnits) {
    return {
      ok: false,
      error: `The lowest gift-card amount is ${formatMinorUnits(
        options.customAmountMinMinorUnits,
      )}.`,
    };
  }
  if (minorUnits > options.customAmountMaxMinorUnits) {
    return {
      ok: false,
      error: `The highest custom amount is ${formatMinorUnits(
        options.customAmountMaxMinorUnits,
      )}.`,
    };
  }
  return { ok: true, minorUnits };
}

// True when `minorUnits` is a purchasable amount for these options: it
// matches a preset exactly, OR custom amounts are enabled and it falls
// within [min, max]. Mirrors GiftCardPurchaseService.validateAmount.
export function isPurchasableAmount(
  minorUnits: number,
  options: GiftCardPurchaseOptions,
): boolean {
  if (!Number.isInteger(minorUnits) || minorUnits <= 0) {
    return false;
  }
  if (options.presetAmountsMinorUnits.includes(minorUnits)) {
    return true;
  }
  return (
    options.customAmountEnabled &&
    minorUnits >= options.customAmountMinMinorUnits &&
    minorUnits <= options.customAmountMaxMinorUnits
  );
}

// The gift-card code to submit for a balance lookup: trimmed + upper-cased,
// or null when the field is empty. The server canonicalizes authoritatively
// (it also strips separators); this only shapes the field and avoids a
// pointless request for an empty box.
export function normalizeBalanceCode(raw: string): string | null {
  const trimmed = raw.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

// Group a code into 4-character blocks for display ("XXXX XXXX XXXX XXXX").
// Accepts a code with or without existing separators.
export function groupGiftCardCode(code: string): string {
  const compact = code.replace(/[\s-]+/g, "").toUpperCase();
  return (compact.match(/.{1,4}/g) ?? [compact]).join(" ");
}

// The masked identity the UI shows for a looked-up or purchased card — the
// only representation shown after the one-time full-code reveal.
export function maskedGiftCardLabel(last4: string): string {
  return `•••• •••• •••• ${last4}`;
}

// Minor units -> a plain "$25.00" string (USD only in 7H). Kept here so the
// pure helpers have no dependency on the app's formatPrice.
export function formatMinorUnits(minorUnits: number): string {
  return `$${(minorUnits / 100).toFixed(2)}`;
}

export const CODE_RETRIEVAL_NOTICE =
  "Save this code now. For your security we can only show it again for 7 days, " +
  "and only to you — after that you'll see the confirmation but not the code.";
