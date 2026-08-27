import type {
  CustomerRegisterRequest,
  CustomerVerifyRequest,
} from '@mocha-house/contracts';

export type CustomerRegistrationOutcome =
  | { outcome: 'success'; provider: string; subject: string }
  | { outcome: 'already-exists' }
  | { outcome: 'invalid-password' }
  | { outcome: 'invalid-input' };

export type CustomerVerificationOutcome =
  | { outcome: 'success' }
  | { outcome: 'already-verified' }
  | { outcome: 'invalid-code' }
  | { outcome: 'expired-code' }
  | { outcome: 'not-found' };

export type CustomerResendOutcome =
  | { outcome: 'sent' }
  | { outcome: 'already-verified' }
  | { outcome: 'not-found' };

// Provider-neutral registration boundary — mirrors CustomerAuthProvider
// (sign-in). One implementation calls real Cognito (SignUp/ConfirmSignUp/
// ResendConfirmationCode); the dev/test stand-in shares the same shape so
// CustomerRegistrationService never needs to know which is running.
export interface CustomerRegistrationProvider {
  register(
    request: CustomerRegisterRequest,
  ): Promise<CustomerRegistrationOutcome>;
  verify(request: CustomerVerifyRequest): Promise<CustomerVerificationOutcome>;
  resendVerification(email: string): Promise<CustomerResendOutcome>;
}
