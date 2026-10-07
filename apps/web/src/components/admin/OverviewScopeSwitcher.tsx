"use client";

import { useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { LocationSummary } from "@mocha-house/contracts";
import { CORPORATE_LOCATION_VALUE } from "@/lib/admin/location-context";
import { shortLocationName } from "@/lib/admin/overview";
import { setAdminLocationPreference } from "@/lib/internal-auth/admin-location";
import { Listbox, type ListboxOption } from "@/components/centerivo/Listbox";
import {
  IconAllLocations,
  IconBusiness,
  IconChevronsUpDown,
  IconLocations,
  IconSpinner,
} from "@/components/centerivo/Icons";

// The Overview's own scope control: Company-wide, or one authorized
// location. It uses the same preference mechanism as the shell's location
// row (validated server-side, URL wins), but it is presented as the page's
// scope — "what am I looking at" — rather than as a global filter. Options
// come only from the authorization-aware set; a person with a single scope
// sees a static label.
export function OverviewScopeSwitcher({
  locations,
  isCorporate,
  currentValue,
  businessName,
}: {
  locations: LocationSummary[];
  isCorporate: boolean;
  currentValue: string;
  businessName: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const options: ListboxOption[] = [
    ...(isCorporate
      ? [
          {
            value: CORPORATE_LOCATION_VALUE,
            label: "Company-wide",
            description: "Every location",
            icon: <IconBusiness className="h-4 w-4" />,
          },
        ]
      : []),
    ...locations.map((location) => ({
      value: location.id,
      label: shortLocationName(location.name, businessName),
      icon: <IconLocations className="h-4 w-4" />,
    })),
  ];

  const current = options.find((o) => o.value === currentValue);
  const label = current?.label ?? "Choose a scope";
  const isCompany = currentValue === CORPORATE_LOCATION_VALUE;
  const icon = isCompany ? (
    <IconAllLocations className="h-4 w-4" />
  ) : (
    <IconLocations className="h-4 w-4" />
  );

  const content = (
    <>
      <span className="text-text-muted">{icon}</span>
      <span className="truncate font-medium text-text-primary">{label}</span>
    </>
  );

  if (options.length <= 1) {
    return (
      <span className="inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm">
        {content}
      </span>
    );
  }

  function select(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("location", value);
    startTransition(() => {
      void setAdminLocationPreference(value);
      router.push(`/admin?${params.toString()}`);
    });
  }

  return (
    <Listbox
      options={options}
      value={currentValue}
      onSelect={select}
      disabled={pending}
      heading="View overview for"
      ariaLabel={`Overview scope: ${label}. Change scope`}
      panelClassName="right-0 top-full mt-1.5"
      triggerClassName="group flex h-10 max-w-full items-center gap-2 rounded-lg border border-border-default bg-surface-card px-3 text-sm transition-colors hover:border-text-muted/50 disabled:cursor-default"
      trigger={
        <>
          {content}
          {pending ? (
            <IconSpinner className="h-4 w-4 text-text-muted" />
          ) : (
            <IconChevronsUpDown className="h-4 w-4 text-text-muted" />
          )}
        </>
      }
    />
  );
}
