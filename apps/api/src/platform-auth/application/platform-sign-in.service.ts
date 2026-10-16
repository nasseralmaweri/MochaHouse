import { Injectable, Logger } from '@nestjs/common';
import type {
  PlatformMfaSetupDisplayResponse,
  PlatformMfaSetupResponse,
  PlatformSessionResponse,
  PlatformSignInStepResponse,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { isDevPlatformAuthEnabled } from '../infrastructure/platform-auth-provider-mode';
import type { PlatformIdentity } from '../infrastructure/platform-identity';
import {
  PlatformCognitoTokenVerifier,
  PlatformLocalDevTokenVerifier,
} from '../infrastructure/platform-token-verifiers';
import {
  PlatformChallengeStore,
  type PlatformChallengeRecord,
} from '../sign-in/platform-challenge-store';
import { PlatformCognitoSignInProvider } from '../sign-in/platform-cognito-sign-in.provider';
import { PlatformDevSignInProvider } from '../sign-in/platform-dev-sign-in.provider';
import {
  PlatformSignInRefusedError,
  type PlatformSignInCompletion,
  type PlatformSignInProvider,
} from '../sign-in/platform-sign-in.types';
import {
  PLATFORM_AUDIT_ACTIONS,
  PlatformOperatorsService,
} from './platform-operators.service';

// SC1b — platform-operator sign-in: password, then a MANDATORY TOTP step
// (or first-time authenticator enrolment), and only then a session.
//
// The order of guarantees for every completed sign-in:
//   1. The provider says both factors succeeded (Cognito, or the dev
//      provider's real TOTP check).
//   2. The issued token is re-verified with the SAME verifier PlatformAuthGuard
//      uses (dedicated pool / audience / expiry, or the dev codec with its
//      mfa claim) — a provider bug cannot hand out a token the boundary would
//      not accept.
//   3. The verified identity must map to an ACTIVE PlatformOperator. Otherwise
//      no token is returned and the refusal is audited.
// Only then is `platform.session.established` audited and the token handed to
// the web tier, which keeps it in an HttpOnly cookie.

export type PlatformSignInFailure =
  | 'invalid-credentials'
  | 'account-setup-required'
  | 'restart'
  | 'not-permitted';

export class PlatformSignInFailed extends Error {
  constructor(readonly reason: PlatformSignInFailure) {
    super(reason);
    this.name = 'PlatformSignInFailed';
  }
}

const OTPAUTH_ISSUER = 'CENTERIVO';

@Injectable()
export class PlatformSignInService {
  private readonly logger = new Logger(PlatformSignInService.name);

  constructor(
    private readonly challenges: PlatformChallengeStore,
    private readonly cognitoProvider: PlatformCognitoSignInProvider,
    private readonly devProvider: PlatformDevSignInProvider,
    private readonly cognitoVerifier: PlatformCognitoTokenVerifier,
    private readonly devVerifier: PlatformLocalDevTokenVerifier,
    private readonly operators: PlatformOperatorsService,
    private readonly prisma: PrismaService,
  ) {}

  async start(
    rawEmail: string,
    password: string,
  ): Promise<PlatformSignInStepResponse> {
    const email = rawEmail.trim().toLowerCase();
    const outcome = await this.currentProvider().start(email, password);
    if (outcome.outcome !== 'challenge') {
      throw new PlatformSignInFailed(outcome.outcome);
    }
    const challenge = await this.challenges.create(outcome.record);
    return {
      status:
        outcome.record.kind === 'mfa-setup'
          ? 'mfa-setup-required'
          : 'mfa-required',
      challenge,
    };
  }

  async respondToMfa(
    challenge: string,
    code: string,
    requestReference: string | undefined,
  ): Promise<PlatformSessionResponse> {
    const record = await this.takeOrRestart(challenge, 'mfa');
    const completion = await this.providerFor(record).respondToMfa(
      record,
      code,
    );
    return this.establishSession(record, completion, requestReference);
  }

  async beginMfaSetup(challenge: string): Promise<PlatformMfaSetupResponse> {
    const record = await this.takeOrRestart(challenge, 'mfa-setup');
    if (record.secretIssued) {
      // One authenticator secret per attempt: refreshing the page does not
      // mint another one; the operator signs in again instead.
      throw new PlatformSignInFailed('restart');
    }
    const { secret, record: next } =
      await this.providerFor(record).beginMfaSetup(record);
    // The secret stays server-side with the attempt; only the next handle
    // is returned. The setup page reads the secret through displayMfaSetup.
    const nextChallenge = await this.challenges.create({ ...next, secret });
    return { challenge: nextChallenge };
  }

  // The authenticator secret of an enrolment in progress, for the setup page
  // to render. Does not consume or advance the attempt; only works for the
  // exact handle the secret was issued under, within its 180-second life.
  async displayMfaSetup(
    challenge: string,
  ): Promise<PlatformMfaSetupDisplayResponse> {
    const record = await this.challenges.peek(challenge);
    if (
      !record ||
      record.kind !== 'mfa-setup' ||
      !record.secretIssued ||
      !record.secret
    ) {
      throw new PlatformSignInFailed('restart');
    }
    const label = encodeURIComponent(`${OTPAUTH_ISSUER}:${record.username}`);
    return {
      secret: record.secret,
      otpauthUri: `otpauth://totp/${label}?secret=${encodeURIComponent(
        record.secret,
      )}&issuer=${OTPAUTH_ISSUER}&algorithm=SHA1&digits=6&period=30`,
    };
  }

  async completeMfaSetup(
    challenge: string,
    code: string,
    requestReference: string | undefined,
  ): Promise<PlatformSessionResponse> {
    const record = await this.takeOrRestart(challenge, 'mfa-setup');
    if (!record.secretIssued) {
      throw new PlatformSignInFailed('restart');
    }
    const completion = await this.providerFor(record).completeMfaSetup(
      record,
      code,
    );
    return this.establishSession(record, completion, requestReference);
  }

  // --- internals -----------------------------------------------------

  private currentProvider(): PlatformSignInProvider {
    return isDevPlatformAuthEnabled() ? this.devProvider : this.cognitoProvider;
  }

  // A challenge is completed by the provider that created it, and only while
  // that provider is still the active one (a dev challenge can never be
  // finished once dev sign-in is off, and vice versa).
  private providerFor(record: PlatformChallengeRecord): PlatformSignInProvider {
    const dev = isDevPlatformAuthEnabled();
    if (record.provider === 'dev' && dev) return this.devProvider;
    if (record.provider === 'cognito' && !dev) return this.cognitoProvider;
    throw new PlatformSignInRefusedError(
      'The sign-in challenge belongs to another identity provider.',
    );
  }

  private async takeOrRestart(
    challenge: string,
    kind: PlatformChallengeRecord['kind'],
  ): Promise<PlatformChallengeRecord> {
    const record = await this.challenges.take(challenge);
    if (!record || record.kind !== kind) {
      throw new PlatformSignInFailed('restart');
    }
    return record;
  }

  private async establishSession(
    record: PlatformChallengeRecord,
    completion: PlatformSignInCompletion,
    requestReference: string | undefined,
  ): Promise<PlatformSessionResponse> {
    if (completion.outcome !== 'authenticated') {
      throw new PlatformSignInFailed('restart');
    }
    let identity: PlatformIdentity;
    try {
      identity = await (
        record.provider === 'dev' ? this.devVerifier : this.cognitoVerifier
      ).verify(completion.idToken);
    } catch (error) {
      // Never return a token the platform boundary itself would refuse.
      this.logger.error(
        `Issued platform token failed verification: ${
          error instanceof Error ? error.name : 'unknown'
        }`,
      );
      throw new PlatformSignInRefusedError(
        'The issued token did not verify at the platform boundary.',
      );
    }
    const resolution = await this.operators.resolve(identity);
    if (resolution.outcome !== 'active') {
      await this.operators.recordDenied(identity, resolution, requestReference);
      throw new PlatformSignInFailed('not-permitted');
    }
    await this.prisma.$transaction([
      this.prisma.platformOperator.update({
        where: { id: resolution.operator.id },
        data: { lastAuthenticatedAt: new Date() },
      }),
      this.prisma.platformAuditEvent.create({
        data: {
          action: PLATFORM_AUDIT_ACTIONS.sessionEstablished,
          outcome: 'SUCCEEDED',
          actorPlatformOperatorId: resolution.operator.id,
          requestReference: requestReference ?? null,
        },
      }),
    ]);
    return {
      idToken: completion.idToken,
      expiresInSeconds: completion.expiresInSeconds,
    };
  }
}
