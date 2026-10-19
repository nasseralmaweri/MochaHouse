import type { PaymentAccountState } from "@mocha-house/contracts";

// ESP-04 M1 — Admin > Payments: the restaurant's OWN Stripe account for
// customer payments (never CENTERIVO's subscription billing). Pure helpers
// for the page; the API is the sole authority on who may see or change it.

export const PAYMENT_ACCOUNT_LABELS: Record<PaymentAccountState, string> = {
  NOT_CONNECTED: "Not connected",
  SETUP_IN_PROGRESS: "Setup in progress",
  UNDER_REVIEW: "Under review by Stripe",
  ACTION_REQUIRED: "Action required",
  READY: "Connected",
  NOT_SUPPORTED: "Not supported",
  CLOSED: "Closed",
  CONFIGURATION_MISMATCH: "Needs attention",
};

export function paymentAccountDescription(
  state: PaymentAccountState,
  requirementsDue: number,
): string {
  switch (state) {
    case "NOT_CONNECTED":
      return "Connect your restaurant's own Stripe account to receive your customers' payments directly. Stripe charges its processing fees to your account; CENTERIVO takes no transaction fee.";
    case "SETUP_IN_PROGRESS":
      return requirementsDue > 0
        ? `Stripe still needs ${requirementsDue === 1 ? "one item" : `${requirementsDue} items`} from you. Continue setup to finish.`
        : "Continue setup with Stripe to finish connecting your account.";
    case "UNDER_REVIEW":
      return "You've given Stripe what it asked for. Stripe is reviewing your account; check back soon.";
    case "ACTION_REQUIRED":
      return "Stripe needs more information before your account can take card payments. Continue setup to provide it.";
    case "READY":
      return "Your Stripe account can take card payments. Online customer payments are not switched on yet.";
    case "NOT_SUPPORTED":
      return "Stripe can't offer card payments to this account. Check your Stripe Dashboard or contact CENTERIVO support.";
    case "CLOSED":
      return "This Stripe account was closed. Contact CENTERIVO support.";
    case "CONFIGURATION_MISMATCH":
      return "Your Stripe account isn't set up the way CENTERIVO payments require, so it can't be used. Contact CENTERIVO support.";
  }
}

// Whether the owner can (continue to) set up the account with Stripe.
export function canContinueSetup(state: PaymentAccountState): boolean {
  return (
    state === "NOT_CONNECTED" ||
    state === "SETUP_IN_PROGRESS" ||
    state === "ACTION_REQUIRED"
  );
}

// Back from Stripe's hosted onboarding (?connect=return) or a link that
// expired and must be replaced (?connect=refresh). Neither proves anything:
// the page always reads the account back from Stripe.
export function connectReturn(
  value: string | undefined,
): "return" | "refresh" | null {
  return value === "return" || value === "refresh" ? value : null;
}

// Only Stripe's own hosted onboarding (or the development fake) is ever a
// redirect target.
export function isAllowedOnboardingUrl(
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
  if (url.username || url.password || url.protocol !== "https:") return false;
  if (url.hostname === "connect.stripe.com") return true;
  // The development fake only in development and tests (never a deployment
  // that merely isn't marked production).
  return (
    (env.NODE_ENV === "development" || env.NODE_ENV === "test") &&
    url.hostname === "connect.fake.test"
  );
}

export const PAYMENTS_MESSAGES = {
  unavailable:
    "Connecting a payment account isn't available right now. Nothing was changed — please try again later.",
  ownerOnly:
    "Only the restaurant's owner can connect or manage its payment account.",
  failed:
    "We couldn't open Stripe just now. Nothing was changed — please try again.",
  needsSupport:
    "Connecting your Stripe account needs a quick check by CENTERIVO support before it can continue. Nothing was created or charged — please contact support.",
} as const;

export function paymentsRefusalMessage(
  status: number | null,
  body: unknown,
): string {
  const code =
    typeof body === "object" && body !== null && "code" in body
      ? (body as { code?: unknown }).code
      : undefined;
  if (status === 403 || code === "PAYMENT_ACCOUNT_OWNER_ONLY")
    return PAYMENTS_MESSAGES.ownerOnly;
  if (code === "PAYMENT_ACCOUNT_NEEDS_SUPPORT")
    return PAYMENTS_MESSAGES.needsSupport;
  if (status === 503 || code === "PAYMENTS_PROVIDER_UNAVAILABLE") {
    return PAYMENTS_MESSAGES.unavailable;
  }
  return PAYMENTS_MESSAGES.failed;
}
