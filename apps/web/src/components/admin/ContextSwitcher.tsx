"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type {
  InternalBusinessSummary,
  LocationSummary,
} from "@mocha-house/contracts";
import { CORPORATE_LOCATION_VALUE } from "@/lib/admin/location-context";
import { setAdminLocationPreference } from "@/lib/internal-auth/admin-location";
import { switchBusinessAction } from "@/lib/internal-auth/admin-business";
import { Listbox, type ListboxOption } from "@/components/centerivo/Listbox";
import {
  IconAllLocations,
  IconBusiness,
  IconChevronsUpDown,
  IconLocations,
  IconSpinner,
} from "@/components/centerivo/Icons";

// The Business -> Scope context, split across the shell so each sits where
// the person reads it: the business at the top of the navy sidebar, the
// operating scope (Company-wide or one location) in the workspace header.
//
// Business options come ONLY from the API's list of businesses this identity
// may enter (S0F). Choosing one runs a server action that re-validates it
// and stores the preference; these components hold no tenant authority.
// Location options are the active business's authorization-aware set
// (GET /internal/me, resolved for that business); choosing one updates
// ?location= and the remembered preference, both re-validated server-side.

function BusinessAvatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[0.625rem] bg-accent text-sm font-semibold text-accent-contrast"
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

export function BusinessSwitcher({
  business,
  businesses,
  collapsed = false,
}: {
  business: InternalBusinessSummary;
  businesses: InternalBusinessSummary[];
  collapsed?: boolean;
}) {
  const [switching, startSwitch] = useTransition();
  const [switchTarget, setSwitchTarget] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const canSwitchBusiness = businesses.length > 1;

  const businessOptions: ListboxOption[] = businesses.map((b) => ({
    value: b.id,
    label: b.name,
    icon: <IconBusiness className="h-4 w-4" />,
  }));

  function selectBusiness(id: string) {
    const target = businesses.find((b) => b.id === id);
    if (!target) return;
    setSwitchError(null);
    setSwitchTarget(target.name);
    startSwitch(async () => {
      const result = await switchBusinessAction(id);
      if (result?.error) {
        setSwitchError(result.error);
        setSwitchTarget(null);
      }
    });
  }

  // Rendered in the light layer: it covers the whole viewport, not the
  // sidebar it was opened from.
  const switchOverlay = switching ? (
    <div
      role="status"
      aria-live="polite"
      className="cx-light cx-pop-in fixed inset-0 z-50 flex items-center justify-center bg-surface-page/85 backdrop-blur-sm"
    >
      <div
        className="flex items-center gap-3 rounded-2xl border border-border-default bg-surface-card px-6 py-4"
        style={{ boxShadow: "var(--cx-shadow-pop)" }}
      >
        <IconSpinner className="h-5 w-5 text-accent" />
        <p className="text-sm text-text-secondary">
          Switching to{" "}
          <span className="font-semibold text-text-primary">
            {switchTarget ?? "business"}
          </span>
          …
        </p>
      </div>
    </div>
  ) : null;

  const errorNotice = switchError ? (
    <p
      role="alert"
      className="mt-2 rounded-lg bg-status-error/10 px-3 py-2 text-xs text-status-error"
    >
      {switchError}
    </p>
  ) : null;

  if (collapsed) {
    return (
      <div className="flex flex-col items-center">
        {canSwitchBusiness ? (
          <Listbox
            options={businessOptions}
            value={business.id}
            onSelect={selectBusiness}
            disabled={switching}
            heading="Switch business"
            ariaLabel={`Business: ${business.name}. Switch business`}
            placement="right"
            triggerClassName="flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-surface-subtle disabled:cursor-default"
            trigger={<BusinessAvatar name={business.name} />}
          />
        ) : (
          <span
            title={`Business: ${business.name}`}
            className="flex h-11 w-11 items-center justify-center"
          >
            <BusinessAvatar name={business.name} />
            <span className="sr-only">Business: {business.name}</span>
          </span>
        )}
        {switchOverlay}
        {errorNotice}
      </div>
    );
  }

  const content = (
    <>
      <BusinessAvatar name={business.name} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[0.9375rem] font-semibold text-text-primary">
          {business.name}
        </span>
        <span className="truncate text-xs text-text-muted">
          {canSwitchBusiness ? "Switch business" : "Business"}
        </span>
      </span>
      {canSwitchBusiness ? (
        <IconChevronsUpDown className="h-4 w-4 text-text-muted group-hover:text-text-secondary" />
      ) : null}
    </>
  );
  const rowClass =
    "group flex min-h-12 w-full items-center gap-3 rounded-xl bg-surface-subtle px-2.5 py-2 text-left transition-colors disabled:cursor-default";

  return (
    <div>
      {canSwitchBusiness ? (
        <Listbox
          options={businessOptions}
          value={business.id}
          onSelect={selectBusiness}
          disabled={switching}
          heading="Switch business"
          ariaLabel={`Business: ${business.name}. Switch business`}
          panelClassName="left-0 right-0 top-full mt-1.5"
          triggerClassName={`${rowClass} hover:bg-accent-soft`}
          trigger={content}
        />
      ) : (
        <div className={rowClass}>{content}</div>
      )}
      {errorNotice}
      {switchOverlay}
    </div>
  );
}

export function ScopeSwitcher({
  locations,
  isCorporate,
  currentLocationValue,
}: {
  locations: LocationSummary[];
  isCorporate: boolean;
  currentLocationValue: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [locationPending, startLocation] = useTransition();

  const hasLocationChoice = isCorporate || locations.length > 1;
  // On the Overview the page's own scope control is authoritative, so the
  // header shows the scope as a quiet read-only indicator there. Everywhere
  // else (Orders, Operations, …) the header is the way to change it.
  const scopeReadOnly = pathname === "/admin";
  const interactive = hasLocationChoice && !scopeReadOnly;

  const locationOptions: ListboxOption[] = [
    ...(isCorporate
      ? [
          {
            value: CORPORATE_LOCATION_VALUE,
            label: "Company-wide",
            description: "Every location",
            icon: <IconAllLocations className="h-4 w-4" />,
          },
        ]
      : []),
    ...locations.map((location) => ({
      value: location.id,
      label: location.name,
      icon: <IconLocations className="h-4 w-4" />,
    })),
  ];

  const current =
    locationOptions.find((o) => o.value === currentLocationValue) ?? null;
  const label =
    current?.label ??
    (locations.length === 0 && !isCorporate
      ? "No locations assigned"
      : "Choose a location");
  const icon =
    currentLocationValue === CORPORATE_LOCATION_VALUE ? (
      <IconAllLocations className="h-4 w-4" />
    ) : (
      <IconLocations className="h-4 w-4" />
    );

  function selectLocation(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("location", value);
    startLocation(() => {
      void setAdminLocationPreference(value);
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  const pill = (
    <>
      <span className="text-accent">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
      {locationPending ? (
        <IconSpinner className="h-3.5 w-3.5 text-text-muted" />
      ) : interactive ? (
        <IconChevronsUpDown className="h-3.5 w-3.5 text-text-muted group-hover:text-text-secondary" />
      ) : null}
    </>
  );
  const pillClass =
    "group flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-full border border-border-default bg-surface-card px-3.5 text-sm font-medium text-text-primary lg:min-h-9";

  if (!interactive) {
    return (
      <div className={pillClass} title={`Scope: ${label}`}>
        <span className="sr-only">Scope: </span>
        {pill}
      </div>
    );
  }

  return (
    <Listbox
      options={locationOptions}
      value={currentLocationValue}
      onSelect={selectLocation}
      disabled={locationPending}
      heading="Switch scope"
      ariaLabel={`Scope: ${label}. Switch company or location`}
      className="min-w-0 max-w-full"
      panelClassName="right-0 top-full mt-1.5 sm:left-0 sm:right-auto"
      triggerClassName={`${pillClass} transition-colors hover:border-text-muted/60 disabled:cursor-default`}
      trigger={pill}
    />
  );
}
