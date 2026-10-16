"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import {
  platformCancelSignInAction,
  platformEnrolVerifyAction,
  platformVerifyAction,
  type PlatformFormState,
} from "@/lib/platform-auth/actions";
import {
  PlatformLiveError,
  platformInputClassName,
  platformPrimaryButtonClassName,
} from "./PlatformAuthFrame";

const initialState: PlatformFormState = { error: null };

// SC1b — the second factor: a 6-digit code from the operator's authenticator
// app (an existing one, or the one just added during enrolment). The code is
// posted to a server action; the challenge handle stays in an HttpOnly
// cookie. Nothing is submitted automatically.
//
// Focus: the code field is focused on arrival and again after an error (the
// form resets once the action completes), and is tied to the error message.
// The button stays focusable while busy (aria-disabled, not disabled).
export function PlatformCodeForm({ mode }: { mode: "verify" | "enrol" }) {
  const [state, formAction, pending] = useActionState(
    mode === "enrol" ? platformEnrolVerifyAction : platformVerifyAction,
    initialState,
  );
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const hintId = useId();

  useEffect(() => {
    if (state.error) input.current?.focus();
  }, [state]);

  return (
    <div className="flex flex-col gap-4">
      <form
        action={formAction}
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <label className="flex flex-col gap-1.5 text-sm font-medium text-text-primary">
          Authentication code
          <input
            ref={input}
            autoFocus
            required
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxLength={7}
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? `${errorId} ${hintId}` : hintId}
            className={`${platformInputClassName} font-mono tracking-[0.3em]`}
          />
        </label>
        <p id={hintId} className="-mt-3 text-xs text-text-secondary">
          The 6-digit code shown in your authenticator app. This sign-in step
          expires after 3 minutes.
        </p>

        <PlatformLiveError id={errorId} message={state.error} />

        <button
          type="submit"
          aria-disabled={pending}
          aria-busy={pending}
          className={platformPrimaryButtonClassName}
        >
          {pending ? "Verifying…" : mode === "enrol" ? "Finish setup" : "Verify"}
        </button>
      </form>
      <form action={platformCancelSignInAction}>
        <button
          type="submit"
          className="w-full rounded-lg px-4 py-2 text-sm font-medium text-text-secondary underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
        >
          Cancel and start again
        </button>
      </form>
    </div>
  );
}
