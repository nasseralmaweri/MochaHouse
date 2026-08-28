"use client";

import { useActionState, useState } from "react";
import {
  updatePreferencesAction,
  type PreferencesFormState,
} from "@/lib/auth/actions";
import { Card } from "@/components/Card";

const initialState: PreferencesFormState = { error: null, success: false };

export function PreferencesForm({
  initialMarketingEmailOptIn,
}: {
  initialMarketingEmailOptIn: boolean;
}) {
  const [optIn, setOptIn] = useState(initialMarketingEmailOptIn);
  const [state, formAction, pending] = useActionState(
    updatePreferencesAction,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label className="flex items-start gap-3 text-sm text-text-secondary">
        <input
          type="checkbox"
          name="marketingEmailOptIn"
          checked={optIn}
          onChange={(event) => setOptIn(event.target.checked)}
          className="mt-1 size-4 rounded border-border-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        />
        <span className="flex flex-col gap-1">
          <span className="text-base font-medium text-text-primary">
            Marketing emails
          </span>
          <span>
            Receive news, seasonal drinks, offers, and other Mocha House
            marketing emails.
          </span>
        </span>
      </label>

      <p className="text-xs text-text-muted">
        Turning this off does not affect essential account, security, or
        order-related emails — those are always sent.
      </p>

      {state.error ? (
        <Card tone="subtle" className="text-sm text-status-warning">
          {state.error}
        </Card>
      ) : null}
      {state.success ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          Your preferences have been saved.
        </Card>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="flex min-h-11 items-center justify-center rounded-xl bg-status-success/10 px-4 py-3 text-base font-semibold text-status-success disabled:bg-surface-subtle disabled:text-text-muted"
      >
        {pending ? "Saving…" : "Save preferences"}
      </button>
    </form>
  );
}
