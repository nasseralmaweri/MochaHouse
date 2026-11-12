import type { InternalSignInRequest } from '@mocha-house/contracts';

export type InternalSignInOutcome =
  | { outcome: 'success'; idToken: string; expiresInSeconds: number }
  | { outcome: 'invalid-credentials' }
  // V1 launch fix 2 — a login an administrator's invitation created: the
  // provider's temporary password was correct, and the person must now choose
  // their own (`session` is the provider's short-lived challenge handle).
  | { outcome: 'new-password-required'; session: string };

export type InternalNewPasswordOutcome =
  | { outcome: 'success'; idToken: string; expiresInSeconds: number }
  // The new password does not meet the pool's password policy.
  | { outcome: 'invalid-password' }
  // The challenge expired or is not this login's: sign in again.
  | { outcome: 'session-expired' };

// Provider-neutral internal sign-in boundary. InternalSignInService only
// ever depends on this interface — mirrors the customer boundary's
// CustomerAuthProvider and orders/infrastructure's PaymentProvider — so a
// real internal Cognito call and the dev/test stand-in are swapped without
// changing the controller or service layer.
//
// Note: signing in only proves the caller holds valid internal credentials.
// It does NOT check the Mocha House InternalUser lifecycle — that is
// InternalAuthGuard's job on every protected request. A successful sign-in
// followed by a 403 from /internal/me is the expected shape for a non-ACTIVE
// account.
export interface InternalAuthProvider {
  signIn(request: InternalSignInRequest): Promise<InternalSignInOutcome>;
  completeNewPassword(request: {
    identifier: string;
    session: string;
    newPassword: string;
  }): Promise<InternalNewPasswordOutcome>;
}
