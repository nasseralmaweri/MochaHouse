"use client";

import { useId, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { LocationSummary } from "@mocha-house/contracts";
import { CORPORATE_LOCATION_VALUE } from "@/lib/admin/location-context";
import { setAdminLocationPreference } from "@/lib/internal-auth/admin-location";

// The authorized-location selector. Options come only from the
// authorization-aware set (GET /internal/me). Hidden entirely when there is
// nothing to choose (a single-location, non-corporate user). Native
// <select> for accessibility.
export function LocationSwitcher({
  locations,
  isCorporate,
  currentValue,
}: {
  locations: LocationSummary[];
  isCorporate: boolean;
  currentValue: string;
}) {
  const id = useId();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const hasChoice = isCorporate || locations.length > 1;
  if (!hasChoice) {
    if (locations.length === 1) {
      return (
        <span className="text-sm text-text-secondary">
          <span className="text-text-muted">Location: </span>
          {locations[0].name}
        </span>
      );
    }
    return null;
  }

  function handleChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("location", value);
    startTransition(() => {
      void setAdminLocationPreference(value);
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  return (
    <label
      htmlFor={id}
      className="flex items-center gap-2 text-sm text-text-secondary"
    >
      <span className="hidden sm:inline">Location</span>
      <select
        id={id}
        value={currentValue}
        disabled={pending}
        onChange={(event) => handleChange(event.target.value)}
        className="min-h-11 max-w-[55vw] truncate rounded-xl border border-border-default bg-surface-card px-3 py-1.5 text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60 sm:max-w-xs"
      >
        {isCorporate ? (
          <option value={CORPORATE_LOCATION_VALUE}>
            Corporate / All locations
          </option>
        ) : null}
        {locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.name}
          </option>
        ))}
      </select>
    </label>
  );
}
