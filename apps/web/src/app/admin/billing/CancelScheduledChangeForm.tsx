"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { cancelScheduledPlanChangeAction } from "./plan-actions";

const SECONDARY =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-border-default px-4 text-sm font-semibold text-text-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-disabled:cursor-wait aria-disabled:opacity-70";

const INITIAL: { message: string | null } = { message: null };

// SC3d-3 — withdraw the business's scheduled plan change (asked twice: a
// first press shows what happens, the second cancels). The current plan
// simply continues; the subscription itself is never cancelled. On success
// the page shows the new status (which takes focus); a refusal stays here.
export function CancelScheduledChangeForm({ planChangeId }: { planChangeId: string }) {
  const [state, formAction, pending] = useActionState(cancelScheduledPlanChangeAction, INITIAL);
  const [asking, setAsking] = useState(false);
  const message = useRef<HTMLParagraphElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const helpId = useId();

  useEffect(() => {
    if (state.message) message.current?.focus();
  }, [state]);

  const refusal = state.message ? (
    <p ref={message} tabIndex={-1} role="alert" className="text-sm text-status-error focus:outline-none">
      {state.message}
    </p>
  ) : null;

  if (!asking) {
    return (
      <div className="flex flex-col items-start gap-2">
        <button
          ref={startRef}
          type="button"
          onClick={() => {
            setAsking(true);
            requestAnimationFrame(() => confirmRef.current?.focus());
          }}
          className={SECONDARY}
        >
          Cancel scheduled change
        </button>
        {refusal}
      </div>
    );
  }

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="flex flex-col items-start gap-2"
    >
      <input type="hidden" name="planChangeId" value={planChangeId} />
      <p id={helpId} className="text-sm text-text-primary">
        You keep your current plan and price. Your subscription isn&apos;t cancelled.
      </p>
      {refusal}
      <div className="flex flex-wrap gap-2">
        <button
          ref={confirmRef}
          type="submit"
          aria-disabled={pending}
          aria-busy={pending}
          aria-describedby={helpId}
          className={SECONDARY}
        >
          {pending ? "Cancelling…" : "Yes, cancel the change"}
        </button>
        <button
          type="button"
          aria-disabled={pending}
          onClick={() => {
            if (pending) return;
            setAsking(false);
            requestAnimationFrame(() => startRef.current?.focus());
          }}
          className={SECONDARY}
        >
          Keep the change
        </button>
      </div>
    </form>
  );
}
