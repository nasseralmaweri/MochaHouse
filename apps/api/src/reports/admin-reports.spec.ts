import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminOrdersOverviewReport,
  OrderStatus,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { ReportsModule } from './reports.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';
import { businessDateStartInstant } from '../operations/application/business-date';

type Status = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

// Milestone 9A — HQ Digital Sales & Orders overview, over real local
// Postgres. Confirms the report is: permission/scope-gated exactly like
// every other Milestone 5-9 read-only Admin surface, mathematically
// correct against deterministic fixtures (integer minor units throughout),
// and honest about its digital-platform-only scope.
describe('Admin reports — orders overview (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'admin-reports-spec-internal-secret';
  const customerSecret = 'admin-reports-spec-customer-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const locationIds: string[] = [];
  const paymentAttemptIds: string[] = [];
  const orderIds: string[] = [];
  const customerIds: string[] = [];
  const roles: Record<string, string> = {};

  const token = (key: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${key}`, email: `${key}@example.com`, name: null },
      internalSecret,
      3600,
    );
  const customerToken = () =>
    signDevJwt(
      { sub: 'dev:x@example.com', email: 'x@example.com', name: null },
      customerSecret,
      3600,
    );

  async function makeUser(key: string, status: Status): Promise<string> {
    const user = await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${key}`,
        email: `${key}@example.com`,
        displayName: key,
        status,
        activatedAt: status === 'ACTIVE' ? new Date() : null,
      },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function makeRole(
    displayName: string,
    permissionKeys: string[],
  ): Promise<string> {
    const role = await prisma.internalRole.create({
      data: {
        key: `reports-spec-${suffix}-${randomUUID()}`,
        displayName,
        permissions: {
          create: permissionKeys.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    roleIds.push(role.id);
    return role.id;
  }

  async function assign(
    userId: string,
    roleId: string,
    scope: { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null },
  ) {
    await prisma.internalUserRoleAssignment.create({
      data: { internalUserId: userId, roleId, ...scope },
    });
  }

  async function makeCustomer(): Promise<string> {
    const customer = await prisma.customer.create({
      data: {
        externalProvider: 'dev',
        externalSubject: `reports-spec-${randomUUID()}`,
        email: `reports-spec-${randomUUID()}@example.com`,
      },
    });
    customerIds.push(customer.id);
    return customer.id;
  }

  async function makeLocation(name: string): Promise<string> {
    const location = await prisma.location.create({
      data: {
        name,
        slug: `reports-loc-${randomUUID()}`,
        isActive: true,
        isDigitalOrderingEnabled: true,
      },
    });
    locationIds.push(location.id);
    return location.id;
  }

  async function makeOrder(options: {
    locationId: string;
    subtotal: number;
    promotionDiscountMinorUnits?: number;
    rewardDiscountMinorUnits?: number;
    giftCardTenderMinorUnits?: number;
    status?: OrderStatus;
    createdAt?: Date;
    customerId?: string | null;
  }): Promise<string> {
    const attempt = await prisma.paymentAttempt.create({
      data: {
        idempotencyKey: `reports-spec-${randomUUID()}`,
        provider: 'fake',
        locationId: options.locationId,
        amount: options.subtotal,
        currency: 'USD',
        status: 'SUCCEEDED',
      },
    });
    paymentAttemptIds.push(attempt.id);

    const order = await prisma.order.create({
      data: {
        orderNumber: `RPT-${randomUUID().slice(0, 8)}`,
        accessToken: randomUUID(),
        locationId: options.locationId,
        customerId: options.customerId ?? null,
        paymentAttemptId: attempt.id,
        guestName: 'Reports Spec',
        guestPhone: '5550000000',
        currency: 'USD',
        subtotal: options.subtotal,
        promotionDiscountMinorUnits: options.promotionDiscountMinorUnits ?? 0,
        rewardDiscountMinorUnits: options.rewardDiscountMinorUnits ?? 0,
        giftCardTenderMinorUnits: options.giftCardTenderMinorUnits ?? 0,
        status: options.status ?? 'RECEIVED',
        ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      },
    });
    orderIds.push(order.id);
    return order.id;
  }

  const getOverview = (
    key: string,
    query: { startDate?: string; endDate?: string; locationId?: string } = {},
  ) => {
    const params = new URLSearchParams();
    if (query.startDate) params.set('startDate', query.startDate);
    if (query.endDate) params.set('endDate', query.endDate);
    if (query.locationId) params.set('locationId', query.locationId);
    const qs = params.toString();
    return request(app.getHttpServer())
      .get(`/api/v1/admin/reports/orders-overview${qs ? `?${qs}` : ''}`)
      .set('Authorization', `Bearer ${token(key)}`);
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = customerSecret;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        ReportsModule,
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    roles.reportsView = await makeRole('Reports Viewer', ['reports.view']);
    roles.noReports = await makeRole('Orders Only', ['orders.view']);

    await makeUser(`viewer-${suffix}`, 'ACTIVE');
    await assign(userIds.at(-1)!, roles.reportsView, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await makeUser(`locViewer-${suffix}`, 'ACTIVE');
    const scopeLoc = await makeLocation(`Scope Loc ${suffix}`);
    await assign(userIds.at(-1)!, roles.reportsView, {
      scopeType: 'LOCATION',
      scopeId: scopeLoc,
    });

    await makeUser(`noPerm-${suffix}`, 'ACTIVE');
    await assign(userIds.at(-1)!, roles.noReports, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await makeUser(`suspended-${suffix}`, 'SUSPENDED');
    await assign(userIds.at(-1)!, roles.reportsView, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
  }, 45_000);

  afterAll(async () => {
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIds } },
    });
    for (const id of roleIds) {
      await prisma.internalRolePermission.deleteMany({ where: { roleId: id } });
      await prisma.internalRole.deleteMany({ where: { id } });
    }
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.paymentAttempt.deleteMany({
      where: { id: { in: paymentAttemptIds } },
    });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.location.deleteMany({ where: { id: { in: locationIds } } });
    await app.close();
    process.env = { ...originalEnv };
  });

  // ---- Authorization ------------------------------------------

  it('an ACTIVE corporate user with reports.view gets 200', async () => {
    await getOverview(`viewer-${suffix}`, {
      startDate: '2026-01-01',
      endDate: '2026-01-01',
    }).expect(200);
  });

  it('an ACTIVE user without reports.view gets 403', async () => {
    await getOverview(`noPerm-${suffix}`, {
      startDate: '2026-01-01',
      endDate: '2026-01-01',
    }).expect(403);
  });

  it('a LOCATION-only reports.view grant cannot satisfy the CORPORATE-only route (403)', async () => {
    await getOverview(`locViewer-${suffix}`, {
      startDate: '2026-01-01',
      endDate: '2026-01-01',
    }).expect(403);
  });

  it('a customer token is rejected (401)', async () => {
    await request(app.getHttpServer())
      .get(
        '/api/v1/admin/reports/orders-overview?startDate=2026-01-01&endDate=2026-01-01',
      )
      .set('Authorization', `Bearer ${customerToken()}`)
      .expect(401);
  });

  it('a SUSPENDED internal user is blocked (403)', async () => {
    await getOverview(`suspended-${suffix}`, {
      startDate: '2026-01-01',
      endDate: '2026-01-01',
    }).expect(403);
  });

  // ---- Query validation -----------------------------------------

  it('requires startDate', async () => {
    await getOverview(`viewer-${suffix}`, { endDate: '2026-01-01' }).expect(
      400,
    );
  });

  it('requires endDate', async () => {
    await getOverview(`viewer-${suffix}`, { startDate: '2026-01-01' }).expect(
      400,
    );
  });

  it('rejects a malformed date', async () => {
    await getOverview(`viewer-${suffix}`, {
      startDate: '01/01/2026',
      endDate: '2026-01-01',
    }).expect(400);
  });

  it('rejects an impossible calendar date', async () => {
    await getOverview(`viewer-${suffix}`, {
      startDate: '2026-02-30',
      endDate: '2026-02-30',
    }).expect(400);
  });

  it('rejects startDate after endDate', async () => {
    await getOverview(`viewer-${suffix}`, {
      startDate: '2026-01-10',
      endDate: '2026-01-01',
    }).expect(400);
  });

  it('rejects an unknown locationId', async () => {
    await getOverview(`viewer-${suffix}`, {
      startDate: '2026-01-01',
      endDate: '2026-01-01',
      locationId: randomUUID(),
    }).expect(400);
  });

  // ---- Zero-order range -------------------------------------------

  it('a valid range with zero orders is not an error', async () => {
    const res = await getOverview(`viewer-${suffix}`, {
      startDate: '2020-01-01',
      endDate: '2020-01-01',
    }).expect(200);
    const body = res.body as AdminOrdersOverviewReport;
    expect(body.totalOrders).toBe(0);
    expect(body.completedOrders).toBe(0);
    expect(body.digitalSalesMinorUnits).toBe(0);
    expect(body.averageOrderValueMinorUnits).toBe(0);
    for (const status of [
      'RECEIVED',
      'ACCEPTED',
      'PREPARING',
      'READY',
      'COMPLETED',
    ] as const) {
      expect(body.statusBreakdown[status]).toBe(0);
    }
  });

  // ---- Metrics math, over a deterministic fixture set ---------------

  describe('with fixtures', () => {
    const day = '2026-09-15';
    let locationA: string;
    let locationB: string;

    beforeAll(async () => {
      locationA = await makeLocation(`Fixture A ${suffix}`);
      locationB = await makeLocation(`Fixture B ${suffix}`);
      const createdAt = businessDateStartInstant('2026-09-15'); // start of the business day, in-range
      const oneHourIn = new Date(createdAt.getTime() + 60 * 60 * 1000);

      // Location A: 3 orders.
      // #1: subtotal 1000, promo 100, reward 50 -> net 850. RECEIVED. Guest (no customerId).
      await makeOrder({
        locationId: locationA,
        subtotal: 1000,
        promotionDiscountMinorUnits: 100,
        rewardDiscountMinorUnits: 50,
        status: 'RECEIVED',
        createdAt: oneHourIn,
        customerId: null,
      });
      // #2: subtotal 2000, gift card tender 500 (NOT subtracted) -> net 2000. COMPLETED.
      const customerId = await makeCustomer();
      await makeOrder({
        locationId: locationA,
        subtotal: 2000,
        giftCardTenderMinorUnits: 500,
        status: 'COMPLETED',
        createdAt: oneHourIn,
        customerId,
      });
      // #3: subtotal 500, no discounts -> net 500. COMPLETED.
      await makeOrder({
        locationId: locationA,
        subtotal: 500,
        status: 'COMPLETED',
        createdAt: oneHourIn,
      });

      // Location B: 1 order, ACCEPTED, net 300.
      await makeOrder({
        locationId: locationB,
        subtotal: 300,
        status: 'ACCEPTED',
        createdAt: oneHourIn,
      });

      // Out of range: the instant exactly at the exclusive upper boundary
      // (start of the NEXT business day) must never be counted.
      const nextDayStart = businessDateStartInstant('2026-09-16');
      await makeOrder({
        locationId: locationA,
        subtotal: 99999,
        status: 'RECEIVED',
        createdAt: nextDayStart,
      });

      // Out of range: the instant one millisecond before the range start
      // must never be counted.
      const justBefore = new Date(createdAt.getTime() - 1);
      await makeOrder({
        locationId: locationA,
        subtotal: 88888,
        status: 'RECEIVED',
        createdAt: justBefore,
      });
    }, 30_000);

    it('aggregates across every location when locationId is omitted', async () => {
      const res = await getOverview(`viewer-${suffix}`, {
        startDate: day,
        endDate: day,
      }).expect(200);
      const body = res.body as AdminOrdersOverviewReport;

      expect(body.totalOrders).toBe(4); // 3 at A + 1 at B, excluding the two out-of-range orders
      expect(body.completedOrders).toBe(2);
      // (1000-100-50) + (2000-0-0) + (500-0-0) + (300-0-0) = 850+2000+500+300
      expect(body.digitalSalesMinorUnits).toBe(3650);
      expect(body.averageOrderValueMinorUnits).toBe(Math.round(3650 / 4));
      expect(body.location).toBeNull();
      expect(body.filters.locationId).toBeNull();
    });

    it('filters to a single location', async () => {
      const res = await getOverview(`viewer-${suffix}`, {
        startDate: day,
        endDate: day,
        locationId: locationB,
      }).expect(200);
      const body = res.body as AdminOrdersOverviewReport;

      expect(body.totalOrders).toBe(1);
      expect(body.completedOrders).toBe(0);
      expect(body.digitalSalesMinorUnits).toBe(300);
      expect(body.averageOrderValueMinorUnits).toBe(300);
      expect(body.location).toEqual({ id: locationB, name: `Fixture B ${suffix}` });
      expect(body.filters.locationId).toBe(locationB);
    });

    it('subtracts the promotion discount from digital sales', async () => {
      const res = await getOverview(`viewer-${suffix}`, {
        startDate: day,
        endDate: day,
        locationId: locationA,
      }).expect(200);
      const body = res.body as AdminOrdersOverviewReport;
      // Order #1 alone contributes 850 (1000 - 100 promo - 50 reward); the
      // location-A total below confirms both discounts landed correctly.
      expect(body.digitalSalesMinorUnits).toBe(850 + 2000 + 500);
    });

    it('does NOT subtract gift card tender (a payment method, not a discount)', async () => {
      const res = await getOverview(`viewer-${suffix}`, {
        startDate: day,
        endDate: day,
        locationId: locationA,
      }).expect(200);
      const body = res.body as AdminOrdersOverviewReport;
      // Order #2 has subtotal 2000 and a 500 gift-card tender; if tender
      // were wrongly subtracted, location A's total would be 400 lower.
      expect(body.digitalSalesMinorUnits).toBe(850 + 2000 + 500);
    });

    it('reports the correct status breakdown', async () => {
      const res = await getOverview(`viewer-${suffix}`, {
        startDate: day,
        endDate: day,
        locationId: locationA,
      }).expect(200);
      const body = res.body as AdminOrdersOverviewReport;
      expect(body.statusBreakdown).toEqual({
        RECEIVED: 1,
        ACCEPTED: 0,
        PREPARING: 0,
        READY: 0,
        COMPLETED: 2,
      });
    });

    it('includes guest orders (no customerId) in order-level totals', async () => {
      const res = await getOverview(`viewer-${suffix}`, {
        startDate: day,
        endDate: day,
        locationId: locationA,
      }).expect(200);
      const body = res.body as AdminOrdersOverviewReport;
      // Order #1 is a guest order (customerId: null) and IS counted —
      // totalOrders for location A is 3, not 2.
      expect(body.totalOrders).toBe(3);
    });

    it('excludes orders created outside the business-day window (America/Detroit)', async () => {
      const res = await getOverview(`viewer-${suffix}`, {
        startDate: day,
        endDate: day,
        locationId: locationA,
      }).expect(200);
      const body = res.body as AdminOrdersOverviewReport;
      // If the boundary orders (99999 / 88888 subtotal) leaked in, sales
      // and order count would be far higher than the in-range fixtures.
      expect(body.totalOrders).toBe(3);
      expect(body.digitalSalesMinorUnits).toBeLessThan(90000);
    });

    it('lists every active location as availableLocations', async () => {
      const res = await getOverview(`viewer-${suffix}`, {
        startDate: day,
        endDate: day,
      }).expect(200);
      const body = res.body as AdminOrdersOverviewReport;
      const ids = body.availableLocations.map((l) => l.id);
      expect(ids).toContain(locationA);
      expect(ids).toContain(locationB);
    });

    it('states the digital-platform-only source scope', async () => {
      const res = await getOverview(`viewer-${suffix}`, {
        startDate: day,
        endDate: day,
      }).expect(200);
      const body = res.body as AdminOrdersOverviewReport;
      expect(body.source.scope).toBe('DIGITAL_PLATFORM_ONLY');
      expect(body.source.scopeLabel.toLowerCase()).toContain('digital-platform');
      expect(body.source.scopeLabel.toLowerCase()).toContain('pos');
      expect(body.source.freshnessLabel).toBe('Live platform data');
    });
  });

  // ---- Permission regression ----------------------------

  it('Platform Administrator has reports.view; Store Manager does not', async () => {
    const pa = await prisma.internalRole.findUniqueOrThrow({
      where: { key: 'platform-administrator' },
      include: { permissions: true },
    });
    const sm = await prisma.internalRole.findUniqueOrThrow({
      where: { key: 'store-manager' },
      include: { permissions: true },
    });
    expect(pa.permissions.map((p) => p.permissionKey)).toContain(
      'reports.view',
    );
    expect(sm.permissions.map((p) => p.permissionKey)).not.toContain(
      'reports.view',
    );
  });
});
