import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
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
import { LocalDevPasswordRecoveryProvider } from './infrastructure/local-dev-password-recovery.provider';
import { deriveDevVerificationCode } from './infrastructure/dev-verification-code';
import { deriveDevRecoveryCode } from './infrastructure/dev-recovery-code';

// Full HTTP integration test for the Milestone 4D journey: (register ->
// verify ->) Forgot Password -> Reset Password -> Sign In with the new
// password, wired exactly as AppModule wires CustomerAuthModule +
// CustomersModule and using the dev auth boundary throughout (see
// auth-provider-mode.ts). CognitoPasswordRecoveryProvider has its own
// mocked-fetch unit tests; this proves the pieces are wired end to end and
// that a reset never touches Customer identity/verification/status.
describe('Customer password recovery + reset (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let recoveryProvider: LocalDevPasswordRecoveryProvider;
  const devSecret = 'password-recovery-flow-spec-secret';
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
    recoveryProvider = moduleFixture.get(LocalDevPasswordRecoveryProvider);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.customer.deleteMany({
      where: {
        externalProvider: 'dev',
        externalSubject: { startsWith: 'dev:test-recovery-' },
      },
    });
    await app.close();
    await prisma.$disconnect();
    process.env = { ...originalEnv };
  });

  function uniqueEmail(label: string): string {
    return `test-recovery-${label}-${randomUUID()}@example.com`;
  }

  async function findCustomer(email: string) {
    return prisma.customer.findFirst({
      where: { externalProvider: 'dev', externalSubject: `dev:${email}` },
    });
  }

  async function registerVerified(
    email: string,
    password: string,
  ): Promise<void> {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, displayName: 'Recovery Test' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/auth/verify')
      .send({ email, code: deriveDevVerificationCode(email, devSecret) })
      .expect(201);
  }

  const NEUTRAL_MESSAGE =
    'If an account exists for that email, a password recovery code has been sent.';

  describe('POST /api/v1/auth/forgot-password', () => {
    it('returns the neutral acknowledgement for a known, verified account', async () => {
      const email = uniqueEmail('known');
      await registerVerified(email, 'original-password');

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email })
        .expect(201);

      expect(response.body).toEqual({ message: NEUTRAL_MESSAGE });
    });

    it('returns the identical acknowledgement for an email with no account (no enumeration signal)', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email: uniqueEmail('nobody') })
        .expect(201);

      expect(response.body).toEqual({ message: NEUTRAL_MESSAGE });
    });

    it('returns the identical acknowledgement for a registered but unverified account', async () => {
      const email = uniqueEmail('unverified');
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password: 'original-password', displayName: 'U' })
        .expect(201);

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email })
        .expect(201);

      expect(response.body).toEqual({ message: NEUTRAL_MESSAGE });
    });

    it('rejects a syntactically invalid email with 400', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'not-an-email' })
        .expect(400);
    });

    it('surfaces a genuine provider outage as 5xx rather than a fake success', async () => {
      const email = uniqueEmail('outage');
      await registerVerified(email, 'original-password');

      const spy = jest
        .spyOn(recoveryProvider, 'startPasswordRecovery')
        .mockRejectedValueOnce(new ServiceUnavailableException('boom'));

      await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email })
        .expect(503);

      spy.mockRestore();
    });
  });

  describe('POST /api/v1/auth/reset-password', () => {
    it('completes the journey: reset succeeds, old password fails, new password signs in as the same Customer', async () => {
      const email = uniqueEmail('journey');
      await registerVerified(email, 'original-password');
      const before = await findCustomer(email);
      expect(before).not.toBeNull();

      await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email })
        .expect(201);

      const resetResponse = await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({
          email,
          code: deriveDevRecoveryCode(email, devSecret),
          newPassword: 'a-brand-new-password',
        })
        .expect(201);
      expect(resetResponse.body).toEqual({ email });

      // Old password no longer authenticates.
      await request(app.getHttpServer())
        .post('/api/v1/auth/sign-in')
        .send({ identifier: email, password: 'original-password' })
        .expect(401);

      // New password does, and resolves the same Mocha House Customer.
      const signIn = await request(app.getHttpServer())
        .post('/api/v1/auth/sign-in')
        .send({ identifier: email, password: 'a-brand-new-password' })
        .expect(201);
      const { idToken } = signIn.body as CustomerSignInResponse;

      const me = await request(app.getHttpServer())
        .get('/api/v1/customers/me')
        .set('Authorization', `Bearer ${idToken}`)
        .expect(200);
      expect((me.body as CustomerProfile).id).toBe(before?.id);

      // The reset changed nothing about the Customer identity record.
      const after = await findCustomer(email);
      expect(after?.id).toBe(before?.id);
      expect(after?.emailVerifiedAt?.toISOString()).toBe(
        before?.emailVerifiedAt?.toISOString(),
      );
      expect(after?.status).toBe(before?.status);
      const all = await prisma.customer.findMany({
        where: { externalProvider: 'dev', externalSubject: `dev:${email}` },
      });
      expect(all).toHaveLength(1);
    });

    it('rejects a wrong recovery code with 400 and leaves the old password working', async () => {
      const email = uniqueEmail('wrongcode');
      await registerVerified(email, 'original-password');
      await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email })
        .expect(201);

      const correct = deriveDevRecoveryCode(email, devSecret);
      const wrong = correct === '000000' ? '111111' : '000000';

      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ email, code: wrong, newPassword: 'a-brand-new-password' })
        .expect(400);

      await request(app.getHttpServer())
        .post('/api/v1/auth/sign-in')
        .send({ identifier: email, password: 'original-password' })
        .expect(201);
    });

    it('rejects a weak new password with 400 and leaves the old password working', async () => {
      const email = uniqueEmail('weakpw');
      await registerVerified(email, 'original-password');
      await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({
          email,
          code: deriveDevRecoveryCode(email, devSecret),
          newPassword: 'short',
        })
        .expect(400);

      await request(app.getHttpServer())
        .post('/api/v1/auth/sign-in')
        .send({ identifier: email, password: 'original-password' })
        .expect(201);
    });

    it('rejects an expired recovery code with 400', async () => {
      const email = uniqueEmail('expired');
      await registerVerified(email, 'original-password');
      await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email })
        .expect(201);

      const originalTtl = recoveryProvider.recoveryCodeTtlMs;
      recoveryProvider.recoveryCodeTtlMs = 10;
      try {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await request(app.getHttpServer())
          .post('/api/v1/auth/reset-password')
          .send({
            email,
            code: deriveDevRecoveryCode(email, devSecret),
            newPassword: 'a-brand-new-password',
          })
          .expect(400);
      } finally {
        recoveryProvider.recoveryCodeTtlMs = originalTtl;
      }
    });

    it('rejects a reset with no preceding forgot-password call with a neutral 400', async () => {
      const email = uniqueEmail('nostate');
      await registerVerified(email, 'original-password');

      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({
          email,
          code: deriveDevRecoveryCode(email, devSecret),
          newPassword: 'a-brand-new-password',
        })
        .expect(400);
    });

    it('rejects a reset for an entirely unknown email with a neutral 400 (not a 404)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({
          email: uniqueEmail('ghost'),
          code: '123456',
          newPassword: 'a-brand-new-password',
        })
        .expect(400);
    });

    it('does not establish a session or return a token on success', async () => {
      const email = uniqueEmail('nosession');
      await registerVerified(email, 'original-password');
      await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email })
        .expect(201);

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({
          email,
          code: deriveDevRecoveryCode(email, devSecret),
          newPassword: 'a-brand-new-password',
        })
        .expect(201);

      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.body).toEqual({ email });
      expect(JSON.stringify(response.body)).not.toContain(
        'a-brand-new-password',
      );
    });
  });
});
