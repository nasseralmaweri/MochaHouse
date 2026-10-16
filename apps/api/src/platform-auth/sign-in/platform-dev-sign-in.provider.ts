import { timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { signPlatformDevJwt } from '../infrastructure/platform-dev-jwt';
import { requirePlatformEnv } from '../infrastructure/platform-config';
import type { PlatformChallengeRecord } from './platform-challenge-store';
import {
  PlatformSignInRefusedError,
  type PlatformSignInCompletion,
  type PlatformSignInProvider,
  type PlatformSignInStart,
} from './platform-sign-in.types';
import { decodeBase32, verifyTotp } from './platform-totp';

const TOKEN_TTL_SECONDS = 3600;

// DEV-ONLY / TEST SEAM — selected only where isDevPlatformAuthEnabled() is
// true (a verified safe development context AND PLATFORM_AUTH_PROVIDER=dev);
// production refuses that configuration at startup and never reaches here.
//
// A deterministic stand-in for the platform pool that still enforces BOTH
// factors:
//   - password: PLATFORM_AUTH_DEV_PASSWORD when set (constant-time compare);
//     otherwise any non-empty password (there is no local credential store);
//   - second factor: ALWAYS a real RFC 6238 TOTP code for
//     PLATFORM_AUTH_DEV_TOTP_SECRET (base32). Without that secret the dev
//     sign-in fails closed.
// PLATFORM_AUTH_DEV_MFA_ENROLLMENT=1 makes every sign-in a first-time
// enrolment (the authenticator secret shown is the same dev secret), so the
// enrolment screens can be exercised locally.
//
// The token it mints is the SC1a platform dev token (subject
// "platform-dev:<email>", mfa: true). It proves nothing about authorization:
// PlatformSignInService still requires an ACTIVE PlatformOperator.
@Injectable()
export class PlatformDevSignInProvider implements PlatformSignInProvider {
  start(email: string, password: string): Promise<PlatformSignInStart> {
    // Fail closed early when the second factor is not configured.
    this.totpSecret();
    const expected = process.env.PLATFORM_AUTH_DEV_PASSWORD;
    if (expected) {
      const a = Buffer.from(password);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return Promise.resolve({ outcome: 'invalid-credentials' });
      }
    }
    return Promise.resolve({
      outcome: 'challenge',
      record: {
        provider: 'dev',
        kind:
          process.env.PLATFORM_AUTH_DEV_MFA_ENROLLMENT === '1'
            ? 'mfa-setup'
            : 'mfa',
        username: email,
        cognitoSession: null,
        secretIssued: false,
      },
    });
  }

  respondToMfa(
    record: PlatformChallengeRecord,
    code: string,
  ): Promise<PlatformSignInCompletion> {
    if (record.provider !== 'dev' || record.kind !== 'mfa') {
      throw new PlatformSignInRefusedError('Not a dev MFA challenge.');
    }
    return Promise.resolve(this.complete(record, code));
  }

  beginMfaSetup(
    record: PlatformChallengeRecord,
  ): Promise<{ secret: string; record: PlatformChallengeRecord }> {
    if (record.provider !== 'dev' || record.kind !== 'mfa-setup') {
      throw new PlatformSignInRefusedError('Not a dev enrolment challenge.');
    }
    return Promise.resolve({
      secret: requirePlatformEnv('PLATFORM_AUTH_DEV_TOTP_SECRET'),
      record: { ...record, secretIssued: true },
    });
  }

  completeMfaSetup(
    record: PlatformChallengeRecord,
    code: string,
  ): Promise<PlatformSignInCompletion> {
    if (
      record.provider !== 'dev' ||
      record.kind !== 'mfa-setup' ||
      !record.secretIssued
    ) {
      throw new PlatformSignInRefusedError('No dev enrolment in progress.');
    }
    return Promise.resolve(this.complete(record, code));
  }

  private totpSecret(): Buffer {
    return decodeBase32(requirePlatformEnv('PLATFORM_AUTH_DEV_TOTP_SECRET'));
  }

  private complete(
    record: PlatformChallengeRecord,
    code: string,
  ): PlatformSignInCompletion {
    if (!verifyTotp(this.totpSecret(), code)) {
      return { outcome: 'invalid-code' };
    }
    return {
      outcome: 'authenticated',
      idToken: signPlatformDevJwt(
        { sub: `platform-dev:${record.username}`, mfa: true },
        requirePlatformEnv('PLATFORM_AUTH_DEV_JWT_SECRET'),
        TOKEN_TTL_SECONDS,
      ),
      expiresInSeconds: TOKEN_TTL_SECONDS,
    };
  }
}
