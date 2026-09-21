import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminLocationPerformanceReport,
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

// Milestone 9B — HQ Location Performance, over real local Postgres.
// Confirms the report is: permission/scope-gated identically to 9A,
// mathematically correct per location against deterministic fixtures, uses
// the approved active/inactive inclusion rule, and stays honest about its
// digital-platform-only scope — this compares locations against EACH
// OTHER, never against a total-store/POS figure.
describe('Admin reports — location performance (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'admin-location-perf-spec-internal-secret';
  const customerSecret = 'admin-location-perf-spec-customer-secret';
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
        key: `location-perf-spec-${suffix}-${randomUUID()}`,
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
        externalSubject: `location-perf-spec-${randomUUID()}`,
        email: `location-perf-spec-${randomUUID()}@example.com`,
      },
    });
    customerIds.push(customer.id);
    return customer.id;
  }

  async function makeLocation(
    name: string,
    options: { isActive?: boolean; isDigitalOrderingEnabled?: boolean } = {},
  ): Promise<string> {
    const location = await prisma.location.create({
      data: {
        name,
        slug: `location-perf-loc-${randomUUID()}`,
        isActive: options.isActive ?? true,
        isDigitalOrderingEnabled: options.isDigitalOrderingEnabled ?? true,
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
        idempotencyKey: `location-perf-spec-${randomUUID()}`,
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
        orderNumber: `LP-${randomUUID().slice(0, 8)}`,
        accessToken: randomUUID(),
        locationId: options.locationId,
        customerId: options.customerId ?? null,
        paymentAttemptId: attempt.id,
        guestName: 'Location Perf Spec',
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

  const getReport = (
    key: string,
    query: { startDate?: string; endDate?: string } = {},
  ) => {
    const params = new URLSearchParams();
    if (query.startDate) params.set('startDate', query.startDate);
    if (query.endDate) params.set('endDate', query.endDate);
    const qs = params.toString();
    return request(app.getHttpServer())
      .get(`/api/v1/admin/reports/location-performance${qs ? `?${qs}` : ''}`)
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

    await makeUser(`disabled-${suffix}`, 'DISABLED');
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
    await getReport(`viewer-${suffix}`, {
      startDate: '2026-01-01',
      endDate: '2026-01-01',
    }).expect(200);
  });

  it('an ACTIVE user without reports.view gets 403', async () => {
    await getReport(`noPerm-${suffix}`, {
      startDate: '2026-01-01',
      endDate: '2026-01-01',
    }).expect(403);
  });

  it('a LOCATION-only reports.view grant cannot satisfy the CORPORATE-only route (403)', async () => {
    await getReport(`locViewer-${suffix}`, {
      startDate: '2026-01-01',
      endDate: '2026-01-01',
    }).expect(403);
  });

  it('a customer token is rejected (401)', async () => {
    await request(app.getHttpServer())
      .get(
        '/api/v1/admin/reports/location-performance?startDate=2026-01-01&endDate=2026-01-01',
      )
      .set('Authorization', `Bearer ${customerToken()}`)
      .expect(401);
  });

  it('a DISABLED internal user is blocked (403)', async () => {
    await getReport(`disabled-${suffix}`, {
      startDate: '2026-01-01',
      endDate: '2026-01-01',
    }).expect(403);
  });

  // ---- Query validation -----------------------------------------

  it('requires startDate', async () => {
    await getReport(`viewer-${suffix}`, { endDate: '2026-01-01' }).expect(
      400,
    );
  });

  it('requires endDate', async () => {
    await getReport(`viewer-${suffix}`, { startDate: '2026-01-01' }).expect(
      400,
    );
  });

  it('rejects a malformed date', async () => {
    await getReport(`viewer-${suffix}`, {
      startDate: '01/01/2026',
      endDate: '2026-01-01',
    }).expect(400);
  });

  it('rejects an impossible calendar date', async () => {
    await getReport(`viewer-${suffix}`, {
      startDate: '2026-02-30',
      endDate: '2026-02-30',
    }).expect(400);
  });

  it('rejects startDate after endDate', async () => {
    await getReport(`viewer-${suffix}`, {
      startDate: '2026-01-10',
      endDate: '2026-01-01',
    }).expect(400);
  });

  // ---- Fixtures: inclusion rule, per-location math, ordering ---------

  describe('with fixtures', () => {
    const day = '2026-09-15';
    let activeZeroOrder: string;
    let activeWithOrders: string;
    let inactiveWithOrders: string;
    let inactiveNoOrders: string;
    let digitalOrderingDisabled: string;

    beforeAll(async () => {
      activeZeroOrder = await makeLocation(`ZZZ Active Zero ${suffix}`);
      activeWithOrders = await makeLocation(`AAA Active Orders ${suffix}`);
      inactiveWithOrders = await makeLocation(`Inactive History ${suffix}`, {
        isActive: false,
      });
      inactiveNoOrders = await makeLocation(`Inactive Empty ${suffix}`, {
        isActive: false,
      });
      digitalOrderingDisabled = await makeLocation(`DO Disabled ${suffix}`, {
        isDigitalOrderingEnabled: false,
      });

      const inRange = businessDateStartInstant('2026-09-15');
      const oneHourIn = new Date(inRange.getTime() + 60 * 60 * 1000);
      const nextDayStart = businessDateStartInstant('2026-09-16');
      const justBefore = new Date(inRange.getTime() - 1);

      // activeWithOrders: 3 orders -> 2 COMPLETED, 1 RECEIVED.
      // #1: subtotal 1000, promo 100, reward 50 -> net 850. COMPLETED. Guest.
      await makeOrder({
        locationId: activeWithOrders,
        subtotal: 1000,
        promotionDiscountMinorUnits: 100,
        rewardDiscountMinorUnits: 50,
        status: 'COMPLETED',
        createdAt: oneHourIn,
        customerId: null,
      });
      // #2: subtotal 2000, gift card tender 500 (NOT subtracted) -> net 2000. COMPLETED.
      const customerId = await makeCustomer();
      await makeOrder({
        locationId: activeWithOrders,
        subtotal: 2000,
        giftCardTenderMinorUnits: 500,
        status: 'COMPLETED',
        createdAt: oneHourIn,
        customerId,
      });
      // #3: subtotal 500, no discounts -> net 500. RECEIVED (still in progress).
      await makeOrder({
        locationId: activeWithOrders,
        subtotal: 500,
        status: 'RECEIVED',
        createdAt: oneHourIn,
      });

      // inactiveWithOrders: 1 order, ACCEPTED, net 300.
      await makeOrder({
        locationId: inactiveWithOrders,
        subtotal: 300,
        status: 'ACCEPTED',
        createdAt: oneHourIn,
      });

      // Out-of-range orders at activeWithOrders — must never be counted.
      await makeOrder({
        locationId: activeWithOrders,
        subtotal: 99999,
        status: 'RECEIVED',
        createdAt: nextDayStart,
      });
      await makeOrder({
        locationId: activeWithOrders,
        subtotal: 88888,
        status: 'RECEIVED',
        createdAt: justBefore,
      });
    }, 30_000);

    function rowFor(
      report: AdminLocationPerformanceReport,
      locationId: string,
    ) {
      return report.locations.find((l) => l.locationId === locationId);
    }

    it('includes an active location with zero orders in the period', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate: day,
        endDate: day,
      }).expect(200);
      const body = res.body as AdminLocationPerformanceReport;
      const row = rowFor(body, activeZeroOrder);
      expect(row).toBeDefined();
      expect(row!.totalOrders).toBe(0);
      expect(row!.completedOrders).toBe(0);
      expect(row!.completedPercent).toBe(0);
      expect(row!.digitalSalesMinorUnits).toBe(0);
      expect(row!.averageOrderValueMinorUnits).toBe(0);
      expect(row!.isActive).toBe(true);
    });

    it('includes an inactive location that has orders in the selected period', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate: day,
        endDate: day,
      }).expect(200);
      const body = res.body as AdminLocationPerformanceReport;
      const row = rowFor(body, inactiveWithOrders);
      expect(row).toBeDefined();
      expect(row!.isActive).toBe(false);
      expect(row!.totalOrders).toBe(1);
      expect(row!.digitalSalesMinorUnits).toBe(300);
    });

    it('excludes an inactive location with zero orders in the selected period', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate: day,
        endDate: day,
      }).expect(200);
      const body = res.body as AdminLocationPerformanceReport;
      expect(rowFor(body, inactiveNoOrders)).toBeUndefined();
    });

    it('includes an active, digital-ordering-disabled location with the flag reflected', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate: day,
        endDate: day,
      }).expect(200);
      const body = res.body as AdminLocationPerformanceReport;
      const row = rowFor(body, digitalOrderingDisabled);
      expect(row).toBeDefined();
      expect(row!.isActive).toBe(true);
      expect(row!.isDigitalOrderingEnabled).toBe(false);
      expect(row!.totalOrders).toBe(0);
    });

    it('aggregates per location correctly and keeps locations isolated', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate: day,
        endDate: day,
      }).expect(200);
      const body = res.body as AdminLocationPerformanceReport;
      const row = rowFor(body, activeWithOrders)!;

      expect(row.totalOrders).toBe(3);
      expect(row.completedOrders).toBe(2);
      // 2/3 * 100 = 66.666... -> 66.7 (deterministic one-decimal rounding).
      expect(row.completedPercent).toBe(66.7);
      // 850 (promo+reward subtracted) + 2000 (gift-card tender NOT
      // subtracted) + 500 (no discounts) = 3350.
      expect(row.digitalSalesMinorUnits).toBe(3350);
      expect(row.averageOrderValueMinorUnits).toBe(Math.round(3350 / 3));

      // Out-of-range orders (99999 / 88888) must not have leaked in.
      expect(row.digitalSalesMinorUnits).toBeLessThan(90000);

      // The inactive location's order must not have bled into this one.
      const inactiveRow = rowFor(body, inactiveWithOrders)!;
      expect(inactiveRow.totalOrders).toBe(1);
    });

    it('includes guest orders (no customerId) in a location total', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate: day,
        endDate: day,
      }).expect(200);
      const body = res.body as AdminLocationPerformanceReport;
      // Order #1 at activeWithOrders is a guest order and IS counted.
      expect(rowFor(body, activeWithOrders)!.totalOrders).toBe(3);
    });

    it('sorts rows by locationName ascending (never by a metric)', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate: day,
        endDate: day,
      }).expect(200);
      const body = res.body as AdminLocationPerformanceReport;
      const names = body.locations
        .map((l) => l.locationName)
        .filter((name) =>
          [
            `ZZZ Active Zero ${suffix}`,
            `AAA Active Orders ${suffix}`,
            `Inactive History ${suffix}`,
            `DO Disabled ${suffix}`,
          ].includes(name),
        );
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      expect(names).toEqual(sorted);
      // AAA sorts before ZZZ alphabetically — digital sales would sort the
      // other way if this were secretly a ranking.
      expect(
        names.indexOf(`AAA Active Orders ${suffix}`),
      ).toBeLessThan(names.indexOf(`ZZZ Active Zero ${suffix}`));
    });

    it('states the digital-platform-only source scope (identical to 9A)', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate: day,
        endDate: day,
      }).expect(200);
      const body = res.body as AdminLocationPerformanceReport;
      expect(body.source.scope).toBe('DIGITAL_PLATFORM_ONLY');
      expect(body.source.scopeLabel.toLowerCase()).toContain('digital-platform');
      expect(body.source.scopeLabel.toLowerCase()).toContain('pos');
      expect(body.source.freshnessLabel).toBe('Live platform data');
    });

    it('never introduces a total-store/POS field', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate: day,
        endDate: day,
      }).expect(200);
      const raw = JSON.stringify(res.body);
      expect(raw.toLowerCase()).not.toContain('totalstoresales');
      expect(raw.toLowerCase()).not.toContain('storesales');
      expect(raw.toLowerCase()).not.toContain('possales');
    });
  });

  // ---- Permission regression ----------------------------

  it('Platform Administrator has reports.view; Store Manager does not (shared with 9A)', async () => {
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
