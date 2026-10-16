import type {
  BusinessBillingState,
  BusinessBillingSummary,
} from "@mocha-house/contracts";

// SC3b — the business's own CENTERIVO subscription billing (pure helpers:
// labels, messages and the Checkout redirect allow-list).

export const BILLING_STATE_LABELS: Record<BusinessBillingState, string> = {
  COMPLIMENTARY: "Complimentary",
  AWAITING_SETUP: "Payment setup needed",
  TRIALING: "Free trial",
  ACTIVE: "Active",
  PAST_DUE: "Payment overdue",
  UNPAID: "Unpaid",
  TRIAL_EXPIRED: "Trial ended",
  CANCELED: "Ended",
};

// What the state means for the owner, in one sentence.
export function billingStateDescription(billing: BusinessBillingSummary): string {
  switch (billing.state) {
    case "COMPLIMENTARY":
      return "Your CENTERIVO plan is complimentary. There is nothing to pay.";
    case "AWAITING_SETUP":
      return "Your CENTERIVO subscription is ready. Nothing is charged until you set up payment, and if a free trial is offered it starts first.";
    case "TRIALING":
      return billing.paymentMethodOnFile
        ? "You're on a free trial. Your saved payment method is charged when it ends."
        : "You're on a free trial. Nothing is charged; add a payment method before it ends to keep your subscription.";
    case "ACTIVE":
      return billing.cancelAtPeriodEnd
        ? "Your subscription is active and ends at the close of the current period."
        : "Your subscription is active.";
    case "PAST_DUE":
      return "Your last payment didn't go through. Everything keeps working while it is retried.";
    case "UNPAID":
      return "Your subscription is unpaid. Update your payment to continue.";
    case "TRIAL_EXPIRED":
      return "Your free trial ended without a payment method. Nothing was charged.";
    case "CANCELED":
      return "Your subscription has ended. Your data is kept.";
  }
}

export const BILLING_MESSAGES = {
  unavailable: "Payment setup isn't available right now. Nothing was changed. Try again in a moment.",
  notBilled: "There's no subscription payment to set up for this business.",
  alreadySetUp: "Payment is already set up. This page will show the latest status.",
  inProgress: "Payment setup is already being prepared. Try again in a moment.",
  processing: "We're confirming your payment setup. Refresh this page in a minute — you don't need to set it up again.",
  forbidden: "Only the business owner can set up payment.",
  sessionEnded: "Your session has ended. Sign in again to continue.",
  tooMany: "Too many attempts. Wait a few minutes, then try again.",
} as const;

const CONFLICTS: Record<string, string> = {
  BILLING_NOT_BILLED: BILLING_MESSAGES.notBilled,
  BILLING_ALREADY_SET_UP: BILLING_MESSAGES.alreadySetUp,
  BILLING_CHECKOUT_IN_PROGRESS: BILLING_MESSAGES.inProgress,
  BILLING_CHECKOUT_PROCESSING: BILLING_MESSAGES.processing,
};

// The message for a refused "open Checkout" answer (never a server detail).
export function checkoutRefusalMessage(status: number | null, body: unknown): string {
  if (status === 401) return BILLING_MESSAGES.sessionEnded;
  if (status === 403) return BILLING_MESSAGES.forbidden;
  if (status === 429) return BILLING_MESSAGES.tooMany;
  if (status === 409) {
    const code =
      typeof body === "object" && body !== null
        ? (body as { code?: unknown }).code
        : undefined;
    if (typeof code === "string" && code in CONFLICTS) return CONFLICTS[code];
  }
  return BILLING_MESSAGES.unavailable;
}

// Only the billing provider's own hosted Checkout may be redirected to (a
// value from our API, still checked: never an open redirect). The fake
// provider's page only outside production.
export function isAllowedCheckoutUrl(
  value: unknown,
  env: Record<string, string | undefined> = process.env,
): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:" && url.hostname === "checkout.stripe.com") {
    return true;
  }
  return (
    env.NODE_ENV !== "production" &&
    url.protocol === "https:" &&
    url.hostname === "checkout.fake.test"
  );
}

export type CheckoutReturn = "success" | "cancelled" | null;

export function checkoutReturn(value: unknown): CheckoutReturn {
  return value === "success" || value === "cancelled" ? value : null;
}
