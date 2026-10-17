import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  OWNER_REGISTRATION_CODE_INVALID,
  OWNER_REGISTRATION_INVALID_INPUT,
  OWNER_REGISTRATION_LEGAL_OUTDATED,
  OWNER_REGISTRATION_UNAVAILABLE,
  OWNER_REGISTRATION_WEAK_PASSWORD,
  type InternalBusinessesResponse,
} from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  type ScratchDatabase,
} from '@mocha-house/testing';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signPlatformDevJwt } from '../platform-auth/infrastructure/platform-dev-jwt';
import {
  LocalDevOwnerRegistrationProvider,
  deriveDevOwnerRegistrationCode,
} from './infrastructure/local-dev-owner-registration.provider';

// SC4a — business owner self-service registration end to end, on the real
// AppModule with the dev identity provider, in a SCRATCH database of its own
// (registrations with a login are never deleted, and the daily quota counts
// every registration). Covers: the server-side flag; the enumeration-safe
// start; code, attempt, expiry and allowance limits; the owner's own password
// only with a correct code (no pre-hijacking, no reuse of a confirmed code);
// legal acceptance; and that a registered login can claim no business, no
// staff row and no platform access.
describe('SC4a owner self-service registration (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let devProvider: LocalDevOwnerRegistrationProvider;
  const originalEnv = { ...process.env };
  const INTERNAL_SECRET = `sc4a-internal-${randomUUID()}`;
  const PLATFORM_SECRET = `sc4a-platform-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  const PASSWORD = 'Correct-Horse-9-Battery';

  const emailOf = (key: string) => `sc4a-${key}-${run}@example.com`;
  const signUpCode = (email: string) =>
    deriveDevOwnerRegistrationCode(email, 'sign-up', INTERNAL_SECRET);
  const setupCode = (email: string) =>
    deriveDevOwnerRegistrationCode(email, 'password-setup', INTERNAL_SECRET);
  const wrongCode = (code: string) =>
    ((Number(code) + 1) % 1_000_000).toString().padStart(6, '0');

  const enable = (overrides: Record<string, string | undefined> = {}) => {
    Object.assign(process.env, {
      SELF_SERVICE_REGISTRATION_ENABLED: '1',
      SELF_SERVICE_TERMS_VERSION: 'terms-2026-10',
      SELF_SERVICE_PRIVACY_VERSION: 'privacy-2026-10',
      SELF_SERVICE_REGISTRATION_SECRET: `sc4a-registration-secret-${randomUUID()}`,
      SELF_SERVICE_REGISTRATION_DAILY_LIMIT: '1000',
      SELF_SERVICE_TERMS_URL: 'https://example.com/terms',
      SELF_SERVICE_PRIVACY_URL: undefined,
    });
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  const http = () => request(app.getHttpServer());
  const start = (email: unknown) =>
    http().post('/api/v1/internal/registration/start').send({ email });
  const complete = (body: Record<string, unknown>) =>
    http()
      .post('/api/v1/internal/registration/complete')
      .send({
        password: PASSWORD,
        displayName: '  Ada   Owner ',
        termsVersion: 'terms-2026-10',
        privacyVersion: 'privacy-2026-10',
        acceptLegal: true,
        ...body,
      });
  const registrationOf = (email: string) =>
    prisma.ownerRegistration.findUnique({ where: { email } });
  const staffToken = (email: string, subject = `internal-dev:${email}`) =>
    signInternalDevJwt(
      { sub: subject, email, name: null, email_verified: true },
      INTERNAL_SECRET,
      3600,
    );
  const businessCounts = async () => ({
    tenants: await prisma.tenant.count(),
    staff: await prisma.internalUser.count(),
    roles: await prisma.internalRole.count(),
    assignments: await prisma.internalUserRoleAssignment.count(),
    operators: await prisma.platformOperator.count(),
  });

  async function register(email: string): Promise<void> {
    await start(email).expect(202);
    await complete({ email, code: signUpCode(email) }).expect(200);
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4a_registration',
    );
    await applyMigrations(
      scratch.url,
      listMigrations(
        join(__dirname, '../../../../packages/database/prisma/migrations'),
      ),
    );
    process.env.DATABASE_URL = scratch.url;
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = INTERNAL_SECRET;
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = PLATFORM_SECRET;
    // The limiter is covered by protected-routes.spec; this suite registers
    // many times from one loopback address.
    process.env.RATE_LIMIT_ENABLED = '0';
    delete process.env.SELF_SERVICE_REGISTRATION_ENABLED;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.init();
    prisma = app.get(PrismaService);
    devProvider = app.get(LocalDevOwnerRegistrationProvider);
  });

  beforeEach(() => enable());

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = { ...originalEnv };
      await scratch?.drop();
    }
  });

  // --- the server-side switch ---------------------------------------------

  it('is OFF by default: availability says so and every action is a 404, with nothing recorded', async () => {
    delete process.env.SELF_SERVICE_REGISTRATION_ENABLED;
    const email = emailOf('off');
    const availability = await http()
      .get('/api/v1/internal/registration')
      .expect(200);
    expect(availability.headers['cache-control']).toBe('no-store');
    expect(availability.body).toEqual({ enabled: false });
    await start(email).expect(404);
    await complete({ email, code: '123456' }).expect(404);
    expect(await registrationOf(email)).toBeNull();
  });

  it('stays OFF when the flag is on but the legal versions or the secret are missing or malformed', async () => {
    for (const overrides of [
      { SELF_SERVICE_REGISTRATION_ENABLED: 'yes' },
      { SELF_SERVICE_TERMS_VERSION: undefined },
      { SELF_SERVICE_PRIVACY_VERSION: ' ' },
      { SELF_SERVICE_TERMS_VERSION: 'v1; drop' },
      { SELF_SERVICE_REGISTRATION_SECRET: 'too-short' },
      { SELF_SERVICE_REGISTRATION_DAILY_LIMIT: '-1' },
    ]) {
      enable(overrides);
      const res = await http().get('/api/v1/internal/registration').expect(200);
      expect(res.body).toEqual({ enabled: false });
      await start(emailOf('misconfigured')).expect(404);
    }
    expect(await registrationOf(emailOf('misconfigured'))).toBeNull();
  });

  it('when enabled, offers the legal versions and only https document links', async () => {
    const res = await http().get('/api/v1/internal/registration').expect(200);
    expect(res.body).toEqual({
      enabled: true,
      termsVersion: 'terms-2026-10',
      privacyVersion: 'privacy-2026-10',
      termsUrl: 'https://example.com/terms',
      privacyUrl: null,
    });
    enable({ SELF_SERVICE_TERMS_URL: 'javascript:alert(1)' });
    const unsafe = await http()
      .get('/api/v1/internal/registration')
      .expect(200);
    expect((unsafe.body as { termsUrl: unknown }).termsUrl).toBeNull();
  });

  // --- registering ----------------------------------------------------------

  it('registers an owner: a verified login, the legal acceptance and an audit event — and no business, staff member, role or operator', async () => {
    const before = await businessCounts();
    const email = emailOf('happy');

    const started = await start(`  ${email.toUpperCase()} `).expect(202);
    expect(started.headers['cache-control']).toBe('no-store');
    expect(started.body).toEqual({ status: 'CODE_SENT_IF_ELIGIBLE' });
    const pending = await registrationOf(email);
    expect(pending).toMatchObject({
      status: 'PENDING_VERIFICATION',
      identityProvider: 'internal-dev',
      identitySubject: `internal-dev:${email}`,
      codesSent: 1,
      verificationAttempts: 0,
      legalAcceptedAt: null,
    });

    const res = await complete({ email, code: signUpCode(email) }).expect(200);
    expect(res.body).toEqual({ status: 'VERIFIED' });
    const verified = await registrationOf(email);
    expect(verified).toMatchObject({
      status: 'VERIFIED',
      displayName: 'Ada Owner',
      termsVersion: 'terms-2026-10',
      privacyVersion: 'privacy-2026-10',
    });
    expect(verified!.verifiedAt).toBeInstanceOf(Date);
    expect(verified!.legalAcceptedAt).toEqual(verified!.verifiedAt);

    const audit = await prisma.platformAuditEvent.findMany({
      where: { targetType: 'owner_registration', targetId: verified!.id },
    });
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'platform.owner_registration.verified',
        outcome: 'SUCCEEDED',
        actorPlatformOperatorId: null,
        identityProvider: 'internal-dev',
        identitySubject: `internal-dev:${email}`,
      }),
    ]);

    // The owner's own password works; registration created nothing else.
    expect(await devProvider.signIn(email, PASSWORD)).toMatchObject({
      subject: `internal-dev:${email}`,
      emailVerified: true,
    });
    expect(await businessCounts()).toEqual(before);

    // Finished is final: completing again, or starting again, changes nothing.
    await complete({ email, code: signUpCode(email) })
      .expect(400)
      .expect((r) =>
        expect((r.body as { code: string }).code).toBe(
          OWNER_REGISTRATION_CODE_INVALID,
        ),
      );
    await start(email).expect(202);
    expect(await registrationOf(email)).toEqual(verified);
  });

  it('answers every start alike — new, pending, verified, or an existing login it does not own — and never touches a login it did not create', async () => {
    const verified = emailOf('enum-verified');
    await register(verified);
    const pending = emailOf('enum-pending');
    await start(pending).expect(202);
    // A login that exists at the identity provider without a registration
    // (e.g. created by an operator).
    const foreign = emailOf('enum-foreign');
    await devProvider.createLogin(foreign, 'Operator-Set-Pass-1');

    const bodies: unknown[] = [];
    for (const email of [emailOf('enum-new'), pending, verified, foreign]) {
      const res = await start(email).expect(202);
      bodies.push(res.body);
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);

    // Nothing was recorded for the foreign login and it was not changed.
    expect(await registrationOf(foreign)).toMatchObject({
      identitySubject: null,
      status: 'PENDING_VERIFICATION',
    });
    devProvider.confirmOutOfBand(foreign);
    expect(
      await devProvider.signIn(foreign, 'Operator-Set-Pass-1'),
    ).not.toBeNull();
    // And it cannot be completed through registration.
    await complete({ email: foreign, code: signUpCode(foreign) }).expect(400);
  });

  it('refuses malformed input and weak passwords without consuming anything', async () => {
    await start('not-an-email')
      .expect(400)
      .expect((r) =>
        expect((r.body as { code: string }).code).toBe(
          OWNER_REGISTRATION_INVALID_INPUT,
        ),
      );
    const email = emailOf('input');
    await start(email).expect(202);
    for (const [body, code] of [
      [{ code: 'abc' }, OWNER_REGISTRATION_INVALID_INPUT],
      [{ displayName: '   ' }, OWNER_REGISTRATION_INVALID_INPUT],
      [{ acceptLegal: 'true' }, OWNER_REGISTRATION_INVALID_INPUT],
      [{ password: 'short1!A' }, OWNER_REGISTRATION_WEAK_PASSWORD],
      [{ password: 'alllowercase-123' }, OWNER_REGISTRATION_WEAK_PASSWORD],
      [{ password: 'NoDigitsOrSymbols' }, OWNER_REGISTRATION_WEAK_PASSWORD],
      [{ password: ' Leading-Space-1' }, OWNER_REGISTRATION_WEAK_PASSWORD],
    ] as const) {
      const res = await complete({
        email,
        code: signUpCode(email),
        ...(body as Record<string, unknown>),
      }).expect(400);
      expect((res.body as { code: string }).code).toBe(code);
    }
    expect(await registrationOf(email)).toMatchObject({
      status: 'PENDING_VERIFICATION',
      verificationAttempts: 0,
    });
    // Still completes with valid input.
    await complete({ email, code: signUpCode(email) }).expect(200);
  });

  it('requires the legal versions currently offered', async () => {
    const email = emailOf('legal');
    await start(email).expect(202);
    const res = await complete({
      email,
      code: signUpCode(email),
      termsVersion: 'terms-2025-01',
    }).expect(409);
    expect((res.body as { code: string }).code).toBe(
      OWNER_REGISTRATION_LEGAL_OUTDATED,
    );
    expect((await registrationOf(email))!.status).toBe('PENDING_VERIFICATION');
  });

  // --- codes, attempts, expiry, allowances ------------------------------------

  it('gives a wrong code, an unknown email and an expired code the same answer; 5 attempts per code; a new code resets them', async () => {
    const email = emailOf('attempts');
    await start(email).expect(202);
    const unknown = await complete({
      email: emailOf('nobody'),
      code: '123456',
    }).expect(400);
    for (let i = 0; i < 5; i += 1) {
      const res = await complete({
        email,
        code: wrongCode(signUpCode(email)),
      }).expect(400);
      expect(res.body).toEqual(unknown.body);
    }
    // Attempts used up: even the right code is refused.
    await complete({ email, code: signUpCode(email) }).expect(400);
    expect((await registrationOf(email))!.status).toBe('PENDING_VERIFICATION');

    // A new code resets the attempts.
    await start(email).expect(202);
    expect(await registrationOf(email)).toMatchObject({
      verificationAttempts: 0,
      codesSent: 2,
    });

    // Expired: refused alike.
    await prisma.ownerRegistration.update({
      where: { email },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await complete({ email, code: signUpCode(email) }).expect(
      400,
    );
    expect(expired.body).toEqual(unknown.body);
    await start(email).expect(202);
    await complete({ email, code: signUpCode(email) }).expect(200);
  });

  it('sends at most 5 codes per email per 24 hours (further starts answer the same and send nothing)', async () => {
    const email = emailOf('allowance');
    for (let i = 0; i < 7; i += 1) await start(email).expect(202);
    expect((await registrationOf(email))!.codesSent).toBe(5);
    // A new window opens after 24 hours.
    await prisma.ownerRegistration.update({
      where: { email },
      data: { codeWindowStartedAt: new Date(Date.now() - 25 * 3600 * 1000) },
    });
    await start(email).expect(202);
    expect((await registrationOf(email))!.codesSent).toBe(1);
  });

  it('refuses every start alike while the daily quota of new registrations is used up', async () => {
    const pending = emailOf('quota-pending');
    await start(pending).expect(202);
    const used = await prisma.ownerRegistration.count();
    enable({ SELF_SERVICE_REGISTRATION_DAILY_LIMIT: String(used) });
    for (const email of [emailOf('quota-new'), pending]) {
      const res = await start(email).expect(503);
      expect((res.body as { code: string }).code).toBe(
        OWNER_REGISTRATION_UNAVAILABLE,
      );
    }
    expect(await registrationOf(emailOf('quota-new'))).toBeNull();
  });

  // --- account takeover resistance --------------------------------------------

  it('never lets whoever started a registration for someone else know the final password (no pre-hijacking)', async () => {
    const victim = emailOf('victim');
    // The attacker starts it: the login gets a server-only initial password.
    await start(victim).expect(202);
    for (const guess of [PASSWORD, 'Attacker-Pass-1!', '']) {
      expect(await devProvider.signIn(victim, guess)).toBeNull();
    }
    // Without the code, the attacker cannot set a password.
    await complete({
      email: victim,
      code: wrongCode(signUpCode(victim)),
      password: 'Attacker-Pass-1!',
    }).expect(400);
    // The mailbox owner completes with their own password.
    await complete({
      email: victim,
      code: signUpCode(victim),
      password: 'Victims-Own-Pass-7',
    }).expect(200);
    expect(await devProvider.signIn(victim, 'Attacker-Pass-1!')).toBeNull();
    expect(
      await devProvider.signIn(victim, 'Victims-Own-Pass-7'),
    ).not.toBeNull();
  });

  it('never accepts an already-confirmed sign-up code as proof again: an interrupted completion needs a password-setup code', async () => {
    const email = emailOf('interrupted');
    await start(email).expect(202);
    // Confirmed outside a completion request (e.g. it was interrupted).
    devProvider.confirmOutOfBand(email);
    await complete({ email, code: signUpCode(email) })
      .expect(400)
      .expect((r) =>
        expect((r.body as { code: string }).code).toBe(
          OWNER_REGISTRATION_CODE_INVALID,
        ),
      );
    expect((await registrationOf(email))!.status).toBe('PASSWORD_SETUP');
    // The same old code again: still refused.
    await complete({ email, code: signUpCode(email) }).expect(400);
    // A new (password-setup) code finishes it.
    await start(email).expect(202);
    await complete({ email, code: setupCode(email) }).expect(200);
    expect((await registrationOf(email))!.status).toBe('VERIFIED');
    expect(await devProvider.signIn(email, PASSWORD)).not.toBeNull();
  });

  it('a registered login can never claim an existing business or staff row by email, while an operator-provisioned login still can', async () => {
    const staffEmail = emailOf('staff');
    // An operator provisioned a staff member by email (not yet signed in).
    const staffRow = await prisma.internalUser.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        externalProvider: 'internal-dev',
        externalSubject: null,
        email: staffEmail.toUpperCase(),
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    // Someone registers with that address.
    await register(staffEmail);
    const token = staffToken(staffEmail);

    // No business to enter (the business list refuses a login with none).
    await http()
      .get('/api/v1/internal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    await http()
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', TENANT_1_MOCHA_HOUSE_ID)
      .expect((r) => expect([401, 403]).toContain(r.status));
    await http()
      .get('/api/v1/admin/locations')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', TENANT_1_MOCHA_HOUSE_ID)
      .expect((r) => expect([401, 403]).toContain(r.status));
    expect(
      await prisma.internalUser.findUniqueOrThrow({
        where: { id: staffRow.id },
      }),
    ).toMatchObject({ externalSubject: null, lastAuthenticatedAt: null });

    // Control: an operator-provisioned login (no registration) with a
    // verified email still binds, exactly as before SC4a.
    const operatorLogin = staffToken(
      staffEmail,
      `internal-dev:operator-${run}`,
    );
    const listed = await http()
      .get('/api/v1/internal/businesses')
      .set('Authorization', `Bearer ${operatorLogin}`)
      .expect(200);
    expect(
      (listed.body as InternalBusinessesResponse).businesses.map((b) => b.id),
    ).toEqual([TENANT_1_MOCHA_HOUSE_ID]);
  });

  it('a registered login has no platform-operator access', async () => {
    const email = emailOf('platform');
    await register(email);
    await http()
      .get('/api/v1/platform/tenants')
      .set('Authorization', `Bearer ${staffToken(email)}`)
      .expect(401);
    // Not even with a platform token minted for the same subject: there is
    // no operator record for it.
    const platformToken = signPlatformDevJwt(
      { sub: `internal-dev:${email}`, mfa: true },
      PLATFORM_SECRET,
      3600,
    );
    await http()
      .get('/api/v1/platform/tenants')
      .set('Authorization', `Bearer ${platformToken}`)
      .expect((r) => expect([401, 403]).toContain(r.status));
    expect(await prisma.platformOperator.count()).toBe(0);
  });

  it('keeps the recorded login fixed and a registration with a login undeletable (database guard)', async () => {
    const email = emailOf('guard');
    await register(email);
    await expect(
      prisma.ownerRegistration.update({
        where: { email },
        data: { identitySubject: 'internal-dev:someone-else' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.ownerRegistration.update({
        where: { email },
        data: { status: 'PENDING_VERIFICATION' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.ownerRegistration.delete({ where: { email } }),
    ).rejects.toThrow();
  });
});
