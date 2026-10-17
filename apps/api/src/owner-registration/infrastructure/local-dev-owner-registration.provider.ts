import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { requireInternalEnv } from '../../internal-auth/infrastructure/require-internal-env';
import {
  deriveDevPasswordHash,
  devPasswordMatches,
} from '../../customer-auth/infrastructure/dev-password-hash';
import type {
  ConfirmCodeOutcome,
  ConfirmPasswordSetupOutcome,
  CreateLoginOutcome,
  OwnerRegistrationProvider,
  SendCodeOutcome,
  SetPasswordOutcome,
  VerifiedLogin,
} from '../application/owner-registration-provider';

const SIGN_UP_CODE_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_SETUP_CODE_TTL_MS = 60 * 60 * 1000;

export type DevOwnerCodePurpose = 'sign-up' | 'password-setup';

// DEV-ONLY / TEST SEAM — the stand-in for the internal Cognito pool's
// registration flow, selected only where dev staff auth is enabled
// (isDevInternalAuthEnabled: never in production). In memory; no email is
// sent. A "sent" code is derived from the email and purpose with the dev
// staff secret, so a test (or a developer) can compute it independently; it
// is never logged, stored or returned.
export function deriveDevOwnerRegistrationCode(
  email: string,
  purpose: DevOwnerCodePurpose,
  secret: string,
): string {
  const digest = createHmac('sha256', secret)
    .update(`owner-registration:${purpose}:${email.trim().toLowerCase()}`)
    .digest();
  return (digest.readUInt32BE(0) % 1_000_000).toString().padStart(6, '0');
}

interface DevLogin {
  subject: string;
  confirmed: boolean;
  passwordHash: string;
  signUpCodeIssuedAt: number | null;
  passwordSetupCodeIssuedAt: number | null;
}

// Not a real policy — enough to exercise the refusal path.
const devPasswordAcceptable = (password: string) => password.length >= 8;

@Injectable()
export class LocalDevOwnerRegistrationProvider implements OwnerRegistrationProvider {
  readonly providerName = 'internal-dev';
  private readonly logins = new Map<string, DevLogin>();

  private secret(): string {
    return requireInternalEnv('INTERNAL_AUTH_DEV_JWT_SECRET');
  }

  private codeMatches(
    email: string,
    purpose: DevOwnerCodePurpose,
    code: string,
  ): boolean {
    return (
      code === deriveDevOwnerRegistrationCode(email, purpose, this.secret())
    );
  }

  createLogin(
    email: string,
    initialPassword: string,
  ): Promise<CreateLoginOutcome> {
    if (this.logins.has(email)) return Promise.resolve({ outcome: 'exists' });
    // The same subject dev staff sign-in derives for this email, so the
    // login is the one a later dev sign-in resolves to.
    const subject = `internal-dev:${email}`;
    this.logins.set(email, {
      subject,
      confirmed: false,
      passwordHash: deriveDevPasswordHash(initialPassword, this.secret()),
      signUpCodeIssuedAt: Date.now(),
      passwordSetupCodeIssuedAt: null,
    });
    return Promise.resolve({ outcome: 'created', subject });
  }

  resendSignUpCode(email: string): Promise<SendCodeOutcome> {
    const login = this.logins.get(email);
    if (!login) return Promise.resolve({ outcome: 'not-found' });
    if (login.confirmed)
      return Promise.resolve({ outcome: 'already-confirmed' });
    login.signUpCodeIssuedAt = Date.now();
    return Promise.resolve({ outcome: 'sent' });
  }

  confirmSignUp(email: string, code: string): Promise<ConfirmCodeOutcome> {
    const login = this.logins.get(email);
    if (!login) return Promise.resolve({ outcome: 'not-found' });
    if (login.confirmed)
      return Promise.resolve({ outcome: 'already-confirmed' });
    if (!this.codeMatches(email, 'sign-up', code)) {
      return Promise.resolve({ outcome: 'invalid-code' });
    }
    if (
      login.signUpCodeIssuedAt === null ||
      Date.now() - login.signUpCodeIssuedAt > SIGN_UP_CODE_TTL_MS
    ) {
      return Promise.resolve({ outcome: 'expired-code' });
    }
    login.confirmed = true;
    login.signUpCodeIssuedAt = null;
    return Promise.resolve({ outcome: 'confirmed' });
  }

  setPassword(
    email: string,
    initialPassword: string,
    password: string,
  ): Promise<SetPasswordOutcome> {
    const login = this.logins.get(email);
    if (
      !login ||
      !login.confirmed ||
      !devPasswordMatches(initialPassword, login.passwordHash, this.secret())
    ) {
      return Promise.resolve({ outcome: 'rejected' });
    }
    if (!devPasswordAcceptable(password)) {
      return Promise.resolve({ outcome: 'invalid-password' });
    }
    login.passwordHash = deriveDevPasswordHash(password, this.secret());
    return Promise.resolve({ outcome: 'set' });
  }

  sendPasswordSetupCode(email: string): Promise<SendCodeOutcome> {
    const login = this.logins.get(email);
    if (!login || !login.confirmed) {
      return Promise.resolve({ outcome: 'not-found' });
    }
    login.passwordSetupCodeIssuedAt = Date.now();
    return Promise.resolve({ outcome: 'sent' });
  }

  confirmPasswordSetup(
    email: string,
    code: string,
    password: string,
  ): Promise<ConfirmPasswordSetupOutcome> {
    const login = this.logins.get(email);
    if (!login || !login.confirmed) {
      return Promise.resolve({ outcome: 'not-found' });
    }
    if (
      login.passwordSetupCodeIssuedAt === null ||
      !this.codeMatches(email, 'password-setup', code)
    ) {
      return Promise.resolve({ outcome: 'invalid-code' });
    }
    if (
      Date.now() - login.passwordSetupCodeIssuedAt >
      PASSWORD_SETUP_CODE_TTL_MS
    ) {
      return Promise.resolve({ outcome: 'expired-code' });
    }
    if (!devPasswordAcceptable(password)) {
      return Promise.resolve({ outcome: 'invalid-password' });
    }
    login.passwordHash = deriveDevPasswordHash(password, this.secret());
    login.passwordSetupCodeIssuedAt = null;
    return Promise.resolve({ outcome: 'set' });
  }

  signIn(email: string, password: string): Promise<VerifiedLogin | null> {
    const login = this.logins.get(email);
    if (
      !login ||
      !login.confirmed ||
      !devPasswordMatches(password, login.passwordHash, this.secret())
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      provider: this.providerName,
      subject: login.subject,
      email,
      emailVerified: true,
    });
  }

  // TEST SEAM — simulates a confirmation that happened outside this API's
  // completion request (e.g. an interrupted completion).
  confirmOutOfBand(email: string): void {
    const login = this.logins.get(email);
    if (login) login.confirmed = true;
  }
}
