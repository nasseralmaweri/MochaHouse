import type { AdminPlatformStatus } from "@mocha-house/contracts";

// Small presentation helpers for the Administration → Platform Status screen
// (Milestone 5G). The API already returns plain-language labels; these only
// turn the raw location counts into readable sentences. Read-only, no
// decisions.

function locationWord(count: number): string {
  return count === 1 ? "location" : "locations";
}

// "1 active location" / "3 active locations".
export function activeLocationsLabel(count: number): string {
  return `${count} active ${locationWord(count)}`;
}

export function inactiveLocationsLabel(count: number): string {
  return `${count} inactive ${locationWord(count)}`;
}

// "Enabled at 2 of 3 active locations" / "Enabled at every active location"
// / "No active locations yet".
export function digitalOrderingLabel(
  locations: AdminPlatformStatus["locations"],
): string {
  const { activeCount, digitalOrderingEnabledCount } = locations;
  if (activeCount === 0) {
    return "No active locations yet";
  }
  if (digitalOrderingEnabledCount === activeCount) {
    return "On at every active location";
  }
  if (digitalOrderingEnabledCount === 0) {
    return "Off at every active location";
  }
  return `On at ${digitalOrderingEnabledCount} of ${activeCount} active ${locationWord(
    activeCount,
  )}`;
}

// The rows the "Platform Status" screen renders, in order. Kept here so the
// page stays a thin layout.
export interface PlatformStatusRow {
  label: string;
  value: string;
}

export interface PlatformStatusSection {
  title: string;
  rows: PlatformStatusRow[];
}

export function platformStatusSections(
  status: AdminPlatformStatus,
): PlatformStatusSection[] {
  return [
    {
      title: "Platform",
      rows: [{ label: "Environment", value: status.environmentLabel }],
    },
    {
      title: "Authentication",
      rows: [
        { label: "Admin sign-in", value: status.authentication.adminLabel },
        {
          label: "Customer sign-in",
          value: status.authentication.customerLabel,
        },
      ],
    },
    {
      title: "Payments",
      rows: [
        {
          label: "Payment integration",
          value: status.payments.providerLabel,
        },
      ],
    },
    {
      title: "Locations & digital ordering",
      rows: [
        {
          label: "Active locations",
          value: activeLocationsLabel(status.locations.activeCount),
        },
        {
          label: "Inactive locations",
          value: inactiveLocationsLabel(status.locations.inactiveCount),
        },
        {
          label: "Digital ordering",
          value: digitalOrderingLabel(status.locations),
        },
      ],
    },
  ];
}
