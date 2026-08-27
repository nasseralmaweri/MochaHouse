"use client";

import { useActionState } from "react";
import { registerAction, type RegisterFormState } from "@/lib/auth/actions";
import { Card } from "@/components/Card";

const inputClassName =
  "rounded-xl border border-border-default bg-surface-card px-4 py-3 text-base text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

const initialState: RegisterFormState = { error: null };

export function RegisterForm() {
  const [state, formAction, pending] = useActionState(registerAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm text-text-secondary">
        Name
        <input
          required
          type="text"
          name="displayName"
          autoComplete="name"
          className={inputClassName}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-text-secondary">
        Email
        <input
          required
          type="email"
          name="email"
          autoComplete="email"
          className={inputClassName}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-text-secondary">
        Password
        <input
          required
          type="password"
          name="password"
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
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
