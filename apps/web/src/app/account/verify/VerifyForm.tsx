"use client";

import { useActionState, useState } from "react";
import {
  verifyAction,
  resendVerificationAction,
  type VerifyFormState,
  type ResendVerificationFormState,
} from "@/lib/auth/actions";
import { Card } from "@/components/Card";

const inputClassName =
  "rounded-xl border border-border-default bg-surface-card px-4 py-3 text-base text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

const initialVerifyState: VerifyFormState = { error: null };
const initialResendState: ResendVerificationFormState = { message: null, error: null };

export function VerifyForm({ initialEmail }: { initialEmail: string }) {
  // Shared between both forms below so correcting the email in the main
  // form also applies to a subsequent "Resend code" click, rather than the
  // two silently drifting apart.
  const [email, setEmail] = useState(initialEmail);
  const [verifyState, verifyFormAction, verifyPending] = useActionState(
    verifyAction,
    initialVerifyState,
  );
  const [resendState, resendFormAction, resendPending] = useActionState(
    resendVerificationAction,
    initialResendState,
  );

  return (
    <div className="flex flex-col gap-6">
      <form action={verifyFormAction} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm text-text-secondary">
          Email
          <input
            required
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={inputClassName}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-text-secondary">
          Verification code
          <input
            required
            type="text"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            className={inputClassName}
          />
        </label>

        {verifyState.error ? (
          <Card tone="subtle" className="text-sm text-status-warning">
            {verifyState.error}
          </Card>
        ) : null}

        <button
          type="submit"
          disabled={verifyPending}
          className="flex min-h-11 items-center justify-center rounded-xl bg-status-success/10 px-4 py-3 text-base font-semibold text-status-success disabled:bg-surface-subtle disabled:text-text-muted"
        >
          {verifyPending ? "Verifying…" : "Verify"}
        </button>
      </form>

      <form action={resendFormAction} className="flex flex-col gap-2">
        <input type="hidden" name="email" value={email} />

        {resendState.error ? (
          <Card tone="subtle" className="text-sm text-status-warning">
            {resendState.error}
          </Card>
        ) : null}
        {resendState.message ? (
          <Card tone="subtle" className="text-sm text-text-secondary">
            {resendState.message}
          </Card>
        ) : null}

        <button
          type="submit"
          disabled={resendPending}
          className="self-start text-sm font-medium text-text-primary underline underline-offset-2 disabled:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {resendPending ? "Sending…" : "Resend code"}
        </button>
      </form>
    </div>
  );
}
