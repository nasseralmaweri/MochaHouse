import { formatMinorUnits } from "./crm";
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

// A deadline is an instant, not a calendar day: shown with its time, in
// UTC (stated), so it never shifts with the server's time zone.
export function formatDeadline(iso: string): string {
  return `${new Date(iso).toLocaleString("en-US", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  })} UTC`;
}

// SC3c-1 — during a billing wind-down (the business is suspended for
// billing) only these admin areas work; everything else is refused by the
// API (fail closed) and shown as unavailable here.
export const WIND_DOWN_NAV_KEYS: readonly string[] = ["orders", "billing"];

export function isWindDownPath(pathname: string): boolean {
  return /^\/admin\/(orders|billing)(\/|$)/.test(pathname);
}

// SC3c-1 — the wind-down banner, from what THIS person can actually reach.
export function windDownMessage(access: {
  orders: boolean;
  billing: boolean;
}): string {
  const lead = "This business is suspended for billing; everything else is paused.";
  if (access.orders && access.billing) {
    return `${lead} You can still complete orders you already accepted, and see and settle your billing.`;
  }
  if (access.orders) {
    return `${lead} You can still complete orders you already accepted.`;
  }
  if (access.billing) return `${lead} You can still see and settle your billing.`;
  return `${lead} Ask a business owner or manager for help.`;
}

// SC4b/SC4c — a business its owner created that has not completed its first
// payment setup: what is (and is not) on meanwhile.
export const INITIAL_SETUP_PENDING_MESSAGE =
  "Set up payment to start your plan. Until then nothing is charged, and your plan's extra modules and online ordering stay off — you can keep setting up your business.";

// SC4c — the trial and charge timing, in plain words, before payment setup.
export function initialSetupDisclosure(
  trial: { days: number; requiresPaymentMethod: boolean } | null,
  price: { amountMinorUnits: number; currency: string; interval: "MONTH" | "YEAR" } | null,
): string {
  const amount = price
    ? `${formatMinorUnits(price.amountMinorUnits, price.currency)} per ${price.interval === "YEAR" ? "year" : "month"}`
    : "your plan's price";
  if (trial) {
    return trial.requiresPaymentMethod
      ? `Your ${trial.days}-day free trial starts when you finish payment setup. A card is required. You won't be charged during the trial; after it ends, ${amount} is charged automatically until you cancel.`
      : `Your ${trial.days}-day free trial starts when you finish payment setup. No card is needed to start; add one before the trial ends to keep your plan at ${amount}.`;
  }
  return `When you finish payment setup, ${amount} is charged right away and then automatically each ${price?.interval === "YEAR" ? "year" : "month"} until you cancel.`;
}

export const SELECTION_UNAVAILABLE_MESSAGE =
  "The plan or price you chose is no longer offered. Choose a plan again to set up payment — you won't be charged a different amount without choosing it.";

// SC3c-1 — the admin-wide notice for a billing state that needs attention
// (null when nothing does). Plain facts only: what is off, until when.
export function billingNotice(billing: BusinessBillingSummary): string | null {
  if (billing.initialSetupPending) return INITIAL_SETUP_PENDING_MESSAGE;
  // SC3e-4 — payment setup: the deadline passed (paused), or is set.
  const setup = paymentSetupNotice(billing);
  if (setup) return setup;
  switch (billing.state) {
    case "TRIAL_EXPIRED":
      // Only what enforcement really does now (server-derived flags).
      return billing.premiumPaused && billing.recoveryEndsAt && !billing.suspendedForBilling
        ? `Your free trial has ended and premium features are off. Your business stays open until ${formatDeadline(billing.recoveryEndsAt)}.`
        : null;
    case "PAST_DUE":
      return billing.enforced && billing.graceEndsAt
        ? `Your last CENTERIVO payment didn't go through. Everything keeps working until ${formatDeadline(billing.graceEndsAt)}.`
        : null;
    // SC3c-3 — temporary access an operator gave while still unpaid.
    case "UNPAID":
      return billing.enforced && billing.graceExceptionEndsAt && !billing.suspendedForBilling
        ? `Your CENTERIVO invoice is still unpaid. You have temporary access until ${formatDeadline(billing.graceExceptionEndsAt)}; pay before then to keep it.`
        : null;
    default:
      return null;
  }
}

// SC3e-4 — payment setup, in plain words: what happens and when. A
// deadline is shown only when billing enforcement applies it.
export const PAYMENT_SETUP_EXPIRED_MESSAGE =
  "Payment wasn't set up by the deadline, so your business is paused: only billing and orders you already accepted are available. Set up payment to restore access — it's restored as soon as your payment is confirmed. Your data is kept.";

export function paymentSetupNotice(billing: BusinessBillingSummary): string | null {
  if (billing.paymentSetup.expired) return PAYMENT_SETUP_EXPIRED_MESSAGE;
  if (billing.enforced && billing.paymentSetup.required && billing.paymentSetup.deadline) {
    return `Set up payment by ${formatDeadline(billing.paymentSetup.deadline)}. If it isn't set up by then, your business will be paused until it is.`;
  }
  return null;
}

// What the state means for the owner, in one sentence.
export function billingStateDescription(billing: BusinessBillingSummary): string {
  switch (billing.state) {
    case "COMPLIMENTARY":
      return "Your CENTERIVO plan is complimentary. There is nothing to pay.";
    case "AWAITING_SETUP":
      // SC4b/SC4c — chosen by the owner; not set up yet.
      if (billing.initialSetupPending) {
        return "You chose this plan. Nothing is charged until you finish payment setup.";
      }
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
      return billing.graceExceptionEndsAt && !billing.suspendedForBilling
        ? `Your subscription is unpaid. You have temporary access until ${formatDeadline(billing.graceExceptionEndsAt)}; pay your outstanding invoices before then to keep it.`
        : "Your subscription is unpaid and your outstanding invoices need paying to continue.";
    case "TRIAL_EXPIRED":
      if (billing.suspendedForBilling) {
        return "Your free trial ended without a payment method. Nothing was charged. Your business is paused until payment is set up; orders you already accepted can still be completed.";
      }
      return billing.premiumPaused && billing.recoveryEndsAt
        ? `Your free trial ended without a payment method. Nothing was charged. Premium features are off, and your business stays open until ${formatDeadline(billing.recoveryEndsAt)}; after that it is paused until payment is set up.`
        : "Your free trial ended without a payment method. Nothing was charged.";
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
  trialPendingElsewhere:
    "A free trial is being set up for another of your businesses. Finish or leave that payment setup, then try again.",
  forbidden: "Only the business owner can set up payment.",
  sessionEnded: "Your session has ended. Sign in again to continue.",
  tooMany: "Too many attempts. Wait a few minutes, then try again.",
  // SC3c-2 — recovery.
  nothingToPay: "There's no outstanding invoice to pay right now. This page shows the latest status.",
  subscriptionNotEnded:
    "Your previous subscription hasn't fully ended yet at our payment provider. Try again in a moment.",
  recoveryUnavailable: "This isn't available right now. Nothing was changed. Try again in a moment.",
  recoveryUnderReview:
    "Your payment is being reviewed by our team. You won't be charged again; we'll restore your subscription or contact you.",
  recoveryForbidden: "Only the business owner, or someone who manages billing, can settle billing.",
} as const;

const CONFLICTS: Record<string, string> = {
  BILLING_NOT_BILLED: BILLING_MESSAGES.notBilled,
  BILLING_ALREADY_SET_UP: BILLING_MESSAGES.alreadySetUp,
  BILLING_CHECKOUT_IN_PROGRESS: BILLING_MESSAGES.inProgress,
  BILLING_CHECKOUT_PROCESSING: BILLING_MESSAGES.processing,
  BILLING_TRIAL_PENDING_ELSEWHERE: BILLING_MESSAGES.trialPendingElsewhere,
  BILLING_NOTHING_TO_PAY: BILLING_MESSAGES.nothingToPay,
  BILLING_SUBSCRIPTION_NOT_ENDED: BILLING_MESSAGES.subscriptionNotEnded,
  BILLING_RECOVERY_UNDER_REVIEW: BILLING_MESSAGES.recoveryUnderReview,
  // SC4c
  BILLING_SELECTION_UNAVAILABLE: SELECTION_UNAVAILABLE_MESSAGE,
  BILLING_SELECTION_LOCKED:
    "Your plan can be changed here only before payment is set up. This page shows the latest status.",
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

// SC3c-2 — only the billing provider's own hosted invoice-payment and
// Customer Portal pages (values from our API, still checked: never an open
// redirect). The fake provider's pages only outside production.
export function isAllowedRecoveryUrl(
  value: unknown,
  kind: "invoice" | "portal",
  env: Record<string, string | undefined> = process.env,
): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const stripe = kind === "invoice" ? "invoice.stripe.com" : "billing.stripe.com";
  if (url.hostname === stripe) return true;
  const fake = kind === "invoice" ? "invoice.fake.test" : "billing.fake.test";
  return env.NODE_ENV !== "production" && url.hostname === fake;
}

// SC3e-1 — an invoice's document: the provider's hosted invoice page, or
// its PDF (the provider's own host, under /invoice/).
export function isAllowedInvoiceDocumentUrl(
  value: unknown,
  kind: "invoice" | "pdf",
  env: Record<string, string | undefined> = process.env,
): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  if (kind === "invoice") return isAllowedRecoveryUrl(value, "invoice", env);
  if (!url.pathname.startsWith("/invoice/")) return false;
  if (url.hostname === "pay.stripe.com") return true;
  return env.NODE_ENV !== "production" && url.hostname === "pay.fake.test";
}

export function portalReturn(value: unknown): boolean {
  return value === "returned";
}

// "pending": back from the provider, but the payment was not confirmed
// within the page's minute of checking (the actions are offered again).
export type CheckoutReturn = "success" | "cancelled" | "pending" | null;

export function checkoutReturn(value: unknown): CheckoutReturn {
  return value === "success" || value === "cancelled" || value === "pending"
    ? value
    : null;
}
