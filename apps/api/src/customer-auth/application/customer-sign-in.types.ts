import type { CustomerSignInRequest } from '@mocha-house/contracts';

export type CustomerSignInOutcome =
  | { outcome: 'success'; idToken: string; expiresInSeconds: number }
  | { outcome: 'invalid-credentials' };

// Provider-neutral sign-in boundary. CustomerSignInService only ever
// depends on this interface — mirrors orders/infrastructure's
// PaymentProvider pattern — so a real Cognito call and the dev/test stand-in
// can be swapped without changing the controller or service layer.
export interface CustomerAuthProvider {
  signIn(request: CustomerSignInRequest): Promise<CustomerSignInOutcome>;
}
