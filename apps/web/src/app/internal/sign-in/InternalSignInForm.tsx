"use client";

import { useActionState } from "react";
import {
  internalSignInAction,
  type InternalSignInFormState,
} from "@/lib/internal-auth/actions";

const inputClassName =
  "min-h-11 rounded-lg border border-border-default bg-surface-card px-3.5 py-2.5 text-base text-text-primary transition-colors hover:border-text-muted/50 focus-visible:border-focus focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus";

const initialState: InternalSignInFormState = { error: null };

export function InternalSignInForm() {
  const [state, formAction, pending] = useActionState(
    internalSignInAction,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-5">
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

      {state.error ? (
        <p role="alert" className="rounded-lg bg-status-error/10 px-3 py-2 text-sm text-status-error">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-base font-semibold text-accent-contrast transition-opacity hover:opacity-90 disabled:bg-surface-subtle disabled:text-text-muted"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
