import type { PlatformChallengeRecord } from './platform-challenge-store';

// SC1b — what a platform sign-in provider (dedicated Cognito pool, or the
// local/test dev provider) can answer. Providers never decide authorization:
// PlatformSignInService re-verifies every issued token and requires an
// ACTIVE PlatformOperator before a session exists.

export type PlatformSignInStart =
  // Password accepted; a second factor is REQUIRED before any token.
  | { outcome: 'challenge'; record: PlatformChallengeRecord }
  | { outcome: 'invalid-credentials' }
  // The pool user cannot sign in yet (temporary password, forced reset):
  // an administrator must finish the account first.
  | { outcome: 'account-setup-required' };

export type PlatformSignInCompletion =
  | { outcome: 'authenticated'; idToken: string; expiresInSeconds: number }
  // Wrong, expired or reused code — the attempt is over.
  | { outcome: 'invalid-code' };

export interface PlatformSignInProvider {
  start(email: string, password: string): Promise<PlatformSignInStart>;
  respondToMfa(
    record: PlatformChallengeRecord,
    code: string,
  ): Promise<PlatformSignInCompletion>;
  // First sign-in: associate an authenticator. Returns the base32 secret to
  // show the operator ONCE, and the record to continue with.
  beginMfaSetup(
    record: PlatformChallengeRecord,
  ): Promise<{ secret: string; record: PlatformChallengeRecord }>;
  completeMfaSetup(
    record: PlatformChallengeRecord,
    code: string,
  ): Promise<PlatformSignInCompletion>;
}

// Thrown when the identity provider answers in a way that must never lead
// to a session (e.g. tokens WITHOUT the MFA step, an unknown challenge, an
// unexpected response). Mapped to a generic 503 — fail closed.
export class PlatformSignInRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformSignInRefusedError';
  }
}
