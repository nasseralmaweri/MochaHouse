import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  CustomerCommunicationPreferences,
  CustomerProfile,
  CustomerSignInResponse,
} from '@mocha-house/contracts';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomerAuthModule } from '../../customer-auth/customer-auth.module';
import { CustomersModule } from '../customers.module';
import { signDevJwt } from '../../customer-auth/infrastructure/dev-jwt';
import { deriveDevVerificationCode } from '../../customer-auth/infrastructure/dev-verification-code';
import { deriveDevRecoveryCode } from '../../customer-auth/infrastructure/dev-recovery-code';

describe('CustomerPreferencesController (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const devSecret = 'preferences-spec-secret';

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = devSecret;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, CustomerAuthModule, CustomersModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.customer.deleteMany({
      where: {
        externalProvider: 'dev',
        externalSubject: { startsWith: 'dev:test-4fp-' },
      },
    });
    await app.close();
    await prisma.$disconnect();
    process.env = { ...originalEnv };
  });

  const prefs = '/api/v1/customers/me/preferences';

  function token(identifier = `test-4fp-${randomUUID()}@example.com`): string {
    return signDevJwt(
      { sub: `dev:${identifier}`, email: identifier, name: null },
      devSecret,
      3600,
    );
  }

  it('rejects unauthenticated GET / PATCH with 401', async () => {
    await request(app.getHttpServer()).get(prefs).expect(401);
    await request(app.getHttpServer())
      .patch(prefs)
      .send({ marketingEmailOptIn: true })
      .expect(401);
  });

  it('rejects a malformed bearer token with 401', async () => {
    await request(app.getHttpServer())
      .patch(prefs)
      .set('Authorization', 'Bearer nope')
      .send({ marketingEmailOptIn: true })
      .expect(401);
  });

  it('a brand-new customer defaults to marketingEmailOptIn: false', async () => {
    const t = token();
    const res = await request(app.getHttpServer())
      .get(prefs)
      .set('Authorization', `Bearer ${t}`)
      .expect(200);
    expect(res.body as CustomerCommunicationPreferences).toEqual({
      marketingEmailOptIn: false,
    });
  });

  it('opts in, persists across requests, then opts back out', async () => {
    const t = token();

    const on = await request(app.getHttpServer())
      .patch(prefs)
      .set('Authorization', `Bearer ${t}`)
      .send({ marketingEmailOptIn: true })
      .expect(200);
    expect(on.body).toEqual({ marketingEmailOptIn: true });

    const readBack = await request(app.getHttpServer())
      .get(prefs)
      .set('Authorization', `Bearer ${t}`)
      .expect(200);
    expect(readBack.body).toEqual({ marketingEmailOptIn: true });

    const off = await request(app.getHttpServer())
      .patch(prefs)
      .set('Authorization', `Bearer ${t}`)
      .send({ marketingEmailOptIn: false })
      .expect(200);
    expect(off.body).toEqual({ marketingEmailOptIn: false });

    const readBackOff = await request(app.getHttpServer())
      .get(prefs)
      .set('Authorization', `Bearer ${t}`)
      .expect(200);
    expect(readBackOff.body).toEqual({ marketingEmailOptIn: false });
  });

  it('rejects a non-boolean value with 400 and does not change the stored preference', async () => {
    const t = token();
    await request(app.getHttpServer())
      .patch(prefs)
      .set('Authorization', `Bearer ${t}`)
      .send({ marketingEmailOptIn: true })
      .expect(200);

    for (const bad of ['true', 1, 0, null, 'yes']) {
      await request(app.getHttpServer())
        .patch(prefs)
        .set('Authorization', `Bearer ${t}`)
        .send({ marketingEmailOptIn: bad })
        .expect(400);
    }

    const still = await request(app.getHttpServer())
      .get(prefs)
      .set('Authorization', `Bearer ${t}`)
      .expect(200);
    expect(still.body).toEqual({ marketingEmailOptIn: true });
  });

  it('customer A cannot alter customer B', async () => {
    const a = token();
    const b = token();

    await request(app.getHttpServer())
      .patch(prefs)
      .set('Authorization', `Bearer ${b}`)
      .send({ marketingEmailOptIn: true })
      .expect(200);
    await request(app.getHttpServer())
      .patch(prefs)
      .set('Authorization', `Bearer ${a}`)
      .send({ marketingEmailOptIn: false })
      .expect(200);

    const bStill = await request(app.getHttpServer())
      .get(prefs)
      .set('Authorization', `Bearer ${b}`)
      .expect(200);
    expect(bStill.body).toEqual({ marketingEmailOptIn: true });
  });

  it('changing the preference never touches identity, status, email, or verification', async () => {
    const identifier = `test-4fp-${randomUUID()}@example.com`;
    const t = token(identifier);

    const before = await request(app.getHttpServer())
      .get('/api/v1/customers/me')
      .set('Authorization', `Bearer ${t}`)
      .expect(200);
    const beforeProfile = before.body as CustomerProfile;

    await request(app.getHttpServer())
      .patch(prefs)
      .set('Authorization', `Bearer ${t}`)
      .send({
        marketingEmailOptIn: true,
        status: 'DEACTIVATED',
        email: 'attacker@example.com',
        emailVerified: true,
        externalSubject: 'dev:someone-else',
      })
      .expect(200);

    const stored = await prisma.customer.findUnique({
      where: {
        externalProvider_externalSubject: {
          externalProvider: 'dev',
          externalSubject: `dev:${identifier}`,
        },
      },
    });
    expect(stored?.id).toBe(beforeProfile.id);
    expect(stored?.status).toBe('ACTIVE');
    expect(stored?.email).toBe(identifier);
    expect(stored?.emailVerifiedAt).toBeNull();
    expect(stored?.marketingEmailOptIn).toBe(true);
  });

  it('registration, sign-in JIT re-sync, and password reset never overwrite the preference', async () => {
    const email = `test-4fp-flow-${randomUUID()}@example.com`;

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'a-fine-password', displayName: 'Flow' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/auth/verify')
      .send({ email, code: deriveDevVerificationCode(email, devSecret) })
      .expect(201);

    const signIn1 = await request(app.getHttpServer())
      .post('/api/v1/auth/sign-in')
      .send({ identifier: email, password: 'a-fine-password' })
      .expect(201);
    const token1 = (signIn1.body as CustomerSignInResponse).idToken;

    await request(app.getHttpServer())
      .patch(prefs)
      .set('Authorization', `Bearer ${token1}`)
      .send({ marketingEmailOptIn: true })
      .expect(200);

    // Sign in again — this drives resolveOrCreateFromIdentity's update path.
    const signIn2 = await request(app.getHttpServer())
      .post('/api/v1/auth/sign-in')
      .send({ identifier: email, password: 'a-fine-password' })
      .expect(201);
    const token2 = (signIn2.body as CustomerSignInResponse).idToken;
    await request(app.getHttpServer())
      .get('/api/v1/customers/me')
      .set('Authorization', `Bearer ${token2}`)
      .expect(200);

    let read = await request(app.getHttpServer())
      .get(prefs)
      .set('Authorization', `Bearer ${token2}`)
      .expect(200);
    expect(read.body).toEqual({ marketingEmailOptIn: true });

    // Password reset (Milestone 4D) must not touch the Customer row.
    await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .send({
        email,
        code: deriveDevRecoveryCode(email, devSecret),
        newPassword: 'a-brand-new-password',
      })
      .expect(201);

    const signIn3 = await request(app.getHttpServer())
      .post('/api/v1/auth/sign-in')
      .send({ identifier: email, password: 'a-brand-new-password' })
      .expect(201);
    const token3 = (signIn3.body as CustomerSignInResponse).idToken;

    read = await request(app.getHttpServer())
      .get(prefs)
      .set('Authorization', `Bearer ${token3}`)
      .expect(200);
    expect(read.body).toEqual({ marketingEmailOptIn: true });
  });
});
