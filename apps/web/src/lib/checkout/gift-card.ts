// Milestone 7G — the ONE place the checkout gift-card field is normalized
// before it is sent to the server. The server (GiftCardRedemptionService)
// canonicalizes (trim + upper-case + strip separators) and HMAC-hashes the
// code authoritatively; this helper only shapes the field so the quote and
// the checkout submission agree, and so an empty field is sent as `null`
// rather than an empty string. The plaintext code is only ever sent in a
// POST body — never a URL, query string, redirect, localStorage, order
// record, analytics or logs.

// The gift-card field value to send on the checkout request / quote:
// trimmed + upper-cased, or `null` when the customer has not applied one.
export function normalizeGiftCardCodeInput(raw: string): string | null {
  const trimmed = raw.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

// The masked identity for a redeemed gift card — the ONLY representation the
// UI ever shows: "Gift Card •••• 4821".
export function maskedGiftCardLabel(last4: string): string {
  return `Gift Card •••• ${last4}`;
}
