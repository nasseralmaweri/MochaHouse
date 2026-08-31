import type {
  AdminAuditActivityType,
  AdminAuditEventSummary,
} from '@mocha-house/contracts';

// The ONE place a stored InternalAuditEvent becomes a plain-language
// activity for the Admin Activity Log (Milestone 5F). It is a PRESENTATION
// layer only — it reads audit rows, it never writes them, and it never
// leaks a raw `action` string, a `targetType`, a UUID, or any before/after
// JSON.
//
// The `action` column is a free string and future actions may be persisted
// that this build does not know about, so every path here is runtime-safe:
// a known action with a well-formed payload gets a proper business
// sentence; anything else (unknown action, or a known action whose payload
// is missing/malformed) gets a safe generic projection.

// The audit actions this build understands, each mapped to a business
// activity type. Adding a key here is a compile-checked, single-site change.
const KNOWN_ACTION_TO_ACTIVITY = {
  'user.status_changed': 'admin_access_status_changed',
  'user.role_assigned': 'admin_access_granted',
  'user.role_removed': 'admin_access_removed',
} as const satisfies Record<string, AdminAuditActivityType>;

type KnownAuditAction = keyof typeof KNOWN_ACTION_TO_ACTIVITY;

// The reverse map the API uses to translate a business filter value back to
// the stored action string — clients never send raw action strings.
export const ACTIVITY_TYPE_TO_ACTION: Record<
  AdminAuditActivityType,
  KnownAuditAction
> = {
  admin_access_status_changed: 'user.status_changed',
  admin_access_granted: 'user.role_assigned',
  admin_access_removed: 'user.role_removed',
};

export const ADMIN_AUDIT_ACTIVITY_TYPES: readonly AdminAuditActivityType[] = [
  'admin_access_status_changed',
  'admin_access_granted',
  'admin_access_removed',
];

export function isAdminAuditActivityType(
  value: string,
): value is AdminAuditActivityType {
  return (ADMIN_AUDIT_ACTIVITY_TYPES as readonly string[]).includes(value);
}

// Friendly labels for the internal-user statuses that can appear in a
// status-change audit payload.
const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  DISABLED: 'Disabled',
  INVITED: 'Invited',
};

// The verb comes from the NEW status: someone was suspended / reactivated /
// disabled.
const STATUS_VERB: Record<string, string> = {
  ACTIVE: 'reactivated',
  SUSPENDED: 'suspended',
  DISABLED: 'disabled',
};

export interface RawAuditEvent {
  id: string;
  action: string;
  createdAt: Date;
  reason: string;
  beforeData: unknown;
  afterData: unknown;
}

export interface ResolvedParticipants {
  actor: { id: string; name: string; email: string };
  // The current display label for the person the activity was about, already
  // resolved (falls back to a safe generic when the target cannot be found).
  subjectLabel: string;
}

// Build the business-facing summary for one audit row. Never throws.
export function projectAuditEvent(
  event: RawAuditEvent,
  participants: ResolvedParticipants,
): AdminAuditEventSummary {
  const base = {
    id: event.id,
    occurredAt: event.createdAt.toISOString(),
    actor: participants.actor,
    subject: { kind: 'admin_user' as const, label: participants.subjectLabel },
    reason: event.reason,
  };

  const generic = (): AdminAuditEventSummary => ({
    ...base,
    activityType: 'other',
    activityLabel: `${participants.actor.name} made an administrative change`,
    location: null,
    details: [],
  });

  if (!isKnownAction(event.action)) {
    return generic();
  }

  if (event.action === 'user.status_changed') {
    const after = readStatus(event.afterData);
    if (!after) {
      return generic();
    }
    const before = readStatus(event.beforeData);
    const verb = STATUS_VERB[after] ?? 'changed';
    const details: { label: string; value: string }[] = [];
    if (before) {
      details.push({
        label: 'Previous access state',
        value: STATUS_LABEL[before] ?? before,
      });
    }
    details.push({
      label: 'New access state',
      value: STATUS_LABEL[after] ?? after,
    });
    return {
      ...base,
      activityType: 'admin_access_status_changed',
      activityLabel: `${participants.actor.name} ${verb} ${participants.subjectLabel}'s Admin access`,
      location: null,
      details,
    };
  }

  // user.role_assigned / user.role_removed
  const isRemoval = event.action === 'user.role_removed';
  const snapshot = readAssignment(
    isRemoval ? event.beforeData : event.afterData,
  );
  if (!snapshot) {
    return generic();
  }
  const where =
    snapshot.scope === 'LOCATION' && snapshot.locationName
      ? `for ${snapshot.locationName}`
      : snapshot.scope === 'CORPORATE'
        ? 'for all locations'
        : 'for a location';
  const label = isRemoval
    ? `${participants.actor.name} removed ${participants.subjectLabel}'s ${snapshot.roleDisplayName} access ${where}`
    : `${participants.actor.name} gave ${participants.subjectLabel} ${snapshot.roleDisplayName} access ${where}`;
  return {
    ...base,
    activityType: isRemoval ? 'admin_access_removed' : 'admin_access_granted',
    activityLabel: label,
    location:
      snapshot.scope === 'LOCATION' && snapshot.locationName
        ? { name: snapshot.locationName }
        : null,
    details: [],
  };
}

function isKnownAction(action: string): action is KnownAuditAction {
  return action in KNOWN_ACTION_TO_ACTIVITY;
}

function readStatus(data: unknown): string | null {
  if (data && typeof data === 'object' && 'status' in data) {
    const status = (data as { status: unknown }).status;
    return typeof status === 'string' ? status : null;
  }
  return null;
}

function readAssignment(data: unknown): {
  roleDisplayName: string;
  scope: string;
  locationName?: string;
} | null {
  if (!data || typeof data !== 'object' || !('assignment' in data)) {
    return null;
  }
  const assignment = (data as { assignment: unknown }).assignment;
  if (!assignment || typeof assignment !== 'object') {
    return null;
  }
  const record = assignment as Record<string, unknown>;
  if (
    typeof record.roleDisplayName !== 'string' ||
    typeof record.scope !== 'string'
  ) {
    return null;
  }
  return {
    roleDisplayName: record.roleDisplayName,
    scope: record.scope,
    locationName:
      typeof record.locationName === 'string' ? record.locationName : undefined,
  };
}
