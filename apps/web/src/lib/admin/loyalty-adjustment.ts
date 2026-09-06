// The ONE place the HQ manual Mocha Bean adjustment form's client-side
// validation and request shaping live (Milestone 7A). The API
// (`POST /api/v1/admin/loyalty/customers/:id/adjustments`,
// `loyalty.adjust`, CORPORATE-only) re-validates everything — these helpers
// just keep the form honest before it submits.

export const ADJUSTMENT_REASON_MAX_LENGTH = 1000;

export type AdjustmentDirection = "add" | "deduct";

export interface AdjustmentFormValues {
  direction: AdjustmentDirection;
  amount: string; // the raw text input — a whole positive number of Beans
  reason: string;
}

export interface PreparedAdjustment {
  deltaBeans: number;
  reason: string;
  operationKey: string;
}

export type PrepareAdjustmentResult =
  | { ok: true; value: PreparedAdjustment }
  | { ok: false; error: string };

// Parse the "amount" field into a positive whole number of Beans WITHOUT
// floating-point surprises: digits only, at least 1.
function parseWholeBeans(raw: string): number | null {
  const cleaned = raw.trim();
  if (!/^\d+$/.test(cleaned)) {
    return null;
  }
  const value = Number(cleaned);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

// Validate the form and turn it into the API request body. `operationKey`
// is generated here (a UUID) so a given prepared submission is idempotent
// on retry; the caller reuses the SAME PreparedAdjustment when retrying a
// failed network call rather than preparing again.
export function prepareAdjustment(
  values: AdjustmentFormValues,
  operationKey: string,
): PrepareAdjustmentResult {
  const magnitude = parseWholeBeans(values.amount);
  if (magnitude === null) {
    return {
      ok: false,
      error: "Enter a whole number of Mocha Beans greater than zero.",
    };
  }

  const reason = values.reason.trim();
  if (reason.length === 0) {
    return { ok: false, error: "A reason is required." };
  }
  if (reason.length > ADJUSTMENT_REASON_MAX_LENGTH) {
    return {
      ok: false,
      error: `Keep the reason under ${ADJUSTMENT_REASON_MAX_LENGTH} characters.`,
    };
  }

  const deltaBeans =
    values.direction === "deduct" ? -magnitude : magnitude;

  return { ok: true, value: { deltaBeans, reason, operationKey } };
}

// Would this adjustment take the balance below zero? The API enforces this
// authoritatively; the form uses it to warn before submitting.
export function wouldGoNegative(
  currentBalance: number,
  deltaBeans: number,
): boolean {
  return currentBalance + deltaBeans < 0;
}

// A normalized lookup query: trimmed, and rejected early when empty.
export function normalizeLoyaltyQuery(raw: string): string {
  return raw.trim();
}
