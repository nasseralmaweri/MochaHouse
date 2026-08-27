import { Injectable } from '@nestjs/common';
import type { CustomerResetPasswordRequest } from '@mocha-house/contracts';
import { requireEnv } from './require-env';
import { deriveDevRecoveryCode } from './dev-recovery-code';
import { deriveDevPasswordHash } from './dev-password-hash';
import { LocalDevCustomerDirectory } from './local-dev-customer-directory';
import type {
  CustomerPasswordRecoveryProvider,
  CustomerStartPasswordRecoveryOutcome,
  CustomerConfirmPasswordResetOutcome,
} from '../application/customer-password-recovery.types';

const DEFAULT_RECOVERY_CODE_TTL_MS = 15 * 60 * 1000;
// Same minimal stand-in as LocalDevRegistrationProvider — NOT a real
// password policy (Cognito owns that in production), only enough to
// exercise the invalid-password path in dev/tests.
const MIN_DEV_PASSWORD_LENGTH = 8;

// DEV-ONLY / TEST SEAM — see auth-provider-mode.ts for how this stays
// fail-closed in production. Deterministic test double for Cognito
// ForgotPassword / ConfirmForgotPassword: no real email, no external call.
// The recovery "code" is never generated randomly or stored — it is
// deterministically derived from the email (see deriveDevRecoveryCode) so a
// test can compute the correct one and any other 6-digit string is wrong.
// `recoveryCodeTtlMs` is a plain mutable property (Nest DI can't inject a
// bare number) that tests may lower after construction to exercise the
// expired-code path without a real clock.
@Injectable()
export class LocalDevPasswordRecoveryProvider implements CustomerPasswordRecoveryProvider {
  recoveryCodeTtlMs = DEFAULT_RECOVERY_CODE_TTL_MS;

  constructor(private readonly directory: LocalDevCustomerDirectory) {}

  startPasswordRecovery(
    email: string,
  ): Promise<CustomerStartPasswordRecoveryOutcome> {
    const normalized = email.trim().toLowerCase();
    const entry = this.directory.get(normalized);

    // Mirrors Cognito: an unknown user, or a registration that was never
    // verified, gets no recovery code. The controller normalizes this to
    // the same neutral customer response as 'initiated'.
    if (!entry || !entry.verified) {
      return Promise.resolve({ outcome: 'account-not-recoverable' });
    }

    this.directory.set(normalized, { ...entry, recoveryIssuedAt: Date.now() });
    return Promise.resolve({ outcome: 'initiated' });
  }

  confirmPasswordReset(
    request: CustomerResetPasswordRequest,
  ): Promise<CustomerConfirmPasswordResetOutcome> {
    const email = request.email.trim().toLowerCase();
    const entry = this.directory.get(email);

    if (!entry || !entry.verified) {
      return Promise.resolve({ outcome: 'invalid-recovery-state' });
    }
    // No /auth/forgot-password call precedes this one — there is no
    // outstanding code to confirm.
    if (entry.recoveryIssuedAt == null) {
      return Promise.resolve({ outcome: 'invalid-recovery-state' });
    }
    if (Date.now() - entry.recoveryIssuedAt > this.recoveryCodeTtlMs) {
      return Promise.resolve({ outcome: 'expired-code' });
    }

    const secret = requireEnv('AUTH_DEV_JWT_SECRET');
    const expectedCode = deriveDevRecoveryCode(email, secret);
    if (request.code !== expectedCode) {
      return Promise.resolve({ outcome: 'invalid-code' });
    }

    if (
      typeof request.newPassword !== 'string' ||
      request.newPassword.length < MIN_DEV_PASSWORD_LENGTH
    ) {
      return Promise.resolve({ outcome: 'invalid-password' });
    }

    this.directory.set(email, {
      ...entry,
      passwordHash: deriveDevPasswordHash(request.newPassword, secret),
      // Consume the code — a replay of the same request now fails as
      // invalid-recovery-state.
      recoveryIssuedAt: null,
    });
    return Promise.resolve({ outcome: 'success' });
  }
}
