"use client";

import { useActionState } from "react";
import {
  resetPasswordAction,
  type ResetPasswordFormState,
} from "@/lib/auth/actions";
import { Card } from "@/components/Card";

const inputClassName =
  "rounded-xl border border-border-default bg-surface-card px-4 py-3 text-base text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

const initialState: ResetPasswordFormState = { error: null };

export function ResetPasswordForm({ initialEmail }: { initialEmail: string }) {
  const [state, formAction, pending] = useActionState(
    resetPasswordAction,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm text-text-secondary">
        Email
        <input
          required
          type="email"
          name="email"
          autoComplete="email"
          defaultValue={initialEmail}
          className={inputClassName}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-text-secondary">
        Recovery code
        <input
          required
          type="text"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          className={inputClassName}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-text-secondary">
        New password
        <input
          required
          type="password"
          name="newPassword"
          autoComplete="new-password"
          minLength={8}
          className={inputClassName}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-text-secondary">
        Confirm new password
        <input
          required
          type="password"
          name="confirmPassword"
          autoComplete="new-password"
          minLength={8}
          className={inputClassName}
        />
      </label>

      {state.error ? (
        <Card tone="subtle" className="text-sm text-status-warning">
          {state.error}
        </Card>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="flex min-h-11 items-center justify-center rounded-xl bg-status-success/10 px-4 py-3 text-base font-semibold text-status-success disabled:bg-surface-subtle disabled:text-text-muted"
      >
        {pending ? "Resetting…" : "Reset password"}
      </button>
    </form>
  );
}
