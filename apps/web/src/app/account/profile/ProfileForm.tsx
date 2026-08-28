"use client";

import { useActionState, useState } from "react";
import {
  updateProfileAction,
  type ProfileFormState,
} from "@/lib/auth/actions";
import { Card } from "@/components/Card";

const inputClassName =
  "rounded-xl border border-border-default bg-surface-card px-4 py-3 text-base text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

const initialState: ProfileFormState = { error: null, success: false };

export function ProfileForm({
  initialDisplayName,
}: {
  initialDisplayName: string;
}) {
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [state, formAction, pending] = useActionState(
    updateProfileAction,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm text-text-secondary">
        Display name
        <input
          type="text"
          name="displayName"
          autoComplete="name"
          maxLength={80}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          className={inputClassName}
        />
        <span className="text-xs text-text-muted">
          Leave blank to show your email address instead.
        </span>
      </label>

      {state.error ? (
        <Card tone="subtle" className="text-sm text-status-warning">
          {state.error}
        </Card>
      ) : null}
      {state.success ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          Your profile has been updated.
        </Card>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="flex min-h-11 items-center justify-center rounded-xl bg-status-success/10 px-4 py-3 text-base font-semibold text-status-success disabled:bg-surface-subtle disabled:text-text-muted"
      >
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
