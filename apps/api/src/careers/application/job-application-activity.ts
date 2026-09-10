import type { AdminJobApplicationActivityItem } from '@mocha-house/contracts';

// Milestone 8C — project the polymorphic InternalAuditEvent rows whose
// targetType is 'job_application' into the applicant activity timeline.
// Pure. Never exposes the raw action string, target ids, or any answer /
// PII — only a rendered sentence + actor + date.

interface AuditRowForActivity {
  id: string;
  action: string;
  createdAt: Date;
  beforeData: unknown;
  afterData: unknown;
  actorInternalUser: { displayName: string | null; email: string } | null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function toJobApplicationActivityItem(
  row: AuditRowForActivity,
): AdminJobApplicationActivityItem {
  const before =
    row.beforeData && typeof row.beforeData === 'object'
      ? (row.beforeData as Record<string, unknown>)
      : {};
  const after =
    row.afterData && typeof row.afterData === 'object'
      ? (row.afterData as Record<string, unknown>)
      : {};

  let summary: string;
  switch (row.action) {
    case 'applicants.application_status_changed': {
      const from = asString(before.status);
      const to = asString(after.status);
      summary =
        from && to
          ? `Status changed from ${from} to ${to}`
          : 'Status changed';
      break;
    }
    case 'applicants.note_added':
      summary = 'Internal note added';
      break;
    default:
      summary = 'Application updated';
      break;
  }

  return {
    id: row.id,
    summary,
    actorLabel: row.actorInternalUser
      ? row.actorInternalUser.displayName ?? row.actorInternalUser.email
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}
