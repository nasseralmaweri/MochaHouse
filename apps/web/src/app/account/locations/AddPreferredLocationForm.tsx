"use client";

import { useActionState } from "react";
import type { LocationSummary } from "@mocha-house/contracts";
import {
  addPreferredLocationAction,
  type PreferredLocationsFormState,
} from "@/lib/auth/actions";
import { Card } from "@/components/Card";

const initialState: PreferredLocationsFormState = { error: null };

export function AddPreferredLocationForm({
  addable,
}: {
  addable: LocationSummary[];
}) {
  const [state, formAction, pending] = useActionState(
    addPreferredLocationAction,
    initialState,
  );

  if (addable.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        All Mocha House locations are already in your list.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm text-text-secondary">
        Add a location
        <select
          name="locationId"
          defaultValue=""
          className="rounded-xl border border-border-default bg-surface-card px-4 py-3 text-base text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <option value="" disabled>
            Choose a location…
          </option>
          {addable.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>
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
        {pending ? "Adding…" : "Add preferred location"}
      </button>
    </form>
  );
}
