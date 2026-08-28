"use client";

import { useActionState } from "react";
import {
  removePreferredLocationAction,
  type PreferredLocationsFormState,
} from "@/lib/auth/actions";

const initialState: PreferredLocationsFormState = { error: null };

export function RemovePreferredLocationButton({
  locationId,
  locationName,
}: {
  locationId: string;
  locationName: string;
}) {
  const [state, formAction, pending] = useActionState(
    removePreferredLocationAction,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="locationId" value={locationId} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`Remove ${locationName} from preferred locations`}
        className="text-sm font-medium text-text-secondary underline underline-offset-2 disabled:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {pending ? "Removing…" : "Remove"}
      </button>
      {state.error ? (
        <span className="text-xs text-status-warning">{state.error}</span>
      ) : null}
    </form>
  );
}
