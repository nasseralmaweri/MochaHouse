import type { InternalSignInRequest } from '@mocha-house/contracts';

export type InternalSignInOutcome =
  | { outcome: 'success'; idToken: string; expiresInSeconds: number }
  | { outcome: 'invalid-credentials' };

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
}
