import type { InternalUserStatus } from '@mocha-house/contracts';

// The one place the internal-user status lifecycle is encoded for the
// Administration status-management endpoint (Milestone 5E-3).
//
//   ACTIVE      <-> SUSPENDED     (reversible temporary lock)
//   ACTIVE / SUSPENDED -> DISABLED (terminal — never re-enabled here)
//   INVITED     -> nothing         (invitation / activation is a later slice)
//
// This endpoint never SETS or LEAVES a user at INVITED.
const ALLOWED: Record<InternalUserStatus, InternalUserStatus[]> = {
  ACTIVE: ['SUSPENDED', 'DISABLED'],
  SUSPENDED: ['ACTIVE', 'DISABLED'],
  DISABLED: [],
  INVITED: [],
};

// The statuses this endpoint may be asked to set. INVITED is intentionally
// absent.
export const SETTABLE_STATUSES: readonly InternalUserStatus[] = [
  'ACTIVE',
  'SUSPENDED',
  'DISABLED',
];

export type StatusTransitionCheck =
  | { ok: true }
  // A request for a status this endpoint cannot set at all (INVITED, or a
  // non-status value). 400.
  | { ok: false; kind: 'unsupported-status'; message: string }
  // current === next. 409 — never silently succeed on a no-op.
  | { ok: false; kind: 'no-op'; message: string }
  // A real status, but not a legal move from the current one. 400.
  | { ok: false; kind: 'illegal-transition'; message: string };

const STATUS_LABEL: Record<InternalUserStatus, string> = {
  INVITED: 'invited',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  DISABLED: 'disabled',
};

export function checkStatusTransition(
  current: InternalUserStatus,
  next: string,
): StatusTransitionCheck {
  if (!SETTABLE_STATUSES.includes(next as InternalUserStatus)) {
    return {
      ok: false,
      kind: 'unsupported-status',
      message:
        'Status must be one of: active, suspended, disabled.',
    };
  }
  const target = next as InternalUserStatus;

  if (current === target) {
    return {
      ok: false,
      kind: 'no-op',
      message: `This person is already ${STATUS_LABEL[current]}.`,
    };
  }

  if (!ALLOWED[current].includes(target)) {
    if (current === 'DISABLED') {
      return {
        ok: false,
        kind: 'illegal-transition',
        message: "A disabled account can't be reactivated here.",
      };
    }
    if (current === 'INVITED') {
      return {
        ok: false,
        kind: 'illegal-transition',
        message: "This person hasn't activated their access yet.",
      };
    }
    return {
      ok: false,
      kind: 'illegal-transition',
      message: "That status change isn't allowed.",
    };
  }

  return { ok: true };
}

// Whether the move takes an ACTIVE person out of active access — the only
// case the last-administrator protection needs to run for.
export function removesActiveAccess(
  current: InternalUserStatus,
  next: InternalUserStatus,
): boolean {
  return current === 'ACTIVE' && (next === 'SUSPENDED' || next === 'DISABLED');
}
