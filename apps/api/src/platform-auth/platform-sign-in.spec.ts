import 'dotenv/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { totpAt, decodeBase32 } from './sign-in/platform-totp';
import { PLATFORM_CHALLENGE_TTL_SECONDS } from './sign-in/platform-challenge-store';

// SC1b — CENTERIVO platform-operator sign-in end to end over real HTTP on the
// real AppModule, with the local/test platform provider (password + a REAL
// RFC 6238 TOTP), real Redis for the challenge store and the real database:
//   - a session token exists only after BOTH factors, and only for an ACTIVE
//     PlatformOperator; the password step never returns a token;
//   - challenges are single-use, short-lived and server-side (the browser
//     only ever holds an opaque handle); a wrong code ends the attempt;
//   - first-time authenticator enrolment, issued once per attempt;
//   - generic answers (no provider detail), fail-closed configuration;
//   - tenant-staff accounts and tokens never become platform sessions;
//   - sign-in and sign-out are audited once each; /me writes nothing.
describe('Platform operator sign-in with mandatory TOTP (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: RedisService;
  const originalEnv = { ...process.env };
  const suffix = randomUUID().slice(0, 8);
  const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const DEV_PASSWORD = `sc1b-dev-password-${suffix}`;
  const operatorIds: string[] = [];
  const internalUserIds: string[] = [];

  const code = (offsetSeconds = 0) =>
    totpAt(decodeBase32(TOTP_SECRET), Date.now() / 1000 + offsetSeconds);
  const wrongCode = () => {
    const right = code();
    return right === '000000' ? '111111' : '000000';
  };
  const emailOf = (key: string) => `sc1b-${key}-${suffix}@example.test`;
  const http = () => request(app.getHttpServer());
  const post = (path: string, body: object) =>
    http().post(`/api/v1/platform/auth/${path}`).send(body);

  async function operator(
    key: string,
    status: 'ACTIVE' | 'DISABLED' = 'ACTIVE',
  ) {
    const row = await prisma.platformOperator.create({
      data: {
        externalProvider: 'platform-dev',
        externalSubject: `platform-dev:${emailOf(key)}`,
        email: emailOf(key),
        displayName: `SC1b ${key}`,
        status,
      },
    });
    operatorIds.push(row.id);
    return row;
  }

  const signIn = (key: string, password = DEV_PASSWORD) =>
    post('sign-in', { email: emailOf(key), password });
  async function challengeFor(key: string): Promise<string> {
    const res = await signIn(key).expect(200);
    return (res.body as { challenge: string }).challenge;
  }
  const auditFor = (where: object) =>
    prisma.platformAuditEvent.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = `sc1b-jwt-${randomUUID()}`;
    process.env.PLATFORM_AUTH_DEV_TOTP_SECRET = TOTP_SECRET;
    process.env.PLATFORM_AUTH_DEV_PASSWORD = DEV_PASSWORD;
    // The limiter is covered by protected-routes.spec; this suite signs in
    // many times from one loopback address.
    process.env.RATE_LIMIT_ENABLED = '0';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.init();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
  });

  // Pinned before every test: the local .env (loaded by ConfigModule) may
  // set any of these, e.g. the dev enrolment switch.
  beforeEach(() => {
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_TOTP_SECRET = TOTP_SECRET;
    delete process.env.PLATFORM_AUTH_DEV_MFA_ENROLLMENT;
  });

  afterAll(async () => {
    try {
      // The platform audit trail is append-only: leave this run's (uniquely
      // named) operators DISABLED rather than deleting them.
      await prisma.platformOperator.updateMany({
        where: { id: { in: operatorIds } },
        data: { status: 'DISABLED' },
      });
      await prisma.internalUser.deleteMany({
        where: { id: { in: internalUserIds } },
      });
    } finally {
      await app.close();
      process.env = { ...originalEnv };
    }
  });

  // --- the happy path --------------------------------------------------------

  it('password, then a TOTP code, then — and only then — a session for an ACTIVE operator; audited once', async () => {
    const row = await operator('happy');
    const step = await signIn('happy').expect(200);
    expect(step.headers['cache-control']).toBe('no-store');
    expect(Object.keys(step.body as object).sort()).toEqual([
      'challenge',
      'status',
    ]);
    expect(step.body).toMatchObject({ status: 'mfa-required' });
    const challenge = (step.body as { challenge: string }).challenge;
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const done = await post('mfa', { challenge, code: code() }).expect(200);
    const session = done.body as { idToken: string; expiresInSeconds: number };
    expect(session.expiresInSeconds).toBeGreaterThan(0);
    expect(session.expiresInSeconds).toBeLessThanOrEqual(3600);

    const me = await http()
      .get('/api/v1/platform/me')
      .set('Authorization', `Bearer ${session.idToken}`)
      .expect(200);
    expect((me.body as { operator: { id: string } }).operator.id).toBe(row.id);

    const events = await auditFor({ actorPlatformOperatorId: row.id });
    expect(events.map((e) => [e.action, e.outcome])).toEqual([
      ['platform.session.established', 'SUCCEEDED'],
    ]);
    expect(JSON.stringify(events)).not.toContain(session.idToken);
    const stored = await prisma.platformOperator.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(stored.lastAuthenticatedAt).not.toBeNull();
  });

  it('accepts a code from the adjacent time step (clock drift)', async () => {
    await operator('drift');
    const challenge = await challengeFor('drift');
    await post('mfa', { challenge, code: code(-30) }).expect(200);
  });

  // --- the challenge is server-side, short-lived and single-use --------------

  it('keeps the challenge server-side under a hashed key, without the password, expiring within 180 s', async () => {
    await operator('store');
    const challenge = await challengeFor('store');
    const key = `platform:signin-challenge:v1:${createHash('sha256')
      .update(challenge)
      .digest('hex')}`;
    const client = redis.getClient();
    const ttl = await client.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(PLATFORM_CHALLENGE_TTL_SECONDS);
    const stored = (await client.get(key))!;
    expect(stored).not.toContain(DEV_PASSWORD);
    expect(
      await client.exists(`platform:signin-challenge:v1:${challenge}`),
    ).toBe(0);
  });

  it('a wrong code ends the attempt: the same challenge cannot be retried, even with the right code', async () => {
    await operator('wrong-code');
    const challenge = await challengeFor('wrong-code');
    const wrong = await post('mfa', { challenge, code: wrongCode() }).expect(
      401,
    );
    expect((wrong.body as { message: string }).message).toBe(
      'That code was not accepted, or the sign-in expired. Sign in again.',
    );
    await post('mfa', { challenge, code: code() }).expect(401);
  });

  it('a challenge cannot be replayed after a successful sign-in', async () => {
    await operator('replay');
    const challenge = await challengeFor('replay');
    await post('mfa', { challenge, code: code() }).expect(200);
    await post('mfa', { challenge, code: code() }).expect(401);
  });

  it.each([
    [
      'an unknown handle',
      { challenge: randomBytes(32).toString('base64url'), code: '123456' },
      401,
    ],
    ['a malformed handle', { challenge: 'not-a-handle', code: '123456' }, 401],
    [
      'a non-numeric code',
      { challenge: randomBytes(32).toString('base64url'), code: 'abc123' },
      400,
    ],
    [
      'a short code',
      { challenge: randomBytes(32).toString('base64url'), code: '12345' },
      400,
    ],
  ])('%s is refused (%i) without a session', async (_l, body, status) => {
    const res = await post('mfa', body);
    expect(res.status).toBe(status);
    expect(JSON.stringify(res.body)).not.toContain('idToken');
  });

  // --- credentials and accounts ----------------------------------------------

  it('a wrong password gets the generic answer and no challenge', async () => {
    await operator('wrong-password');
    const res = await signIn('wrong-password', 'not-the-password').expect(401);
    expect(res.body).toMatchObject({ message: 'Invalid email or password.' });
    expect(JSON.stringify(res.body)).not.toContain('challenge');
  });

  it('missing or oversized fields are a 400', async () => {
    await post('sign-in', { email: '', password: 'x' }).expect(400);
    await post('sign-in', { email: 'a@example.test' }).expect(400);
    await post('sign-in', {
      email: 'a@example.test',
      password: 'x'.repeat(257),
    }).expect(400);
  });

  it('both factors for an identity with no operator record -> 403, audited, no token', async () => {
    const challenge = await challengeFor('nobody');
    const res = await post('mfa', { challenge, code: code() }).expect(403);
    expect(res.body).toMatchObject({
      message: 'This account is not permitted to access the platform area.',
    });
    expect(JSON.stringify(res.body)).not.toContain('idToken');
    const events = await auditFor({
      identitySubject: `platform-dev:${emailOf('nobody')}`,
    });
    expect(events.map((e) => [e.action, e.reasonCode])).toEqual([
      ['platform.access.denied', 'UNKNOWN_OPERATOR'],
    ]);
  });

  it('a DISABLED operator completing both factors -> 403, audited, no token', async () => {
    const row = await operator('disabled', 'DISABLED');
    const challenge = await challengeFor('disabled');
    await post('mfa', { challenge, code: code() }).expect(403);
    const events = await auditFor({ actorPlatformOperatorId: row.id });
    expect(events.map((e) => e.reasonCode)).toEqual(['OPERATOR_DISABLED']);
  });

  it("a tenant staff member's account never becomes a platform session, and a staff token is refused on the platform", async () => {
    const staff = await prisma.internalUser.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${emailOf('staff')}`,
        email: emailOf('staff'),
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    internalUserIds.push(staff.id);
    const challenge = await challengeFor('staff');
    await post('mfa', { challenge, code: code() }).expect(403);

    const staffToken = signInternalDevJwt(
      {
        sub: `internal-dev:${emailOf('staff')}`,
        email: emailOf('staff'),
        name: null,
      },
      process.env.INTERNAL_AUTH_DEV_JWT_SECRET!,
      3600,
    );
    await http()
      .post('/api/v1/platform/session/sign-out')
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(401);
  });

  // --- first-time authenticator enrolment -----------------------------------

  it('first sign-in enrols an authenticator: the secret is issued once, then the first code completes the sign-in', async () => {
    const row = await operator('enrol');
    process.env.PLATFORM_AUTH_DEV_MFA_ENROLLMENT = '1';
    const first = await signIn('enrol').expect(200);
    expect(first.body).toMatchObject({ status: 'mfa-setup-required' });
    const handle = (first.body as { challenge: string }).challenge;

    // Issuing the secret returns ONLY the next handle: the secret stays
    // server-side with the attempt (never in a browser cookie).
    const setup = await post('mfa-setup', { challenge: handle }).expect(200);
    expect(setup.headers['cache-control']).toBe('no-store');
    expect(Object.keys(setup.body as object)).toEqual(['challenge']);
    const next = (setup.body as { challenge: string }).challenge;
    expect(next).not.toBe(handle);

    // The setup page reads it with that handle — repeatably (a page reload),
    // without advancing the attempt.
    for (let i = 0; i < 2; i += 1) {
      const display = await post('mfa-setup/display', {
        challenge: next,
      }).expect(200);
      expect(display.headers['cache-control']).toBe('no-store');
      expect(display.body).toEqual({
        secret: TOTP_SECRET,
        otpauthUri: `otpauth://totp/${encodeURIComponent(`CENTERIVO:${emailOf('enrol')}`)}?secret=${TOTP_SECRET}&issuer=CENTERIVO&algorithm=SHA1&digits=6&period=30`,
      });
    }
    // The first handle is spent: it can neither mint a second secret nor
    // show the issued one.
    await post('mfa-setup', { challenge: handle }).expect(401);
    await post('mfa-setup/display', { challenge: handle }).expect(401);

    const done = await post('mfa-setup/verify', {
      challenge: next,
      code: code(),
    }).expect(200);
    // Once enrolment completes, the secret can no longer be shown.
    await post('mfa-setup/display', { challenge: next }).expect(401);
    expect((done.body as { idToken: string }).idToken).toBeTruthy();
    const events = await auditFor({ actorPlatformOperatorId: row.id });
    expect(events.map((e) => e.action)).toEqual([
      'platform.session.established',
    ]);
  });

  it('an enrolment challenge is not an MFA challenge (and is spent by the attempt)', async () => {
    await operator('kinds');
    process.env.PLATFORM_AUTH_DEV_MFA_ENROLLMENT = '1';
    const handle = await challengeFor('kinds');
    await post('mfa', { challenge: handle, code: code() }).expect(401);
    await post('mfa-setup', { challenge: handle }).expect(401);
  });

  it('enrolment cannot be verified before the secret was issued, nor with a wrong first code', async () => {
    await operator('enrol-wrong');
    process.env.PLATFORM_AUTH_DEV_MFA_ENROLLMENT = '1';
    const early = await challengeFor('enrol-wrong');
    await post('mfa-setup/verify', { challenge: early, code: code() }).expect(
      401,
    );

    const handle = await challengeFor('enrol-wrong');
    // Nothing to display before a secret has been issued.
    await post('mfa-setup/display', { challenge: handle }).expect(401);
    const setup = await post('mfa-setup', { challenge: handle }).expect(200);
    const next = (setup.body as { challenge: string }).challenge;
    await post('mfa-setup/verify', {
      challenge: next,
      code: wrongCode(),
    }).expect(401);
    await post('mfa-setup/verify', { challenge: next, code: code() }).expect(
      401,
    );
  });

  // --- fail closed -------------------------------------------------------------

  it('without the dev TOTP secret the dev sign-in fails closed (503, no detail)', async () => {
    await operator('no-totp');
    delete process.env.PLATFORM_AUTH_DEV_TOTP_SECRET;
    const res = await signIn('no-totp').expect(503);
    expect(res.body).toMatchObject({
      message: 'Platform sign-in is not available right now.',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/TOTP|PLATFORM_|secret/i);
  });

  it('with dev sign-in off, the unconfigured Cognito pool fails closed, and a dev challenge cannot be finished', async () => {
    await operator('switch');
    const challenge = await challengeFor('switch');
    delete process.env.PLATFORM_AUTH_PROVIDER;
    await signIn('switch').expect(503);
    await post('mfa', { challenge, code: code() }).expect(503);
  });

  // --- sign-out -----------------------------------------------------------------

  it('sign-out is audited for the signed-in operator; without a platform token it is refused', async () => {
    const row = await operator('sign-out');
    const challenge = await challengeFor('sign-out');
    const session = (await post('mfa', { challenge, code: code() }).expect(200))
      .body as { idToken: string };
    await http()
      .post('/api/v1/platform/session/sign-out')
      .set('Authorization', `Bearer ${session.idToken}`)
      .expect(204);
    await http().post('/api/v1/platform/session/sign-out').expect(401);
    const events = await auditFor({ actorPlatformOperatorId: row.id });
    expect(events.map((e) => e.action)).toEqual([
      'platform.session.established',
      'platform.session.ended',
    ]);
  });
});
