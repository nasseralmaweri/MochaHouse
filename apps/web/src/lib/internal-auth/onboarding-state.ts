import type {
  OwnerOnboardingPlanOption,
  OwnerOnboardingPlanPrice,
} from "@mocha-house/contracts";
import { TOO_MANY_ATTEMPTS_MESSAGE } from "@/lib/rate-limit-message";

// SC4b — the business creation form's state and wording. Pure (no fetch, no
// cookies) so it can be unit tested.

export interface CreateBusinessState {
  error: string | null;
}

export const INITIAL_CREATE_BUSINESS_STATE: CreateBusinessState = { error: null };

const UNREACHABLE =
  "Could not reach the server. Check your connection and try again.";
const UNAVAILABLE =
  "Creating a business isn't available right now. Please try again later.";

// What to tell the owner after a failed attempt. 409 messages come from the
// API (plan withdrawn or price changed: they must choose again).
export function createBusinessError(
  answer: { status: number; message: string | null } | null,
): string {
  if (answer === null) return UNREACHABLE;
  if (answer.status === 429) return TOO_MANY_ATTEMPTS_MESSAGE;
  if ((answer.status === 400 || answer.status === 409) && answer.message) {
    return answer.message;
  }
  if (answer.status === 401 || answer.status === 403) {
    return "Your session has ended. Sign in again to continue.";
  }
  return UNAVAILABLE;
}

// The choice as the form posts it — the plan version, the price AND the
// price as shown, so the request carries exactly what the owner SAW (the API
// refuses anything else; nothing is re-read and silently substituted).
export function priceChoiceValue(
  plan: OwnerOnboardingPlanOption,
  price: OwnerOnboardingPlanPrice,
): string {
  return [
    plan.planVersionId,
    price.planPriceId,
    price.interval,
    price.currency,
    String(price.amountMinorUnits),
  ].join(":");
}

export interface PriceChoice {
  planVersionId: string;
  planPriceId: string;
  expectedPrice: {
    interval: "MONTH" | "YEAR";
    currency: string;
    amountMinorUnits: number;
  };
}

export function parsePriceChoice(value: string): PriceChoice | null {
  const [planVersionId, planPriceId, interval, currency, amount, extra] =
    value.split(":");
  const amountMinorUnits = Number(amount);
  if (
    extra !== undefined ||
    !planVersionId ||
    !planPriceId ||
    (interval !== "MONTH" && interval !== "YEAR") ||
    !/^[A-Z]{3}$/.test(currency ?? "") ||
    !/^\d+$/.test(amount ?? "") ||
    !Number.isSafeInteger(amountMinorUnits)
  ) {
    return null;
  }
  return {
    planVersionId,
    planPriceId,
    expectedPrice: { interval, currency, amountMinorUnits },
  };
}

export function formatPlanPrice(price: OwnerOnboardingPlanPrice): string {
  const amount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: price.currency,
  }).format(price.amountMinorUnits / 100);
  return `${amount} / ${price.interval === "YEAR" ? "year" : "month"}`;
}

// Seconds the token is still valid, read from its own "exp" claim — only to
// size the session cookie (the API verifies the token on every request).
export function tokenLifetimeSeconds(token: string, nowMs = Date.now()): number {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { exp?: unknown };
    if (typeof payload.exp !== "number") return 0;
    return Math.max(0, Math.min(Math.floor(payload.exp - nowMs / 1000), 12 * 3600));
  } catch {
    return 0;
  }
}
