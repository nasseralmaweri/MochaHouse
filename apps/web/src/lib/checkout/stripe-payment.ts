import type { CheckoutPaymentRequiredResponse } from "@mocha-house/contracts";
import type { Stripe, StripeElements, StripeError } from "@stripe/stripe-js";

// ESP-04 M3b — the browser's side of a Stripe direct charge, framework-free
// (the Payment Element component is a thin shell around this).
//
//   * Everything Stripe.js is initialised with comes from the server's 202
//     answer for THIS checkout: the platform's publishable key, the
//     restaurant's connected account the intent lives on, and that intent's
//     client secret. The browser never chooses an account, an amount or an
//     intent, and never sends any of them back.
//   * Stripe.js confirming a payment proves nothing: whatever confirmPayment
//     answers, the page then asks CENTERIVO's server, which reads the intent
//     from Stripe and alone creates the order (exactly once).
//   * Test mode only (ESP-04 M3): a live publishable key is never used.
//   * The client secret lives in memory only: never stored, logged or put in
//     a URL by this code; the parameters Stripe adds to the return URL after
//     a redirect are removed at once.

export type CheckoutPayment = CheckoutPaymentRequiredResponse["payment"];

export interface StripeContext {
  publishableKey: string;
  connectedAccountId: string;
  clientSecret: string;
  // The intent the client secret belongs to (its prefix). With the account
  // it identifies the payment form, so a form is never reused for another
  // intent, checkout or business.
  intentId: string;
  key: string;
}

const TEST_PUBLISHABLE_KEY = /^pk_test_[A-Za-z0-9]{10,200}$/;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]{1,100}$/;
const CLIENT_SECRET = /^(pi_[A-Za-z0-9]{1,100})_secret_[A-Za-z0-9]{1,200}$/;

// The Stripe context for a payment waiting for its customer, or null when
// there is none to use: another provider, a payment being processed (no
// secret: nothing to pay again), or anything malformed or live.
export function stripeContextOf(payment: CheckoutPayment): StripeContext | null {
  if (payment.provider !== "stripe" || payment.state === "PROCESSING") {
    return null;
  }
  const { publishableKey, connectedAccountId, clientSecret } = payment;
  if (
    typeof publishableKey !== "string" ||
    !TEST_PUBLISHABLE_KEY.test(publishableKey) ||
    typeof connectedAccountId !== "string" ||
    !ACCOUNT_ID.test(connectedAccountId) ||
    typeof clientSecret !== "string"
  ) {
    return null;
  }
  const match = CLIENT_SECRET.exec(clientSecret);
  if (!match) return null;
  return {
    publishableKey,
    connectedAccountId,
    clientSecret,
    intentId: match[1],
    key: `${connectedAccountId}:${match[1]}`,
  };
}

type LoadStripe = (
  publishableKey: string,
  options: { stripeAccount: string },
) => Promise<Stripe | null>;

// One Stripe.js instance per (publishable key, connected account), so a
// payment form is always initialised for the account its intent lives on and
// never shares an instance with another business's. A failed load is not
// kept, so a later attempt can load it again.
export function createStripeLoader(load: LoadStripe) {
  const instances = new Map<string, Promise<Stripe | null>>();
  return (
    context: Pick<StripeContext, "publishableKey" | "connectedAccountId">,
  ): Promise<Stripe | null> => {
    const key = `${context.publishableKey}|${context.connectedAccountId}`;
    const known = instances.get(key);
    if (known) return known;
    const instance = load(context.publishableKey, {
      stripeAccount: context.connectedAccountId,
    })
      .catch(() => null)
      .then((stripe) => {
        if (stripe === null) instances.delete(key);
        return stripe;
      });
    instances.set(key, instance);
    return instance;
  };
}

// Where Stripe sends the customer back after a redirect (some 3-D Secure
// flows): this page, on this origin, built from the browser's own location,
// never from a response or a parameter.
export const PAYMENT_RETURN_PARAM = "payment";
export const PAYMENT_RETURN_VALUE = "return";

export function paymentReturnUrl(location: { origin: string }): string {
  return `${location.origin}/order/checkout?${PAYMENT_RETURN_PARAM}=${PAYMENT_RETURN_VALUE}`;
}

// What Stripe (and our return marker) put on the URL after a redirect. The
// client secret among them must not stay in the address bar, history or a
// Referer.
const RETURN_PARAMS = [
  "payment_intent",
  "payment_intent_client_secret",
  "redirect_status",
  PAYMENT_RETURN_PARAM,
] as const;

// The same URL without those parameters, or null when it has none (nothing
// to replace). The path, the hash and every other parameter are kept.
export function withoutPaymentReturnParams(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  let changed = false;
  for (const name of RETURN_PARAMS) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      changed = true;
    }
  }
  if (!changed) return null;
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
}

// What happened when the customer pressed Pay, as far as the PAGE is
// concerned. Never "paid": only the server's check can say that.
export type ConfirmOutcome =
  // Ask the server where the payment stands now (paid, waiting for another
  // card, or processing), showing Stripe's message meanwhile if it gave one.
  | { kind: "check"; message: string | null }
  // The card form is incomplete or invalid: nothing was sent. Fix and retry.
  | { kind: "fix-form"; message: string };

const CARD_FORM_MESSAGE = "Check your card details and try again.";

// Confirms the intent with the card in the Payment Element. 3-D Secure runs
// in Stripe's own frame; a redirect happens only when the bank requires one
// (this page is then loaded again at the return URL and resumes).
export async function confirmWithStripe(
  stripe: Pick<Stripe, "confirmPayment">,
  elements: StripeElements,
  returnUrl: string,
): Promise<ConfirmOutcome> {
  let error: StripeError | undefined;
  try {
    const result = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
      redirect: "if_required",
    });
    error = result.error;
  } catch {
    // Unknown: the confirmation may have reached Stripe. Ask the server.
    return { kind: "check", message: null };
  }
  if (!error) return { kind: "check", message: null };
  if (error.type === "validation_error") {
    // Caught by Stripe.js before anything was sent.
    return {
      kind: "fix-form",
      message: stripeMessage(error) ?? CARD_FORM_MESSAGE,
    };
  }
  if (error.type === "card_error") {
    // Refused (the intent waits for another card): Stripe's own customer
    // message, while the server confirms the state.
    return { kind: "check", message: stripeMessage(error) };
  }
  // Anything else (a network or API error, an unexpected state): the outcome
  // is not known here, so it is never shown as failed.
  return { kind: "check", message: null };
}

// Stripe's customer-facing message for a card or form error, bounded; null
// when there is none.
function stripeMessage(error: StripeError): string | null {
  return typeof error.message === "string" && error.message.length > 0
    ? error.message.slice(0, 300)
    : null;
}

// One Pay at a time: a second press (or a double click) while a confirmation
// or its server check is in flight does nothing. Held until the server has
// answered.
export function createSingleFlight() {
  let running = false;
  return {
    get running(): boolean {
      return running;
    },
    async run<T>(task: () => Promise<T>): Promise<T | undefined> {
      if (running) return undefined;
      running = true;
      try {
        return await task();
      } finally {
        running = false;
      }
    },
  };
}

// The Payment Element's look from this storefront's theme tokens (Stripe's
// frame cannot read the page's CSS variables). Any token the page does not
// define falls back to Stripe's default.
export function stripeAppearanceFrom(read: (token: string) => string): {
  theme: "stripe";
  variables: Record<string, string>;
} {
  const variables: Record<string, string> = {};
  const set = (name: string, token: string) => {
    const v = read(token).trim();
    if (v.length > 0 && v.length <= 100) variables[name] = v;
  };
  set("colorPrimary", "--accent");
  set("colorBackground", "--surface-card");
  set("colorText", "--text-primary");
  set("colorTextSecondary", "--text-secondary");
  set("colorDanger", "--status-error");
  set("borderRadius", "--cx-radius-control");
  return { theme: "stripe", variables };
}

// ESP-04 M4b — the payment page's heartbeat: while the card form is open and
// the page is VISIBLE, it tells the server every 2 minutes (and at once when
// the page becomes visible again, or when Pay is pressed) that this checkout
// is still in use, so an open checkout is never cleaned up as abandoned. It
// carries nothing but the checkout (the server's session cookie), and its
// failures are ignored: the server then simply sees no activity, and
// abandonment waits long either way. It never starts, confirms or checks a
// payment, and never touches the client secret.
export const PAYMENT_HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;

export interface HeartbeatEnvironment {
  isVisible: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export function createPaymentHeartbeat(
  send: () => Promise<unknown>,
  env: HeartbeatEnvironment,
): { start: () => void; pulse: () => void; stop: () => void } {
  let handle: unknown = null;
  let unsubscribe: (() => void) | null = null;
  let inFlight = false;
  let stopped = true;
  const beat = () => {
    if (stopped || inFlight || !env.isVisible()) return;
    inFlight = true;
    void send()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  };
  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      beat();
      handle = env.setInterval(beat, PAYMENT_HEARTBEAT_INTERVAL_MS);
      unsubscribe = env.onVisibilityChange(() => {
        if (env.isVisible()) beat();
      });
    },
    // At once (Pay was pressed), whatever the interval.
    pulse(): void {
      beat();
    },
    stop(): void {
      stopped = true;
      if (handle !== null) env.clearInterval(handle);
      handle = null;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
