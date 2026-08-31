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

// One concise sentence describing what a status means, for the user detail
// screen (Milestone 5E-3). Does not imply an action can be taken.
const STATUS_SENTENCE: Record<InternalUserStatus, string> = {
  ACTIVE: "Can use the Admin according to their assigned access.",
  SUSPENDED: "Access is temporarily paused.",
  DISABLED: "This account can no longer use the Admin.",
  INVITED: "Access has not been activated yet.",
};

export function userStatusSentence(status: InternalUserStatus): string {
  return STATUS_SENTENCE[status];
}

// --- Status actions (Milestone 5E-3) ---------------------------------
// The explicit business actions available from a target's current status.
// DISABLED and INVITED offer none. Never a raw enum dropdown.
export type UserStatusActionKey = "suspend" | "reactivate" | "disable";

export interface UserStatusAction {
  key: UserStatusActionKey;
  label: string;
  targetStatus: "ACTIVE" | "SUSPENDED" | "DISABLED";
}

export function userStatusActions(
  status: InternalUserStatus,
): UserStatusAction[] {
  if (status === "ACTIVE") {
    return [
      { key: "suspend", label: "Suspend access", targetStatus: "SUSPENDED" },
      { key: "disable", label: "Disable account", targetStatus: "DISABLED" },
    ];
  }
  if (status === "SUSPENDED") {
    return [
      { key: "reactivate", label: "Reactivate", targetStatus: "ACTIVE" },
      { key: "disable", label: "Disable account", targetStatus: "DISABLED" },
    ];
  }
  return [];
}

// Whether the status-action UI should render at all: the actor can manage
// status, is not looking at their own record, and the target has at least
// one available action. Security is still enforced server-side.
export function canShowStatusActions(input: {
  hasManageStatusPermission: boolean;
  isSelf: boolean;
  status: InternalUserStatus;
}): boolean {
  return (
    input.hasManageStatusPermission &&
    !input.isSelf &&
    userStatusActions(input.status).length > 0
  );
}

// A reason is required for every status change: trimmed, non-empty, and no
// longer than the server accepts.
export const STATUS_REASON_MAX_LENGTH = 1000;

export type ReasonCheck =
  | { ok: true; reason: string }
  | { ok: false; error: string };

export function checkStatusChangeReason(raw: string): ReasonCheck {
  const reason = raw.trim();
  if (reason.length === 0) {
    return { ok: false, error: "Enter a reason." };
  }
  if (reason.length > STATUS_REASON_MAX_LENGTH) {
    return {
      ok: false,
      error: `Keep the reason under ${STATUS_REASON_MAX_LENGTH} characters.`,
    };
  }
  return { ok: true, reason };
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
