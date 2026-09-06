import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { CustomerLoyaltySummary } from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';
import { LoyaltyModule } from './loyalty.module';

// Milestone 7A — GET /api/v1/customers/me/loyalty over real HTTP. Proves the
// customer can read only their OWN balance, that the balance is the
// materialized account balance, and that no customer-facing history
// endpoint exists.
describe('GET /api/v1/customers/me/loyalty (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const devSecret = 'customer-loyalty-spec-secret';
  const SUBJECT_PREFIX = 'dev:loyalty-me-';

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = devSecret;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        LoyaltyModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.customer.deleteMany({
      where: {
        externalProvider: 'dev',
        externalSubject: { startsWith: SUBJECT_PREFIX },
      },
    });
    await app.close();
    process.env = { ...originalEnv };
  });

  function devToken(identifier: string): string {
    return signDevJwt(
      { sub: `${SUBJECT_PREFIX}${identifier}`, email: `${identifier}@x.test`, name: null },
      devSecret,
      3600,
    );
  }

  async function seedBalance(subject: string, balance: number): Promise<string> {
    const customer = await prisma.customer.create({
      data: {
        externalProvider: 'dev',
        externalSubject: subject,
        email: `${subject}@x.test`,
      },
    });
    await prisma.customerLoyaltyAccount.create({
      data: { customerId: customer.id, balance },
    });
    return customer.id;
  }

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/customers/me/loyalty')
      .expect(401);
  });

  it('returns 0 for a customer who has never earned', async () => {
    const token = devToken(randomUUID());
    const response = await request(app.getHttpServer())
      .get('/api/v1/customers/me/loyalty')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((response.body as CustomerLoyaltySummary).balance).toBe(0);
  });

  it('returns the caller\'s own materialized balance', async () => {
    const identifier = randomUUID();
    await seedBalance(`${SUBJECT_PREFIX}${identifier}`, 125);
    const token = devToken(identifier);

    const response = await request(app.getHttpServer())
      .get('/api/v1/customers/me/loyalty')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const body = response.body as CustomerLoyaltySummary;
    expect(body).toEqual({ balance: 125 });
  });

  it('never returns another customer\'s balance', async () => {
    const otherId = randomUUID();
    await seedBalance(`${SUBJECT_PREFIX}${otherId}`, 999);

    // A different caller — freshly provisioned, no balance.
    const token = devToken(randomUUID());
    const response = await request(app.getHttpServer())
      .get('/api/v1/customers/me/loyalty')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect((response.body as CustomerLoyaltySummary).balance).toBe(0);
  });

  it('exposes no customer-facing Bean history endpoint', async () => {
    const token = devToken(randomUUID());
    for (const path of [
      '/api/v1/customers/me/loyalty/history',
      '/api/v1/customers/me/loyalty/entries',
      '/api/v1/customers/me/loyalty/ledger',
      '/api/v1/customers/me/loyalty/transactions',
    ]) {
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    }
  });
});
