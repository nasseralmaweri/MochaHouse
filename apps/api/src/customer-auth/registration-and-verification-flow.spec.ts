import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  CustomerProfile,
  CustomerSignInResponse,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomersModule } from '../customers/customers.module';
import { CustomerAuthModule } from './customer-auth.module';
import { LocalDevRegistrationProvider } from './infrastructure/local-dev-registration.provider';
import { deriveDevVerificationCode } from './infrastructure/dev-verification-code';

// Full HTTP integration test for the Milestone 4C journey: Register ->
// Verify -> Sign In -> /customers/me, wired exactly as AppModule wires
// CustomerAuthModule + CustomersModule. Uses the dev registration/auth
// boundary throughout (see auth-provider-mode.ts) — CognitoRegistrationProvider
// and CognitoAuthProvider have their own mocked-fetch unit tests; this file
// proves the pieces are wired together correctly end to end.
describe('Customer registration + email verification (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let localDevRegistrationProvider: LocalDevRegistrationProvider;
  const devSecret = 'registration-flow-spec-secret';
  const originalEnv = { ...process.env };

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
    localDevRegistrationProvider = moduleFixture.get(
      LocalDevRegistrationProvider,
    );
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.customer.deleteMany({
      where: {
        externalProvider: 'dev',
        externalSubject: { startsWith: 'dev:test-' },
      },
    });
    await app.close();
    await prisma.$disconnect();
    process.env = { ...originalEnv };
  });

  function uniqueEmail(label: string): string {
    return `test-${label}-${randomUUID()}@example.com`;
  }

  function codeFor(email: string): string {
    return deriveDevVerificationCode(email, devSecret);
  }

  function wrongCodeFor(email: string): string {
    const correct = codeFor(email);
    return correct === '000000' ? '111111' : '000000';
  }

  async function findCustomer(email: string) {
    return prisma.customer.findFirst({
      where: { externalProvider: 'dev', externalSubject: `dev:${email}` },
    });
  }

  it('registers, creates exactly one Customer with the correct identity and a null emailVerifiedAt', async () => {
    const email = uniqueEmail('register');

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email,
        password: 'a-fine-password',
        displayName: 'Test Customer',
      })
      .expect(201);

    expect(response.body).toEqual({ email });

    const matches = await prisma.customer.findMany({
      where: { externalProvider: 'dev', externalSubject: `dev:${email}` },
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].email).toBe(email);
    expect(matches[0].displayName).toBe('Test Customer');
    expect(matches[0].emailVerifiedAt).toBeNull();
  });

  it('rejects duplicate registration for the same email with 409 and creates no second Customer', async () => {
    const email = uniqueEmail('dup');
    const payload = {
      email,
      password: 'a-fine-password',
      displayName: 'Test Customer',
    };

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send(payload)
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send(payload)
      .expect(409);

    const matches = await prisma.customer.findMany({
      where: { externalProvider: 'dev', externalSubject: `dev:${email}` },
    });
    expect(matches).toHaveLength(1);
  });

  it('safely rejects a password-policy failure and creates no Customer', async () => {
    const email = uniqueEmail('badpw');

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'short', displayName: 'Test Customer' })
      .expect(400);

    expect(await findCustomer(email)).toBeNull();
  });

  it('rejects sign-in for a registered but unverified customer', async () => {
    const email = uniqueEmail('unverified');
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email,
        password: 'a-fine-password',
        displayName: 'Test Customer',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/auth/sign-in')
      .send({ identifier: email, password: 'a-fine-password' })
      .expect(401);
  });

  it('rejects an incorrect verification code without verifying or corrupting the Customer', async () => {
    const email = uniqueEmail('wrongcode');
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email,
        password: 'a-fine-password',
        displayName: 'Test Customer',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/auth/verify')
      .send({ email, code: wrongCodeFor(email) })
      .expect(400);

    const customer = await findCustomer(email);
    expect(customer?.emailVerifiedAt).toBeNull();
  });

  it('rejects an expired verification code', async () => {
    const email = uniqueEmail('expired');
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email,
        password: 'a-fine-password',
        displayName: 'Test Customer',
      })
      .expect(201);

    const originalTtl = localDevRegistrationProvider.codeTtlMs;
    localDevRegistrationProvider.codeTtlMs = 10;
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await request(app.getHttpServer())
        .post('/api/v1/auth/verify')
        .send({ email, code: codeFor(email) })
        .expect(400);
    } finally {
      localDevRegistrationProvider.codeTtlMs = originalTtl;
    }

    const customer = await findCustomer(email);
    expect(customer?.emailVerifiedAt).toBeNull();
  });

  it('returns 404 verifying an email that was never registered', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/verify')
      .send({ email: uniqueEmail('never'), code: '123456' })
      .expect(404);
  });

  it('normalizes re-verifying an already-verified account as success rather than an error', async () => {
    const email = uniqueEmail('reverify');
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email,
        password: 'a-fine-password',
        displayName: 'Test Customer',
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/auth/verify')
      .send({ email, code: codeFor(email) })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/auth/verify')
      .send({ email, code: codeFor(email) })
      .expect(201);
  });

  it('completes the full journey: register -> verify -> sign in -> /customers/me resolves the same Customer', async () => {
    const email = uniqueEmail('fulljourney');

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'a-fine-password', displayName: 'Full Journey' })
      .expect(201);

    const beforeVerify = await findCustomer(email);
    expect(beforeVerify).not.toBeNull();
    expect(beforeVerify?.emailVerifiedAt).toBeNull();

    const verifyResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/verify')
      .send({ email, code: codeFor(email) })
      .expect(201);
    expect(verifyResponse.body).toEqual({ email });

    const afterVerify = await findCustomer(email);
    expect(afterVerify?.id).toBe(beforeVerify?.id);
    expect(afterVerify?.emailVerifiedAt).not.toBeNull();

    const signInResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/sign-in')
      .send({ identifier: email, password: 'a-fine-password' })
      .expect(201);
    const { idToken } = signInResponse.body as CustomerSignInResponse;

    const meResponse = await request(app.getHttpServer())
      .get('/api/v1/customers/me')
      .set('Authorization', `Bearer ${idToken}`)
      .expect(200);
    const profile = meResponse.body as CustomerProfile;
    expect(profile.id).toBe(beforeVerify?.id);

    // No duplicate was ever created across register, verify, and the
    // JIT-provisioning sign-in path all resolving the same identity.
    const allMatches = await prisma.customer.findMany({
      where: { externalProvider: 'dev', externalSubject: `dev:${email}` },
    });
    expect(allMatches).toHaveLength(1);
  });

  describe('verification resend', () => {
    it('resends and the (still-deterministic) code verifies successfully afterward', async () => {
      const email = uniqueEmail('resend');
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email,
          password: 'a-fine-password',
          displayName: 'Test Customer',
        })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/auth/verification/resend')
        .send({ email })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/auth/verify')
        .send({ email, code: codeFor(email) })
        .expect(201);
    });

    it('returns 404 for an unregistered email', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/verification/resend')
        .send({ email: uniqueEmail('never') })
        .expect(404);
    });

    it('returns 409 for an already-verified account', async () => {
      const email = uniqueEmail('resendverified');
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email,
          password: 'a-fine-password',
          displayName: 'Test Customer',
        })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/auth/verify')
        .send({ email, code: codeFor(email) })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/auth/verification/resend')
        .send({ email })
        .expect(409);
    });
  });
});
