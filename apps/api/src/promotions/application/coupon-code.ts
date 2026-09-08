// The ONE place a coupon code is normalized (Milestone 7E). Case-insensitive
// resolution is achieved by storing and comparing the normalized (trimmed +
// upper-cased) form everywhere: "welcome10", "Welcome10" and "WELCOME10" all
// normalize to "WELCOME10", and Promotion.code has a plain @unique on that
// form. Returns null for a code that is empty, too short/long, or contains
// characters outside [A-Z0-9_-].
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;

export function normalizeCouponCode(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const normalized = raw.trim().toUpperCase();
  if (!CODE_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}
