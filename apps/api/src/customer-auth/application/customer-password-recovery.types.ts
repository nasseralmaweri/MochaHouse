import type { CustomerResetPasswordRequest } from '@mocha-house/contracts';

// Outcome of starting password recovery. Both terminal values are
// deliberately non-committal about whether the account exists — the
// controller maps *both* to the same neutral customer response (see
// AuthController.forgotPassword). A true provider/system failure is NOT an
// outcome here: the provider throws (ServiceUnavailableException) so it
// stays visible to monitoring and is never silently reported as success.
export type CustomerStartPasswordRecoveryOutcome =
  // The provider accepted the request and (for a real, recoverable account)
  // a recovery code is on its way.
  | { outcome: 'initiated' }
  // No recoverable account for this email — unknown user, or a user the
  // provider will not send a recovery code to (e.g. an unconfirmed
  // registration; Cognito refuses these). Normalized, never surfaced
  // distinctly to the customer.
  | { outcome: 'account-not-recoverable' };

export type CustomerConfirmPasswordResetOutcome =
  | { outcome: 'success' }
  | { outcome: 'invalid-code' }
  | { outcome: 'expired-code' }
  // The new password was rejected by the provider's authoritative password
  // policy (Cognito owns this; the dev seam applies only a minimal
  // stand-in check).
  | { outcome: 'invalid-password' }
  // No usable recovery state for this email — unknown user, or no recovery
  // code was ever requested. Mapped to a neutral 400 by the controller
  // (never a 404), so it cannot be used to tell a registered email from an
  // unregistered one.
  | { outcome: 'invalid-recovery-state' };

// Provider-neutral password-recovery boundary — mirrors
// CustomerRegistrationProvider / CustomerAuthProvider. One implementation
// calls real Cognito (ForgotPassword / ConfirmForgotPassword); the
// dev/test stand-in shares the same shape so CustomerPasswordRecoveryService
// never needs to know which is live. Mocha House never generates, stores,
// or delivers the recovery code, and never stores the password.
export interface CustomerPasswordRecoveryProvider {
  startPasswordRecovery(
    email: string,
  ): Promise<CustomerStartPasswordRecoveryOutcome>;
  confirmPasswordReset(
    request: CustomerResetPasswordRequest,
  ): Promise<CustomerConfirmPasswordResetOutcome>;
}
