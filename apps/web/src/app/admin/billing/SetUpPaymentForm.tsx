"use client";

import { useActionState, useEffect, useRef } from "react";
import { setUpPaymentAction, type SetUpPaymentState } from "./actions";

const PRIMARY =
  "inline-flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-contrast hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-disabled:cursor-wait aria-disabled:opacity-70";

const INITIAL: SetUpPaymentState = { message: null };

// SC3b — "Set up payment" sends the owner to the payment provider's secure
// hosted page. Card details are entered there, never here.
export function SetUpPaymentForm() {
  const [state, formAction, pending] = useActionState(setUpPaymentAction, INITIAL);
  const message = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (state.message) message.current?.focus();
  }, [state]);

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="flex flex-col items-start gap-3"
    >
      <button type="submit" aria-disabled={pending} aria-busy={pending} className={PRIMARY}>
        {pending ? "Opening secure payment page…" : "Set up payment"}
      </button>
      <p className="text-xs text-text-secondary">
        You&apos;ll enter your payment details on our payment provider&apos;s secure page, then
        come back here. This is your CENTERIVO subscription — not your customers&apos; payments.
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
