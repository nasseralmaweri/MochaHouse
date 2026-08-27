import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { CustomerSignInResponse } from '@mocha-house/contracts';
import { PrismaModule } from '../../prisma/prisma.module';
import { CustomerAuthModule } from '../customer-auth.module';

describe('POST /api/v1/auth/sign-in (integration, dev provider)', () => {
  let app: INestApplication<App>;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'auth-controller-spec-secret';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, CustomerAuthModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env = { ...originalEnv };
  });

  it('rejects a request missing identifier or password', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/sign-in')
      .send({ identifier: 'test@example.com' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/auth/sign-in')
      .send({ password: 'anything' })
      .expect(400);
  });

  it('returns a bearer token for the dev auth boundary', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/sign-in')
      .send({ identifier: 'test@example.com', password: 'anything' })
      .expect(201);

    const body = response.body as CustomerSignInResponse;
    expect(typeof body.idToken).toBe('string');
    expect(body.idToken.split('.')).toHaveLength(3);
    expect(body.expiresInSeconds).toBeGreaterThan(0);
  });
});
