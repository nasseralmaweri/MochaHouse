import { Injectable } from '@nestjs/common';

export interface DevCustomerRecord {
  subject: string;
  displayName: string | null;
  // Reset by both register() and resendVerification() — the verification
  // code's acceptance window is always measured from the most recent of the
  // two, exactly like a real "resend" giving you a fresh code/expiry.
  issuedAt: number;
  verified: boolean;
  // Non-reversible HMAC of the password (see dev-password-hash.ts), set at
  // registration and replaced on a successful password reset. Never the
  // plaintext password, never logged. Absent for any identifier that never
  // went through /auth/register — sign-in skips the password check entirely
  // for those, preserving every pre-existing dev sign-in test that signs in
  // an unregistered identifier with an arbitrary password.
  passwordHash?: string | null;
  // When /auth/forgot-password was last called for this account. null (or
  // absent) means no recovery code is outstanding — a reset attempt in that
  // state is rejected as invalid-recovery-state. Cleared again on a
  // successful reset so a code cannot be replayed.
  recoveryIssuedAt?: number | null;
}

// DEV-ONLY / TEST SEAM — see auth-provider-mode.ts for how this stays
// fail-closed in production. In-memory only: bookkeeping for the dev
// registration / verification / password-recovery stand-ins, never a
// production credential store. It holds a subject, a display name, a
// verification timestamp/flag, a non-reversible password hash, and a
// recovery-request timestamp — never a plaintext password and never a
// recovery code. Shared (via Nest DI) between LocalDevRegistrationProvider
// (register/verify/resend), LocalDevPasswordRecoveryProvider
// (forgot/reset), and LocalDevAuthProvider (sign-in), so sign-in can
// enforce verification and the current password the same way Cognito's
// UserNotConfirmedException / password check already do in production —
// without requiring every existing dev sign-in test to have registered
// first: an identifier this directory has never seen is untouched by
// either check.
@Injectable()
export class LocalDevCustomerDirectory {
  private readonly entries = new Map<string, DevCustomerRecord>();

  get(email: string): DevCustomerRecord | undefined {
    return this.entries.get(normalize(email));
  }

  set(email: string, entry: DevCustomerRecord): void {
    this.entries.set(normalize(email), entry);
  }
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}
