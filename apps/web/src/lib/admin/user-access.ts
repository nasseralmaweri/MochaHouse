import type {
  AdminUserLocationAccess,
  InternalUserStatus,
} from "@mocha-house/contracts";

// Plain-language presentation helpers for the Administration → Users screens
// (Milestone 5E-1). Read-only: nothing here implies an action can be taken.

const STATUS_LABEL: Record<InternalUserStatus, string> = {
  INVITED: "Invited",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  DISABLED: "Disabled",
};

export function userStatusLabel(status: InternalUserStatus): string {
  return STATUS_LABEL[status];
}

// Maps to the shared StatusBadge tones. Active reads positive; Suspended is
// a warning (temporary lock); Invited and Disabled are neutral.
export function userStatusTone(
  status: InternalUserStatus,
): "neutral" | "positive" | "warning" {
  if (status === "ACTIVE") {
    return "positive";
  }
  if (status === "SUSPENDED") {
    return "warning";
  }
  return "neutral";
}

export function accessLevelsLabel(accessLevels: string[]): string {
  return accessLevels.length === 0
    ? "No access assigned"
    : accessLevels.join(", ");
}

// "0 people" / "1 person" / "N people" — for the Access Levels screens
// (Milestone 5E-2).
export function peopleCountLabel(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

// Compact, business-friendly. Names for up to two locations; a count beyond
// that.
export function locationAccessLabel(access: AdminUserLocationAccess): string {
  if (access.kind === "all") {
    return "All locations";
  }
  if (access.kind === "none") {
    return "No location access";
  }
  const names = access.locations.map((location) => location.name);
  if (names.length <= 2) {
    return names.join(", ");
  }
  return `${names.length} locations`;
}
