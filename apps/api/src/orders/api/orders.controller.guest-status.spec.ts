import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import { NotFoundException } from '@nestjs/common';
import request from 'supertest';
import { OrdersController, pickAccessToken } from './orders.controller';
import { CheckoutService } from '../application/checkout.service';
import {
  RateLimitEnforcer,
  RateLimitGuard,
} from '../../rate-limit/rate-limit.guard';
import { OptionalCustomerAuthGuard } from '../../customer-auth/infrastructure/optional-customer-auth.guard';

// R1 / S3c — the guest status endpoint accepts the access token in the
// X-Order-Access-Token header (so it never reaches a request URL), still
// accepts the deprecated ?accessToken= form, and is never cacheable. The
// tenant/order/token binding itself lives in CheckoutService.getStatus (covered
// by the tenant storefront isolation specs); here the service is a stub that
// records what the controller hands it.
describe('GET /api/v1/orders/:orderId — guest token transport', () => {
  let app: INestApplication<App>;
  const getStatus = jest.fn<Promise<unknown>, [string, string, unknown]>();
  const releaseOnSuccess = jest.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [
        { provide: CheckoutService, useValue: { getStatus } },
        { provide: RateLimitEnforcer, useValue: { releaseOnSuccess } },
      ],
    })
      .overrideGuard(RateLimitGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(OptionalCustomerAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    // Stand in for the tenant middleware.
    app.use(
      (req: { tenantContext?: unknown }, _res: unknown, next: () => void) => {
        req.tenantContext = { tenantId: 'tenant-1' };
        next();
      },
    );
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    getStatus.mockReset();
    getStatus.mockResolvedValue({ orderId: 'o1', status: 'PREPARING' });
  });

  it('reads the token from the header and passes order, token and tenant on', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/orders/o1')
      .set('x-order-access-token', 'header-token');
    expect(res.status).toBe(200);
    expect(getStatus).toHaveBeenCalledWith('o1', 'header-token', {
      tenantId: 'tenant-1',
    });
  });

  it('still accepts the deprecated query form', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/orders/o1')
      .query({ accessToken: 'query-token' })
      .expect(200);
    expect(getStatus).toHaveBeenCalledWith(
      'o1',
      'query-token',
      expect.anything(),
    );
  });

  it('prefers the header when both are sent', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/orders/o1')
      .query({ accessToken: 'query-token' })
      .set('x-order-access-token', 'header-token');
    expect(getStatus.mock.calls[0][1]).toBe('header-token');
  });

  it('treats no token, or a repeated query parameter, as an empty credential', async () => {
    await request(app.getHttpServer()).get('/api/v1/orders/o1');
    await request(app.getHttpServer()).get(
      '/api/v1/orders/o1?accessToken=a&accessToken=b',
    );
    expect(getStatus.mock.calls.map((c) => c[1])).toEqual(['', '']);
  });

  it('is never cacheable, on success and on not-found', async () => {
    const ok = await request(app.getHttpServer())
      .get('/api/v1/orders/o1')
      .set('x-order-access-token', 't');
    expect(ok.headers['cache-control']).toBe('no-store');
    getStatus.mockRejectedValue(new NotFoundException('Order not found.'));
    const missing = await request(app.getHttpServer())
      .get('/api/v1/orders/o1')
      .set('x-order-access-token', 'bad');
    expect(missing.status).toBe(404);
    expect(missing.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(missing.body)).not.toContain('bad');
  });

  it('gives back the failure-count only on success', async () => {
    releaseOnSuccess.mockClear();
    await request(app.getHttpServer())
      .get('/api/v1/orders/o1')
      .set('x-order-access-token', 't');
    expect(releaseOnSuccess).toHaveBeenCalledTimes(1);
    getStatus.mockRejectedValue(new NotFoundException('Order not found.'));
    await request(app.getHttpServer())
      .get('/api/v1/orders/o1')
      .set('x-order-access-token', 'x');
    expect(releaseOnSuccess).toHaveBeenCalledTimes(1);
  });
});

describe('pickAccessToken', () => {
  it('prefers the header, falls back to the query, and rejects non-strings', () => {
    expect(pickAccessToken('h', 'q')).toBe('h');
    expect(pickAccessToken(undefined, 'q')).toBe('q');
    expect(pickAccessToken(undefined, undefined)).toBe('');
    expect(pickAccessToken(['a', 'b'], 'q')).toBe('');
    expect(pickAccessToken(undefined, ['a', 'b'])).toBe('');
  });
});
