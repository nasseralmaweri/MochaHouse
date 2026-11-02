"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { loadStripe } from "@stripe/stripe-js/pure";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import {
  confirmWithStripe,
  createSingleFlight,
  createStripeLoader,
  paymentReturnUrl,
  stripeAppearanceFrom,
  type StripeContext,
} from "@/lib/checkout/stripe-payment";

// ESP-04 M3b — the card form for a Stripe payment waiting for its customer.
// Stripe.js is loaded only when this panel is shown (the "pure" loader),
// initialised with the platform's publishable key and the restaurant's
// connected account from the server's answer, and the Payment Element is
// mounted for that intent's client secret. Cards only (the intent allows
// nothing else; Apple Pay, Google Pay and Link are switched off here too).
// 3-D Secure runs in Stripe's own frame.
//
// Paying never places the order here: after confirmPayment, whatever it
// answered, `onCheck` asks CENTERIVO's server, which reads the payment from
// Stripe and alone creates the order.

const stripeFor = createStripeLoader((key, options) => loadStripe(key, options));

const PAY_BUTTON =
  "flex min-h-11 w-full items-center justify-center rounded-xl bg-accent px-4 py-3 text-base font-semibold text-accent-contrast focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:bg-surface-subtle disabled:text-text-muted";

export function StripePaymentPanel({
  context,
  amountLabel,
  disabled,
  onPayingChange,
  onCheck,
}: {
  context: StripeContext;
  // The frozen amount, formatted (display only).
  amountLabel: string;
  // Another payment request of this page is in flight.
  disabled: boolean;
  // Whether a card payment is being confirmed (the page pauses its other
  // payment actions meanwhile).
  onPayingChange: (paying: boolean) => void;
  // Ask the server where the payment stands (and apply its answer).
  onCheck: () => Promise<void>;
}) {
  const stripePromise = useMemo(
    () => stripeFor(context),
    // One instance per account; the context's other fields do not matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [context.publishableKey, context.connectedAccountId],
  );
  const [appearance] = useState(() =>
    stripeAppearanceFrom((token) =>
      typeof window === "undefined"
        ? ""
        : getComputedStyle(document.documentElement).getPropertyValue(token),
    ),
  );
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void stripePromise.then((stripe) => {
      if (!cancelled) setLoadFailed(stripe === null);
    });
    return () => {
      cancelled = true;
    };
  }, [stripePromise]);

  if (loadFailed) {
    return (
      <p role="alert" className="text-status-warning">
        The payment form couldn&apos;t load. Nothing was charged — refresh the
        page to try again.
      </p>
    );
  }

  return (
    // Keyed by account and intent: a form is never reused for another
    // payment, checkout or business.
    <Elements
      key={context.key}
      stripe={stripePromise}
      options={{ clientSecret: context.clientSecret, appearance }}
    >
      <PayForm
        amountLabel={amountLabel}
        disabled={disabled}
        onPayingChange={onPayingChange}
        onCheck={onCheck}
      />
    </Elements>
  );
}

function PayForm({
  amountLabel,
  disabled,
  onPayingChange,
  onCheck,
}: {
  amountLabel: string;
  disabled: boolean;
  onPayingChange: (paying: boolean) => void;
  onCheck: () => Promise<void>;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState(false);
  const [complete, setComplete] = useState(false);
  const [paying, setPaying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [formFailed, setFormFailed] = useState(false);
  const flight = useRef(createSingleFlight());
  const messageRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (message !== null) messageRef.current?.focus();
  }, [message]);

  // The page pauses its other payment actions while a card payment is being
  // confirmed, and resumes them if this form goes away mid-payment.
  useEffect(() => {
    onPayingChange(paying);
  }, [paying, onPayingChange]);
  useEffect(() => () => onPayingChange(false), [onPayingChange]);

  async function pay(event: React.FormEvent) {
    event.preventDefault();
    if (!stripe || !elements || disabled) return;
    await flight.current.run(async () => {
      setPaying(true);
      setMessage(null);
      try {
        const outcome = await confirmWithStripe(
          stripe,
          elements,
          paymentReturnUrl(window.location),
        );
        if (outcome.kind === "fix-form") {
          setMessage(outcome.message);
          return;
        }
        if (outcome.message !== null) setMessage(outcome.message);
        // Never trusted on its own: the server reads the payment.
        await onCheck().catch(() => undefined);
      } finally {
        setPaying(false);
      }
    });
  }

  if (formFailed) {
    return (
      <p role="alert" className="text-status-warning">
        The payment form couldn&apos;t load. Nothing was charged — refresh the
        page to try again.
      </p>
    );
  }

  const canPay = ready && complete && !paying && !disabled && !!stripe;
  const hint = paying
    ? "Processing your payment — do not close this page."
    : !ready
      ? "Loading the secure card form…"
      : !complete
        ? "Enter your card details to pay."
        : null;

  return (
    <form
      onSubmit={(event) => void pay(event)}
      aria-label="Card payment"
      aria-busy={paying}
      className="flex flex-col gap-3"
    >
      <PaymentElement
        options={{
          layout: "tabs",
          wallets: { applePay: "never", googlePay: "never", link: "never" },
        }}
        onReady={() => setReady(true)}
        onChange={(event) => setComplete(event.complete)}
        onLoadError={() => setFormFailed(true)}
      />
      {message !== null ? (
        <p
          ref={messageRef}
          role="alert"
          tabIndex={-1}
          className="text-status-warning focus:outline-none"
        >
          {message}
        </p>
      ) : null}
      {/* Announced to screen readers: what the Pay button is waiting for,
          and the payment being processed. */}
      <p
        id="card-payment-hint"
        role="status"
        className="min-h-5 text-text-secondary"
      >
        {hint}
      </p>
      <button
        type="submit"
        disabled={!canPay}
        aria-describedby="card-payment-hint"
        className={PAY_BUTTON}
      >
        {paying ? "Processing payment…" : `Pay ${amountLabel}`}
      </button>
      <p className="text-xs text-text-muted">
        Card details are entered securely with Stripe and never reach this
        site.
      </p>
    </form>
  );
}
