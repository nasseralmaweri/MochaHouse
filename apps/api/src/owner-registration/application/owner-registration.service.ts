import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import {
  OWNER_REGISTRATION_CODE_INVALID,
  OWNER_REGISTRATION_LEGAL_OUTDATED,
  OWNER_REGISTRATION_UNAVAILABLE,
  OWNER_REGISTRATION_WEAK_PASSWORD,
} from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { isDevInternalAuthEnabled } from '../../internal-auth/infrastructure/internal-auth-provider-mode';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';
import { CognitoOwnerRegistrationProvider } from '../infrastructure/cognito-owner-registration.provider';
import { LocalDevOwnerRegistrationProvider } from '../infrastructure/local-dev-owner-registration.provider';
import type { OwnerRegistrationConfig } from './owner-registration.config';
import type { OwnerRegistrationProvider } from './owner-registration-provider';
import type { CompleteRegistrationInput } from './owner-registration-request';

type OwnerRegistration = Prisma.OwnerRegistrationGetPayload<
  Record<string, never>
>;

// SC4a — business owner self-service registration (owner decisions D1, D4,
// D6, D8, D9). Two steps:
//
//   start     emails a code. The SAME answer whatever the email's state
//             (new, pending, verified, an existing staff login, over its
//             allowance): nothing reveals whether an account exists.
//   complete  proves the mailbox with the code, sets the owner's own
//             password, records the Terms / Privacy acceptance.
//
// What registration can and cannot do:
//   - It creates ONLY a staff-pool login and this platform record: no
//     business, staff member, role or permission. Nothing here can reach a
//     business — that needs a staff row, which SC4b (separately approved)
//     creates bound to this login's subject.
//   - The login's subject is recorded only from the identity provider's own
//     answer to creating it, and never changes (database trigger). A login
//     recorded here is SELF-REGISTERED and is never bound to an existing
//     staff row by email (unbound-email-match.ts) — so registering with a
//     staff member's address can never claim their business.
//   - An existing login (created by an operator, or anyone) is never
//     touched: creating it fails and nothing is recorded or sent.
//   - The login starts with a server-only INITIAL password, derived from
//     SELF_SERVICE_REGISTRATION_SECRET and this record's random nonce,
//     never sent anywhere but the identity provider. The owner's own
//     password is set only together with a correct code, so whoever starts
//     a registration for someone else's address never learns the password
//     the account ends up with (no pre-hijacking), and a code confirmed
//     earlier is never accepted as proof again.
//   - Platform operator privileges are a separate identity pool, verifier
//     and table (platform-auth); nothing here reads or writes them.
//
// Limits (D6), on top of the per-IP / per-email rate limits on the routes:
//   - at most CODES_PER_WINDOW codes per email per 24 hours (further
//     requests answer the same and send nothing);
//   - at most MAX_VERIFICATION_ATTEMPTS completion attempts per code;
//   - a code is accepted for CODE_VALIDITY after it was sent (the provider
//     enforces its own, shorter limits too);
//   - at most the configured number of NEW registrations per 24 hours,
//     across all emails; while that quota is used up, every start is
//     refused alike (503), so the refusal reveals nothing about an email.
const DAY_MS = 24 * 60 * 60 * 1000;
const CODES_PER_WINDOW = 5;
const MAX_VERIFICATION_ATTEMPTS = 5;
const CODE_VALIDITY_MS = DAY_MS;

function codeInvalid(): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: OWNER_REGISTRATION_CODE_INVALID,
    message:
      'That code is incorrect or has expired. Request a new code and try again.',
  });
}

function weakPassword(message: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: OWNER_REGISTRATION_WEAK_PASSWORD,
    message,
  });
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    statusCode: 503,
    error: 'Service Unavailable',
    code: OWNER_REGISTRATION_UNAVAILABLE,
    message: 'Registration is temporarily unavailable. Try again later.',
  });
}

// Structural (the error can surface through another module identity).
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as {
    code?: unknown;
    cause?: { originalCode?: unknown; code?: unknown };
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  return (
    e.code === 'P2002' ||
    e.cause?.originalCode === '23505' ||
    e.cause?.code === '23505' ||
    e.meta?.driverAdapterError?.cause?.originalCode === '23505'
  );
}

// The login's initial password: never stored, never sent to the browser.
// The fixed prefix satisfies every character class a pool can require.
export function initialLoginPassword(
  secret: string,
  registration: Pick<OwnerRegistration, 'id' | 'initialPasswordNonce'>,
): string {
  const digest = createHmac('sha256', secret)
    .update(
      `owner-registration:${registration.id}:${registration.initialPasswordNonce}`,
    )
    .digest('base64url');
  return `Ow1!${digest}`;
}

@Injectable()
export class OwnerRegistrationService {
  private readonly logger = new Logger(OwnerRegistrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cognito: CognitoOwnerRegistrationProvider,
    private readonly dev: LocalDevOwnerRegistrationProvider,
  ) {}

  // Fail closed like staff sign-in: the dev stand-in only where dev staff
  // auth is enabled (never in production).
  private provider(): OwnerRegistrationProvider {
    return isDevInternalAuthEnabled() ? this.dev : this.cognito;
  }

  // --- step 1 -----------------------------------------------------------------

  async start(config: OwnerRegistrationConfig, email: string): Promise<void> {
    const recent = await this.prisma.ownerRegistration.count({
      where: { createdAt: { gte: new Date(Date.now() - DAY_MS) } },
    });
    if (recent >= config.dailyLimit) throw unavailable();

    const provider = this.provider();
    const registration = await this.findOrCreate(email, provider.providerName);
    // A finished registration, or one recorded under another identity
    // provider (a dev record seen by a Cognito deployment): nothing to send.
    if (
      registration.status === 'VERIFIED' ||
      registration.identityProvider !== provider.providerName
    ) {
      return;
    }
    if (!(await this.reserveCode(registration.id))) return;

    const current = await this.prisma.ownerRegistration.findUniqueOrThrow({
      where: { id: registration.id },
    });
    const sent = await this.sendCode(config, provider, current);
    if (sent) {
      await this.prisma.ownerRegistration.update({
        where: { id: current.id },
        data: {
          verificationAttempts: 0,
          expiresAt: new Date(Date.now() + CODE_VALIDITY_MS),
        },
      });
    }
  }

  private async findOrCreate(
    email: string,
    providerName: string,
  ): Promise<OwnerRegistration> {
    const existing = await this.prisma.ownerRegistration.findUnique({
      where: { email },
    });
    if (existing) return existing;
    try {
      return await this.prisma.ownerRegistration.create({
        data: {
          email,
          identityProvider: providerName,
          initialPasswordNonce: randomBytes(32).toString('hex'),
          expiresAt: new Date(Date.now() + CODE_VALIDITY_MS),
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent start for the same email won: use its record.
      return this.prisma.ownerRegistration.findUniqueOrThrow({
        where: { email },
      });
    }
  }

  // Counts a code against the email's 24-hour allowance BEFORE it is sent
  // (an attempt that then fails still counts). Atomic: concurrent starts can
  // never exceed the allowance. False when it is used up.
  private async reserveCode(id: string): Promise<boolean> {
    const windowStart = new Date(Date.now() - DAY_MS);
    const reserved = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "OwnerRegistration"
      SET "codesSent" = CASE WHEN "codeWindowStartedAt" <= ${windowStart} THEN 1 ELSE "codesSent" + 1 END,
          "codeWindowStartedAt" = CASE WHEN "codeWindowStartedAt" <= ${windowStart} THEN now() ELSE "codeWindowStartedAt" END,
          "updatedAt" = now()
      WHERE "id" = ${id}
        AND "status" <> 'VERIFIED'
        AND ("codeWindowStartedAt" <= ${windowStart} OR "codesSent" < ${CODES_PER_WINDOW})
    `);
    return reserved === 1;
  }

  // Sends the code this registration needs now. True when one was sent.
  private async sendCode(
    config: OwnerRegistrationConfig,
    provider: OwnerRegistrationProvider,
    registration: OwnerRegistration,
  ): Promise<boolean> {
    const { email } = registration;
    if (registration.status === 'PENDING_VERIFICATION') {
      if (registration.identitySubject === null) {
        const initialPassword = initialLoginPassword(
          config.secret,
          registration,
        );
        const created = await provider.createLogin(email, initialPassword);
        if (created.outcome === 'created') {
          await this.prisma.ownerRegistration.updateMany({
            where: { id: registration.id, identitySubject: null },
            data: { identitySubject: created.subject },
          });
          return true;
        }
        // SC4b — a login with this email exists. Ours only if it still has
        // our server-only initial password (an earlier attempt created it and
        // was interrupted before recording its subject); anyone else's is
        // never touched.
        const probe = await provider.probeInitialLogin(email, initialPassword);
        if (probe === 'not-ours') return false;
        if (probe === 'ours-unconfirmed') {
          return (await provider.resendSignUpCode(email)).outcome === 'sent';
        }
        if (
          !(await this.recordRecoveredLogin(
            provider,
            registration,
            initialPassword,
          ))
        ) {
          return false;
        }
        await this.toPasswordSetup(registration.id);
        return (await provider.sendPasswordSetupCode(email)).outcome === 'sent';
      }
      const resent = await provider.resendSignUpCode(email);
      if (resent.outcome === 'sent') return true;
      if (resent.outcome !== 'already-confirmed') return false;
      // Confirmed outside a completion (an interrupted one): the password
      // is set with a password-setup code instead.
      await this.toPasswordSetup(registration.id);
    }
    const setup = await provider.sendPasswordSetupCode(email);
    return setup.outcome === 'sent';
  }

  // SC4b — records the subject of a login this API created but never
  // recorded: only from a real sign-in with the server-only initial password
  // (proof the login is ours), with a provider-verified email equal to the
  // registration's. True when recorded.
  private async recordRecoveredLogin(
    provider: OwnerRegistrationProvider,
    registration: OwnerRegistration,
    initialPassword: string,
  ): Promise<boolean> {
    const login = await provider.loginWithInitialPassword(
      registration.email,
      initialPassword,
    );
    if (
      !login ||
      login.provider !== registration.identityProvider ||
      !login.emailVerified ||
      login.email?.trim().toLowerCase() !== registration.email
    ) {
      return false;
    }
    try {
      const recorded = await this.prisma.ownerRegistration.updateMany({
        where: { id: registration.id, identitySubject: null },
        data: { identitySubject: login.subject },
      });
      return recorded.count === 1;
    } catch (error) {
      // That login is already another registration's (unique): never ours.
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  private async toPasswordSetup(id: string): Promise<void> {
    await this.prisma.ownerRegistration.updateMany({
      where: {
        id,
        status: 'PENDING_VERIFICATION',
        NOT: { identitySubject: null },
      },
      data: { status: 'PASSWORD_SETUP' },
    });
  }

  // --- step 2 -----------------------------------------------------------------

  async complete(
    config: OwnerRegistrationConfig,
    input: CompleteRegistrationInput,
    requestReference: string | undefined,
  ): Promise<void> {
    if (
      input.termsVersion !== config.termsVersion ||
      input.privacyVersion !== config.privacyVersion
    ) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: OWNER_REGISTRATION_LEGAL_OUTDATED,
        message:
          'The Terms of Service or Privacy Policy changed. Review them and try again.',
      });
    }

    const provider = this.provider();
    const registration = await this.prisma.ownerRegistration.findUnique({
      where: { email: input.email },
    });
    if (
      !registration ||
      registration.status === 'VERIFIED' ||
      registration.identityProvider !== provider.providerName
    ) {
      throw codeInvalid();
    }
    const status = await this.countAttempt(registration.id);
    if (status === null) throw codeInvalid();

    const initialPassword = initialLoginPassword(config.secret, registration);
    if (registration.identitySubject === null) {
      // SC4b — recovery: a login created by an interrupted attempt whose
      // subject was never recorded. Anyone else's login: refused alike.
      const probe = await provider.probeInitialLogin(
        input.email,
        initialPassword,
      );
      if (probe === 'not-ours') throw codeInvalid();
      if (probe === 'ours-confirmed') {
        // Confirmed earlier: never proof for THIS request.
        if (
          await this.recordRecoveredLogin(
            provider,
            registration,
            initialPassword,
          )
        ) {
          await this.toPasswordSetup(registration.id);
        }
        throw codeInvalid();
      }
      const confirmed = await provider.confirmSignUp(input.email, input.code);
      if (confirmed.outcome !== 'confirmed') throw codeInvalid();
      if (
        !(await this.recordRecoveredLogin(
          provider,
          registration,
          initialPassword,
        ))
      ) {
        throw unavailable();
      }
      await this.toPasswordSetup(registration.id);
      await this.setOwnPassword(provider, input, initialPassword);
    } else if (status === 'PENDING_VERIFICATION') {
      const confirmed = await provider.confirmSignUp(input.email, input.code);
      if (confirmed.outcome === 'already-confirmed') {
        // Never proof for THIS request: a password-setup code is needed.
        await this.toPasswordSetup(registration.id);
        throw codeInvalid();
      }
      if (confirmed.outcome !== 'confirmed') throw codeInvalid();
      // The mailbox is proven. Recorded first, so an interruption from here
      // on is finished with a password-setup code, never with this one.
      await this.toPasswordSetup(registration.id);
      await this.setOwnPassword(provider, input, initialPassword);
    } else {
      const set = await provider.confirmPasswordSetup(
        input.email,
        input.code,
        input.password,
      );
      if (set.outcome === 'invalid-password') {
        throw weakPassword(
          'The password was not accepted. Choose a stronger password.',
        );
      }
      if (set.outcome !== 'set') throw codeInvalid();
    }

    // Re-read: a recovered login's subject was recorded just now.
    const current = await this.prisma.ownerRegistration.findUniqueOrThrow({
      where: { id: registration.id },
    });
    await this.finish(provider, current, input, requestReference);
  }

  // Replaces the initial password with the owner's own, right after the
  // sign-up code was confirmed in this same request.
  private async setOwnPassword(
    provider: OwnerRegistrationProvider,
    input: CompleteRegistrationInput,
    initialPassword: string,
  ): Promise<void> {
    const set = await provider.setPassword(
      input.email,
      initialPassword,
      input.password,
    );
    if (set.outcome === 'invalid-password') {
      throw weakPassword(
        'The password was not accepted. Request a new code and choose a stronger password.',
      );
    }
    if (set.outcome !== 'set') throw codeInvalid();
  }

  // Counts one completion attempt against the current code, atomically.
  // The registration's status at that moment, or null when the code may not
  // be tried any more (attempts used up, expired, finished).
  private async countAttempt(
    id: string,
  ): Promise<'PENDING_VERIFICATION' | 'PASSWORD_SETUP' | null> {
    const rows = await this.prisma.$queryRaw<{ status: string }[]>(Prisma.sql`
      UPDATE "OwnerRegistration"
      SET "verificationAttempts" = "verificationAttempts" + 1, "updatedAt" = now()
      WHERE "id" = ${id}
        AND "status" <> 'VERIFIED'
        AND "verificationAttempts" < ${MAX_VERIFICATION_ATTEMPTS}
        AND "expiresAt" > now()
      RETURNING "status"::text AS status
    `);
    const status = rows[0]?.status;
    return status === 'PENDING_VERIFICATION' || status === 'PASSWORD_SETUP'
      ? status
      : null;
  }

  // The password is set. A real sign-in with it must yield exactly the login
  // this registration created, with the provider asserting the email is
  // verified — only then is the registration VERIFIED.
  private async finish(
    provider: OwnerRegistrationProvider,
    registration: OwnerRegistration,
    input: CompleteRegistrationInput,
    requestReference: string | undefined,
  ): Promise<void> {
    const login = await provider.signIn(input.email, input.password);
    if (
      !login ||
      login.provider !== registration.identityProvider ||
      login.subject !== registration.identitySubject ||
      !login.emailVerified ||
      login.email?.trim().toLowerCase() !== registration.email
    ) {
      this.logger.error(
        `Owner registration ${registration.id}: the login after password setup did not match the registration.`,
      );
      throw unavailable();
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const verified = await tx.ownerRegistration.updateMany({
        where: { id: registration.id, status: 'PASSWORD_SETUP' },
        data: {
          status: 'VERIFIED',
          verifiedAt: now,
          displayName: input.displayName,
          termsVersion: input.termsVersion,
          privacyVersion: input.privacyVersion,
          legalAcceptedAt: now,
          verificationAttempts: 0,
        },
      });
      // A concurrent completion finished it first: already recorded.
      if (verified.count !== 1) return;
      await tx.platformAuditEvent.create({
        data: {
          action: PLATFORM_AUDIT_ACTIONS.ownerRegistrationVerified,
          outcome: 'SUCCEEDED',
          identityProvider: registration.identityProvider,
          identitySubject: registration.identitySubject,
          targetType: 'owner_registration',
          targetId: registration.id,
          requestReference: requestReference ?? null,
        },
      });
    });
  }
}
