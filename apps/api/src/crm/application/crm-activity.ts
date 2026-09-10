import type { AdminCustomerActivityItem } from '@mocha-house/contracts';

// Milestone 8A — project the polymorphic InternalAuditEvent rows whose
// targetType is 'customer' into the CRM activity timeline. Pure: no DB, no
// framework. The raw `action` string and target ids are never exposed — the
// UI gets a rendered human sentence and the (already-required) reason.

interface AuditRowForActivity {
  id: string;
  action: string;
  reason: string;
  createdAt: Date;
  afterData: unknown;
  actorInternalUser: { displayName: string | null; email: string } | null;
}

function actorLabel(
  actor: { displayName: string | null; email: string } | null,
): string | null {
  if (!actor) {
    return null;
  }
  return actor.displayName ?? actor.email;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function toCustomerActivityItem(
  row: AuditRowForActivity,
): AdminCustomerActivityItem {
  const after =
    row.afterData !== null && typeof row.afterData === 'object'
      ? (row.afterData as Record<string, unknown>)
      : {};

  let summary: string;
  switch (row.action) {
    case 'loyalty.beans_adjusted': {
      const delta = asNumber(after.delta);
      if (delta === null) {
        summary = 'Mocha Bean balance was manually adjusted';
      } else {
        summary =
          delta >= 0
            ? `${delta} Mocha Beans added manually`
            : `${Math.abs(delta)} Mocha Beans deducted manually`;
      }
      break;
    }
    case 'crm.note_added':
      summary = 'Internal CRM note added';
      break;
    default:
      // A future customer-targeted audit action — render something safe
      // rather than leaking the raw action string.
      summary = 'Customer record updated';
      break;
  }

  return {
    id: row.id,
    summary,
    reason: row.reason.length > 0 ? row.reason : null,
    actorLabel: actorLabel(row.actorInternalUser),
    createdAt: row.createdAt.toISOString(),
  };
}
