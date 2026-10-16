"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import {
  openPortalAction,
  payInvoiceAction,
  setUpPaymentAction,
  type SetUpPaymentState,
} from "./actions";

const PRIMARY =
  "inline-flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-contrast hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-disabled:cursor-wait aria-disabled:opacity-70";
const SECONDARY =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-border-default px-4 text-sm font-semibold text-text-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-disabled:cursor-wait aria-disabled:opacity-70";

const INITIAL: SetUpPaymentState = { message: null };

const ACTIONS = {
  restart: {
    action: setUpPaymentAction,
    label: "Restart subscription",
    pending: "Opening secure payment page…",
    help: "You'll pay on our payment provider's secure page. No free trial is included; your plan's features return once the payment is confirmed.",
    primary: true,
  },
  invoice: {
    action: payInvoiceAction,
    label: "Pay outstanding invoice",
    pending: "Opening secure payment page…",
    help: "You'll pay your oldest outstanding invoice on our payment provider's secure page. That page can't bring you back here: return to this page and refresh afterwards. If more invoices are outstanding, pay each one; full access returns once none are left and the payment is confirmed.",
    primary: true,
  },
  portal: {
    action: openPortalAction,
    label: "Update payment method",
    pending: "Opening secure page…",
    help: "Opens our payment provider's secure page to update your card or see invoices.",
    primary: false,
  },
} as const;

// SC3c-2 — a billing recovery action: sends the owner to the payment
// provider's secure hosted page. Card details are entered there, never here.
export function BillingActionForm({ kind }: { kind: keyof typeof ACTIONS }) {
  const config = ACTIONS[kind];
  const [state, formAction, pending] = useActionState(config.action, INITIAL);
  const message = useRef<HTMLParagraphElement>(null);
  const helpId = useId();

  useEffect(() => {
    if (state.message) message.current?.focus();
  }, [state]);

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="flex flex-col items-start gap-2"
    >
      <button
        type="submit"
        aria-disabled={pending}
        aria-busy={pending}
        aria-describedby={helpId}
        className={config.primary ? PRIMARY : SECONDARY}
      >
        {pending ? config.pending : config.label}
      </button>
      <p id={helpId} className="text-xs text-text-secondary">
        {config.help}
      </p>
      {state.message ? (
        <p
          ref={message}
          tabIndex={-1}
          role="alert"
          className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary focus:outline-none"
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
