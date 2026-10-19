"use client";

import { useActionState, useEffect, useRef } from "react";
import { connectPaymentsAction, type ConnectPaymentsState } from "./actions";

const PRIMARY =
  "inline-flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-contrast hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-disabled:cursor-wait aria-disabled:opacity-70";

const INITIAL: ConnectPaymentsState = { message: null };

// ESP-04 M1 — "Connect with Stripe" / "Continue setup" sends the owner to
// Stripe's hosted onboarding. Business and bank details are entered there,
// never here.
export function ConnectPaymentsForm({ label }: { label: string }) {
  const [state, formAction, pending] = useActionState(
    connectPaymentsAction,
    INITIAL,
  );
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
      <button
        type="submit"
        aria-disabled={pending}
        aria-busy={pending}
        className={PRIMARY}
      >
        {pending ? "Opening Stripe…" : label}
      </button>
      <p className="text-xs text-text-secondary">
        You&apos;ll finish setup on Stripe&apos;s secure page, then come back
        here. If you already use Stripe, sign in with your Stripe login there.
        This is for your customers&apos; payments — not your CENTERIVO
        subscription.
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
