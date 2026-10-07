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

function BusinessAvatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[0.625rem] bg-accent-soft text-sm font-semibold text-accent"
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

// The Business -> Location context block. One grouped surface with the
// location row nested under (and visually connected to) the business row, so
// the two read as a hierarchy rather than two unrelated filters.
//
// Business options come ONLY from the API's list of businesses this identity
// may enter (S0F). Choosing one runs a server action that re-validates it
// and stores the preference; this component holds no tenant authority.
// Location options are the active business's authorization-aware set
// (GET /internal/me, resolved for that business).
export function ContextSwitcher({
  business,
  businesses,
  locations,
  isCorporate,
  currentLocationValue,
  collapsed = false,
}: {
  business: InternalBusinessSummary;
  businesses: InternalBusinessSummary[];
  locations: LocationSummary[];
  isCorporate: boolean;
  currentLocationValue: string;
  collapsed?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [locationPending, startLocation] = useTransition();
  const [switching, startSwitch] = useTransition();
  const [switchTarget, setSwitchTarget] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const canSwitchBusiness = businesses.length > 1;
  const hasLocationChoice = isCorporate || locations.length > 1;
  // On the Overview the page's own scope control is authoritative, so the
  // sidebar shows the scope as a quiet read-only indicator there. Everywhere
  // else (Orders, Operations, …) the sidebar remains the way to change it.
  const scopeReadOnly = pathname === "/admin";
  const locationInteractive = hasLocationChoice && !scopeReadOnly;

  const businessOptions: ListboxOption[] = businesses.map((b) => ({
    value: b.id,
    label: b.name,
    icon: <IconBusiness className="h-4 w-4" />,
  }));

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

  const currentLocation =
    locationOptions.find((o) => o.value === currentLocationValue) ?? null;
  const locationLabel =
    currentLocation?.label ??
    (locations.length === 0 && !isCorporate
      ? "No locations assigned"
      : "Choose a location");
  const isAllLocations = currentLocationValue === CORPORATE_LOCATION_VALUE;
  const locationIcon = isAllLocations ? (
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

  const switchOverlay = switching ? (
    <div
      role="status"
      aria-live="polite"
      className="cx-pop-in fixed inset-0 z-50 flex items-center justify-center bg-surface-page/85 backdrop-blur-sm"
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

  // --- Collapsed rail: two compact, labelled icon controls. ---------------
  if (collapsed) {
    const railButton =
      "flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface-subtle disabled:cursor-default";
    return (
      <div className="flex flex-col items-center gap-1">
        {canSwitchBusiness ? (
          <Listbox
            options={businessOptions}
            value={business.id}
            onSelect={selectBusiness}
            disabled={switching}
            heading="Business"
            ariaLabel={`Business: ${business.name}. Switch business`}
            placement="right"
            triggerClassName={railButton}
            trigger={<BusinessAvatar name={business.name} />}
          />
        ) : (
          <span
            title={`Business: ${business.name}`}
            className="flex h-10 w-10 items-center justify-center"
          >
            <BusinessAvatar name={business.name} />
            <span className="sr-only">Business: {business.name}</span>
          </span>
        )}
        {locationInteractive ? (
          <Listbox
            options={locationOptions}
            value={currentLocationValue}
            onSelect={selectLocation}
            disabled={locationPending}
            heading="Location"
            ariaLabel={`Location: ${locationLabel}. Switch location`}
            placement="right"
            triggerClassName={railButton}
            trigger={locationPending ? <IconSpinner /> : locationIcon}
          />
        ) : (
          <span
            title={`Location: ${locationLabel}`}
            className="flex h-10 w-10 items-center justify-center text-text-muted"
          >
            {locationIcon}
            <span className="sr-only">Location: {locationLabel}</span>
          </span>
        )}
        {switchOverlay}
        {errorNotice}
      </div>
    );
  }

  // --- Expanded block. -----------------------------------------------------
  // No card, no field labels: the business is the larger, bolder line and
  // the operating scope sits beneath it, indented to the business name, so
  // the hierarchy reads from size, weight and alignment alone.
  const businessRowContent = (
    <>
      <BusinessAvatar name={business.name} />
      <span className="min-w-0 flex-1 truncate text-[0.9375rem] font-semibold text-text-primary">
        {business.name}
      </span>
      {canSwitchBusiness ? (
        <IconChevronsUpDown className="h-4 w-4 text-text-muted group-hover:text-text-secondary" />
      ) : null}
    </>
  );

  const locationRowContent = (
    <>
      <span className="text-text-muted">{locationIcon}</span>
      <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-text-secondary">
        {locationLabel}
      </span>
      {locationPending ? (
        <IconSpinner className="h-3.5 w-3.5 text-text-muted" />
      ) : locationInteractive ? (
        <IconChevronsUpDown className="h-3.5 w-3.5 text-text-muted group-hover:text-text-secondary" />
      ) : null}
    </>
  );

  const businessRowClass =
    "group flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-black/[0.045] disabled:cursor-default";
  const locationRowClass =
    "group flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-black/[0.045] disabled:cursor-default";
  const staticClass = (c: string) => c.replace(/hover:bg-\S+/, "");

  return (
    <div className="flex flex-col gap-0.5">
      {canSwitchBusiness ? (
        <Listbox
          options={businessOptions}
          value={business.id}
          onSelect={selectBusiness}
          disabled={switching}
          heading="Switch business"
          ariaLabel={`Business: ${business.name}. Switch business`}
          triggerClassName={businessRowClass}
          trigger={businessRowContent}
        />
      ) : (
        <div className={staticClass(businessRowClass)}>{businessRowContent}</div>
      )}

      <div className="ml-12">
        {locationInteractive ? (
          <Listbox
            options={locationOptions}
            value={currentLocationValue}
            onSelect={selectLocation}
            disabled={locationPending}
            heading="Switch location"
            ariaLabel={`Location: ${locationLabel}. Switch location`}
            panelClassName="-left-12 right-0 top-full mt-1.5"
            triggerClassName={locationRowClass}
            trigger={locationRowContent}
          />
        ) : (
          <div className={staticClass(locationRowClass)}>
            {locationRowContent}
          </div>
        )}
      </div>
      {errorNotice}
      {switchOverlay}
    </div>
  );
}
