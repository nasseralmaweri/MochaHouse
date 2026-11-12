"use client";

import { useActionState } from "react";
import {
  internalSignInFormAction,
  type InternalSignInFormState,
} from "@/lib/internal-auth/actions";

const inputClassName =
  "min-h-11 rounded-lg border border-border-default bg-surface-card px-3.5 py-2.5 text-base text-text-primary transition-colors hover:border-text-muted/50 focus-visible:border-focus focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus";

const buttonClassName =
  "flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-base font-semibold text-accent-contrast transition-opacity hover:opacity-90 disabled:bg-surface-subtle disabled:text-text-muted";

const initialState: InternalSignInFormState = { error: null };

// Staff sign-in. V1 launch fix 2 — an invited employee's first sign-in (with
// the temporary password from their invitation email) continues to
// "Choose your password"; an expired setup returns to sign-in.
export function InternalSignInForm() {
  const [state, formAction, pending] = useActionState(
    internalSignInFormAction,
    initialState,
  );
  const step = state.step ?? "sign-in";

  const error = state.error ? (
    <p role="alert" className="rounded-lg bg-status-error/10 px-3 py-2 text-sm text-status-error">
      {state.error}
    </p>
  ) : null;

  if (step === "new-password") {
    return (
      <form action={formAction} className="flex flex-col gap-5">
        <input type="hidden" name="step" value="new-password" />
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold text-text-primary">
            Choose your password
          </h2>
          <p className="text-sm text-text-secondary">
            This is your first sign-in. Replace the temporary password from
            your invitation email with one only you know: at least 12
            characters, with upper- and lower-case letters, a number and a
            symbol.
          </p>
        </div>
        <label className="flex flex-col gap-1.5 text-sm font-medium text-text-primary">
          New password
          <input
            required
            type="password"
            name="newPassword"
            autoComplete="new-password"
            minLength={12}
            className={inputClassName}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium text-text-primary">
          Confirm new password
          <input
            required
            type="password"
            name="confirmPassword"
            autoComplete="new-password"
            minLength={12}
            className={inputClassName}
          />
        </label>
        {error}
        <button type="submit" disabled={pending} className={buttonClassName}>
          {pending ? "Saving…" : "Save password and sign in"}
        </button>
      </form>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="step" value="sign-in" />
      <label className="flex flex-col gap-1.5 text-sm font-medium text-text-primary">
        Email
        <input
          required
          type="email"
          name="identifier"
          autoComplete="email"
          className={inputClassName}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-text-primary">
        Password
        <input
          required
          type="password"
          name="password"
          autoComplete="current-password"
          className={inputClassName}
        />
      </label>
      {error}
      <button type="submit" disabled={pending} className={buttonClassName}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
