import { Injectable } from '@nestjs/common';
import type {
  CustomerRegisterRequest,
  CustomerVerifyRequest,
} from '@mocha-house/contracts';
import { requireEnv } from './require-env';
import { deriveDevVerificationCode } from './dev-verification-code';
import { deriveDevPasswordHash } from './dev-password-hash';
import { LocalDevCustomerDirectory } from './local-dev-customer-directory';
import type {
  CustomerRegistrationProvider,
  CustomerRegistrationOutcome,
  CustomerVerificationOutcome,
  CustomerResendOutcome,
} from '../application/customer-registration.types';

const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000;

// DEV-ONLY / TEST SEAM — see auth-provider-mode.ts for how this stays
// fail-closed in production. Deterministic test double for Cognito
// registration/verification: no real password policy, no external call,
// no email actually sent — the auth-boundary equivalent of
// FakePaymentProvider and LocalDevAuthProvider. The verification "code" is
// never generated randomly or stored: it's deterministically derived from
// the email (see deriveDevVerificationCode) so a test can compute the
// correct code independently, and an incorrect one is simply any other
// 6-digit string. `codeTtlMs` is a plain mutable property (not a
// constructor param — Nest's DI can't resolve a bare `number`) that tests
// may lower after construction purely to exercise the expired-code path
// quickly, without waiting on a real clock or faking timers.
@Injectable()
export class LocalDevRegistrationProvider implements CustomerRegistrationProvider {
  codeTtlMs = DEFAULT_CODE_TTL_MS;

  constructor(private readonly directory: LocalDevCustomerDirectory) {}

  register(
    request: CustomerRegisterRequest,
  ): Promise<CustomerRegistrationOutcome> {
    const email = request.email.trim().toLowerCase();

    if (this.directory.get(email)) {
      return Promise.resolve({ outcome: 'already-exists' });
    }
    // Not a real password policy — just enough to exercise the
    // invalid-password outcome in dev/tests without touching Cognito.
    if (typeof request.password !== 'string' || request.password.length < 8) {
      return Promise.resolve({ outcome: 'invalid-password' });
    }

    const secret = requireEnv('AUTH_DEV_JWT_SECRET');
    const subject = `dev:${email}`;
    this.directory.set(email, {
      subject,
      displayName: request.displayName?.trim() || null,
      issuedAt: Date.now(),
      verified: false,
      // Stored as a non-reversible hash only so a later dev sign-in can
      // tell this password from one set by a subsequent password reset —
      // see dev-password-hash.ts. Never the plaintext, never logged.
      passwordHash: deriveDevPasswordHash(request.password, secret),
      recoveryIssuedAt: null,
    });

    return Promise.resolve({ outcome: 'success', provider: 'dev', subject });
  }

  verify(request: CustomerVerifyRequest): Promise<CustomerVerificationOutcome> {
    const email = request.email.trim().toLowerCase();
    const entry = this.directory.get(email);

    if (!entry) {
      return Promise.resolve({ outcome: 'not-found' });
    }
    if (entry.verified) {
      return Promise.resolve({ outcome: 'already-verified' });
    }
    if (Date.now() - entry.issuedAt > this.codeTtlMs) {
      return Promise.resolve({ outcome: 'expired-code' });
    }

    const secret = requireEnv('AUTH_DEV_JWT_SECRET');
    const expectedCode = deriveDevVerificationCode(email, secret);
    if (request.code !== expectedCode) {
      return Promise.resolve({ outcome: 'invalid-code' });
    }

    this.directory.set(email, { ...entry, verified: true });
    return Promise.resolve({ outcome: 'success' });
  }

  resendVerification(email: string): Promise<CustomerResendOutcome> {
    const normalized = email.trim().toLowerCase();
    const entry = this.directory.get(normalized);

    if (!entry) {
      return Promise.resolve({ outcome: 'not-found' });
    }
    if (entry.verified) {
      return Promise.resolve({ outcome: 'already-verified' });
    }

    // The code itself is re-derived from the same email, so "resending"
    // is really just resetting the acceptance window.
    this.directory.set(normalized, { ...entry, issuedAt: Date.now() });
    return Promise.resolve({ outcome: 'sent' });
  }
}
