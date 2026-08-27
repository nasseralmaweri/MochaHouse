import { Injectable } from '@nestjs/common';

export interface DevPendingRegistration {
  subject: string;
  displayName: string | null;
  // Reset by both register() and resendVerification() — the code's
  // acceptance window is always measured from the most recent of the two,
  // exactly like a real "resend" giving you a fresh code/expiry.
  issuedAt: number;
  verified: boolean;
}

// DEV-ONLY / TEST SEAM — see auth-provider-mode.ts for how this stays
// fail-closed in production. In-memory only: this is bookkeeping for the
// dev registration/verification stand-in, never a production credential
// store — no password is ever held here, only a subject, a display name,
// and a verification timestamp/flag. Shared (via Nest DI) between
// LocalDevRegistrationProvider (register/verify/resend) and
// LocalDevAuthProvider (sign-in), so sign-in can correctly refuse an
// unverified registration the same way Cognito's UserNotConfirmedException
// already does in production — without requiring every existing dev
// sign-in test to have called /auth/register first: an identifier this
// directory has never seen is untouched by this check.
@Injectable()
export class LocalDevCustomerDirectory {
  private readonly entries = new Map<string, DevPendingRegistration>();

  get(email: string): DevPendingRegistration | undefined {
    return this.entries.get(normalize(email));
  }

  set(email: string, entry: DevPendingRegistration): void {
    this.entries.set(normalize(email), entry);
  }
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}
