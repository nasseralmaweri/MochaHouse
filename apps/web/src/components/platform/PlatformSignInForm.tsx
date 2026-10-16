"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import {
  platformSignInAction,
  type PlatformFormState,
} from "@/lib/platform-auth/actions";
import {
  PlatformLiveError,
  platformInputClassName,
  platformPrimaryButtonClassName,
} from "./PlatformAuthFrame";

const initialState: PlatformFormState = { error: null };

// SC1b — step 1 of the platform-operator sign-in. The password is posted to
// a server action; nothing sensitive is kept in this component. After an
// error the email is kept and focus returns to the field to correct (the
// password, or the email if it is empty).
export function PlatformSignInForm() {
  const [state, formAction, pending] = useActionState(
    platformSignInAction,
    initialState,
  );
  const emailInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const errorId = useId();

  useEffect(() => {
    if (!state.error) return;
    (state.email ? passwordInput : emailInput).current?.focus();
  }, [state]);

  const describedBy = state.error ? errorId : undefined;

  return (
    <form
      action={formAction}
      className="flex flex-col gap-5"
      noValidate
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
    >
      <label className="flex flex-col gap-1.5 text-sm font-medium text-text-primary">
        Email
        <input
          ref={emailInput}
          // Remount with the echoed email after a failed attempt (React
          // resets the form once the action completes).
          key={state.email ?? ""}
          defaultValue={state.email ?? ""}
          autoFocus={!state.email}
          required
          type="email"
          name="email"
          autoComplete="username"
          spellCheck={false}
          aria-invalid={state.error ? true : undefined}
          aria-describedby={describedBy}
          className={platformInputClassName}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-text-primary">
        Password
        <input
          ref={passwordInput}
          required
          type="password"
          name="password"
          autoComplete="current-password"
          aria-invalid={state.error ? true : undefined}
          aria-describedby={describedBy}
          className={platformInputClassName}
        />
      </label>

      <PlatformLiveError id={errorId} message={state.error} />

      <button
        type="submit"
        aria-disabled={pending}
        aria-busy={pending}
        className={platformPrimaryButtonClassName}
      >
        {pending ? "Checking…" : "Continue"}
      </button>
      <p className="text-xs text-text-secondary">
        Next, you will be asked for a code from your authenticator app.
      </p>
    </form>
  );
}
