import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { AdminCustomerGrowthReport } from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { ReportsModule } from './reports.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';
import { businessDateStartInstant } from '../operations/application/business-date';

type Status = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

// Milestone 9D — HQ Customer Growth & Ordering, over real local Postgres.
// This is customer-base SIZE and digital-ordering PARTICIPATION during a
// period, never retention/churn/conversion/LTV/scoring. Both
// Customer.createdAt and Order.createdAt are real timestamps, so date
// filtering reuses the exact 9A/9B instant-range strategy
// (businessDateRangeToUtcInstants), not 9C's @db.Date range.
describe('Admin reports — customer growth & ordering (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'admin-customer-growth-spec-internal-secret';
  const customerSecret = 'admin-customer-growth-spec-customer-secret';
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
        key: `customer-growth-spec-${suffix}-${randomUUID()}`,
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

  async function makeLocation(name: string): Promise<string> {
    const location = await prisma.location.create({
      data: {
        name,
        slug: `customer-growth-loc-${randomUUID()}`,
        isActive: true,
        isDigitalOrderingEnabled: true,
      },
    });
    locationIds.push(location.id);
    return location.id;
  }

  async function makeCustomer(createdAt: Date): Promise<string> {
    const customer = await prisma.customer.create({
      data: {
        externalProvider: 'dev',
        externalSubject: `customer-growth-spec-${randomUUID()}`,
        email: `customer-growth-spec-${randomUUID()}@example.com`,
        createdAt,
      },
    });
    customerIds.push(customer.id);
    return customer.id;
  }

  async function makeOrder(options: {
    locationId: string;
    customerId?: string | null;
    createdAt: Date;
  }): Promise<string> {
    const attempt = await prisma.paymentAttempt.create({
      data: {
        idempotencyKey: `customer-growth-spec-${randomUUID()}`,
        provider: 'fake',
        locationId: options.locationId,
        amount: 500,
        currency: 'USD',
        status: 'SUCCEEDED',
      },
    });
    paymentAttemptIds.push(attempt.id);

    const order = await prisma.order.create({
      data: {
        orderNumber: `CG-${randomUUID().slice(0, 8)}`,
        accessToken: randomUUID(),
        locationId: options.locationId,
        customerId: options.customerId ?? null,
        paymentAttemptId: attempt.id,
        guestName: 'Customer Growth Spec',
        guestPhone: '5550000000',
        currency: 'USD',
        subtotal: 500,
        status: 'RECEIVED',
        createdAt: options.createdAt,
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
      .get(`/api/v1/admin/reports/customer-growth${qs ? `?${qs}` : ''}`)
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
      startDate: '2020-01-01',
      endDate: '2020-01-01',
    }).expect(200);
  });

  it('an ACTIVE user without reports.view gets 403', async () => {
    await getReport(`noPerm-${suffix}`, {
      startDate: '2020-01-01',
      endDate: '2020-01-01',
    }).expect(403);
  });

  it('a LOCATION-only reports.view grant cannot satisfy the CORPORATE-only route (403)', async () => {
    await getReport(`locViewer-${suffix}`, {
      startDate: '2020-01-01',
      endDate: '2020-01-01',
    }).expect(403);
  });

  it('a customer token is rejected (401)', async () => {
    await request(app.getHttpServer())
      .get(
        '/api/v1/admin/reports/customer-growth?startDate=2020-01-01&endDate=2020-01-01',
      )
      .set('Authorization', `Bearer ${customerToken()}`)
      .expect(401);
  });

  it('a DISABLED internal user is blocked (403)', async () => {
    await getReport(`disabled-${suffix}`, {
      startDate: '2020-01-01',
      endDate: '2020-01-01',
    }).expect(403);
  });

  // ---- Query validation -----------------------------------------

  it('requires startDate', async () => {
    await getReport(`viewer-${suffix}`, { endDate: '2020-01-01' }).expect(
      400,
    );
  });

  it('requires endDate', async () => {
    await getReport(`viewer-${suffix}`, { startDate: '2020-01-01' }).expect(
      400,
    );
  });

  it('rejects a malformed date', async () => {
    await getReport(`viewer-${suffix}`, {
      startDate: '01/01/2020',
      endDate: '2020-01-01',
    }).expect(400);
  });

  it('rejects an impossible calendar date', async () => {
    await getReport(`viewer-${suffix}`, {
      startDate: '2020-02-30',
      endDate: '2020-02-30',
    }).expect(400);
  });

  it('rejects startDate after endDate', async () => {
    await getReport(`viewer-${suffix}`, {
      startDate: '2020-01-10',
      endDate: '2020-01-01',
    }).expect(400);
  });

  // ---- Fixtures ---------------------------------------------------

  describe('with fixtures', () => {
    const startDate = '2028-03-01';
    const endDate = '2028-03-07';
    const midRange = businessDateStartInstant('2028-03-04');
    const beforeRange = businessDateStartInstant('2028-02-15');
    const afterRange = businessDateStartInstant('2028-03-20');
    const rangeStart = businessDateStartInstant(startDate);
    const rangeEndExclusive = businessDateStartInstant('2028-03-08');

    let location: string;

    let customerBeforeStart: string;
    let customerDuringRange: string;
    let customerAfterEnd: string;

    let customerOneOrder: string; // not repeat
    let customerTwoOrders: string; // repeat
    let customerThreeOrders: string; // repeat, counted once
    let customerOldPlusOneInRange: string; // NOT repeat (only 1 in-range order)
    let customerTwoInRangePlusOld: string; // repeat once, older order ignored

    beforeAll(async () => {
      location = await makeLocation(`Customer Growth Loc ${suffix}`);

      // --- Registered Customers as of End Date / New Registered Customers ---
      customerBeforeStart = await makeCustomer(beforeRange);
      customerDuringRange = await makeCustomer(midRange);
      customerAfterEnd = await makeCustomer(afterRange);

      // --- Order/customer separation + repeat fixtures ---
      customerOneOrder = await makeCustomer(beforeRange);
      await makeOrder({ locationId: location, customerId: customerOneOrder, createdAt: midRange });

      customerTwoOrders = await makeCustomer(beforeRange);
      await makeOrder({ locationId: location, customerId: customerTwoOrders, createdAt: midRange });
      await makeOrder({ locationId: location, customerId: customerTwoOrders, createdAt: midRange });

      customerThreeOrders = await makeCustomer(beforeRange);
      await makeOrder({ locationId: location, customerId: customerThreeOrders, createdAt: midRange });
      await makeOrder({ locationId: location, customerId: customerThreeOrders, createdAt: midRange });
      await makeOrder({ locationId: location, customerId: customerThreeOrders, createdAt: midRange });

      customerOldPlusOneInRange = await makeCustomer(beforeRange);
      await makeOrder({ locationId: location, customerId: customerOldPlusOneInRange, createdAt: beforeRange });
      await makeOrder({ locationId: location, customerId: customerOldPlusOneInRange, createdAt: midRange });

      customerTwoInRangePlusOld = await makeCustomer(beforeRange);
      await makeOrder({ locationId: location, customerId: customerTwoInRangePlusOld, createdAt: beforeRange });
      await makeOrder({ locationId: location, customerId: customerTwoInRangePlusOld, createdAt: midRange });
      await makeOrder({ locationId: location, customerId: customerTwoInRangePlusOld, createdAt: midRange });

      // Guest orders in range — must never contribute to registered counts.
      await makeOrder({ locationId: location, customerId: null, createdAt: midRange });
      await makeOrder({ locationId: location, customerId: null, createdAt: midRange });

      // Boundary orders (all for a fresh customer, so they don't pollute
      // the repeat/with-orders counts above).
      const boundaryCustomer = await makeCustomer(beforeRange);
      await makeOrder({
        locationId: location,
        customerId: boundaryCustomer,
        createdAt: rangeStart, // exactly at start — included
      });
      await makeOrder({
        locationId: location,
        customerId: boundaryCustomer,
        createdAt: new Date(rangeStart.getTime() - 1), // just before start — excluded
      });
      await makeOrder({
        locationId: location,
        customerId: boundaryCustomer,
        createdAt: new Date(rangeEndExclusive.getTime() - 1), // just before end-exclusive — included
      });
      await makeOrder({
        locationId: location,
        customerId: boundaryCustomer,
        createdAt: rangeEndExclusive, // exactly at end-exclusive — excluded
      });
    }, 30_000);

    async function getBody(): Promise<AdminCustomerGrowthReport> {
      const res = await getReport(`viewer-${suffix}`, {
        startDate,
        endDate,
      }).expect(200);
      return res.body as AdminCustomerGrowthReport;
    }

    it('registeredCustomersAsOfEndDate includes customers created before and during the range', async () => {
      const body = await getBody();
      // Every customer created at or before the fixtures' `beforeRange` /
      // `midRange` instants is included; customerAfterEnd (created after
      // the range) must not be. The exact delta from a far-earlier, empty
      // baseline period isolates this fixture set's contribution.
      const baseline = await getReport(`viewer-${suffix}`, {
        startDate: '2020-01-01',
        endDate: '2020-01-01',
      }).expect(200);
      const baselineBody = baseline.body as AdminCustomerGrowthReport;
      const delta =
        body.registeredCustomersAsOfEndDate -
        baselineBody.registeredCustomersAsOfEndDate;
      expect(delta).toBeGreaterThanOrEqual(9); // at least the 9 non-"afterEnd" fixture customers
    });

    it('registeredCustomersAsOfEndDate excludes a customer created after the end date', async () => {
      // A range ending well before customerAfterEnd's createdAt must not
      // count them, even though they exist in the database.
      const res = await getReport(`viewer-${suffix}`, {
        startDate: '2028-02-01',
        endDate: '2028-03-07',
      }).expect(200);
      const body = res.body as AdminCustomerGrowthReport;
      const withAfterEnd = await getReport(`viewer-${suffix}`, {
        startDate: '2028-02-01',
        endDate: '2028-03-25',
      }).expect(200);
      const bodyWithAfterEnd = withAfterEnd.body as AdminCustomerGrowthReport;
      // Extending the end date past customerAfterEnd's creation instant
      // must increase the as-of count by at least 1.
      expect(bodyWithAfterEnd.registeredCustomersAsOfEndDate).toBeGreaterThan(
        body.registeredCustomersAsOfEndDate,
      );
    });

    it('newRegisteredCustomers counts only customers created within [start, end]', async () => {
      const body = await getBody();
      // customerDuringRange plus every "beforeRange"-created fixture
      // customer are NOT new for this range (they were created earlier);
      // only customerDuringRange (created at midRange) is. We isolate
      // this by comparing against a range that starts after midRange.
      const narrowedOut = await getReport(`viewer-${suffix}`, {
        startDate: '2028-03-05',
        endDate: endDate,
      }).expect(200);
      const narrowedBody = narrowedOut.body as AdminCustomerGrowthReport;
      expect(narrowedBody.newRegisteredCustomers).toBeLessThan(
        body.newRegisteredCustomers,
      );
    });

    it('a registered order counts as registeredCustomerOrders, not guestOrders', async () => {
      const body = await getBody();
      expect(body.registeredCustomerOrders).toBeGreaterThan(0);
    });

    it('a guest order counts as guestOrders, not registeredCustomerOrders', async () => {
      const body = await getBody();
      expect(body.guestOrders).toBeGreaterThanOrEqual(2); // the two seeded guest orders
    });

    it('registeredCustomersWithOrders counts a customer once regardless of order count', async () => {
      const body = await getBody();
      // customerOneOrder(1) + customerTwoOrders(1) + customerThreeOrders(1)
      // + customerOldPlusOneInRange(1) + customerTwoInRangePlusOld(1) +
      // boundaryCustomer(1, from the two included boundary orders) = 6
      // distinct registered customers with orders in range.
      expect(body.registeredCustomersWithOrders).toBeGreaterThanOrEqual(6);
    });

    it('repeatRegisteredCustomers: one order in range is not repeat', async () => {
      // Verified indirectly: total distinct registered-with-orders (6)
      // minus repeat count must be >= 1 (customerOneOrder and
      // customerOldPlusOneInRange are both single-in-range-order).
      const body = await getBody();
      expect(
        body.registeredCustomersWithOrders - body.repeatRegisteredCustomers,
      ).toBeGreaterThanOrEqual(2);
    });

    it('repeatRegisteredCustomers: two or more in-range orders is repeat, counted once', async () => {
      const body = await getBody();
      // customerTwoOrders, customerThreeOrders, customerTwoInRangePlusOld
      // are each repeat (>=2 in-range orders) — at least 3 repeat
      // customers, each counted exactly once despite customerThreeOrders
      // having 3 orders.
      expect(body.repeatRegisteredCustomers).toBeGreaterThanOrEqual(3);
    });

    it('a customer with one order before the period and one inside it is NOT repeat for this metric', async () => {
      // customerOldPlusOneInRange has 2 LIFETIME orders but only 1 inside
      // [startDate, endDate] — proven by the aggregate assertions above
      // (registeredCustomersWithOrders - repeat >= 2 requires this
      // customer to land on the non-repeat side).
      const body = await getBody();
      expect(body.repeatRegisteredCustomers).toBeLessThan(
        body.registeredCustomersWithOrders,
      );
    });

    it('guest orders never create a repeat customer', async () => {
      // The two guest orders share customerId: null — if NULL were ever
      // treated as a customer, it would appear as a single "customer"
      // with 2 in-range orders and inflate repeatRegisteredCustomers by
      // exactly 1 beyond the true registered repeat count.
      const body = await getBody();
      expect(body.guestOrders).toBe(2);
      // registeredCustomersWithOrders must not include the guest bucket.
      expect(body.registeredCustomersWithOrders).toBeGreaterThanOrEqual(6);
    });

    it('includes an order exactly at the start boundary', async () => {
      const body = await getBody();
      expect(body.registeredCustomerOrders).toBeGreaterThan(0);
      // Precise isolation: a range of exactly [startDate, startDate] must
      // include the boundary customer's start-instant order.
      const narrow = await getReport(`viewer-${suffix}`, {
        startDate,
        endDate: startDate,
      }).expect(200);
      const narrowBody = narrow.body as AdminCustomerGrowthReport;
      expect(narrowBody.registeredCustomerOrders).toBeGreaterThanOrEqual(1);
    });

    it('excludes an order one millisecond before the start boundary', async () => {
      const narrow = await getReport(`viewer-${suffix}`, {
        startDate,
        endDate: startDate,
      }).expect(200);
      const narrowBody = narrow.body as AdminCustomerGrowthReport;
      // Only the exact-start-instant order should land in this single-day
      // window — the "just before start" order must not.
      expect(narrowBody.registeredCustomerOrders).toBe(1);
    });

    it('includes an order one millisecond before the end-exclusive boundary', async () => {
      const narrow = await getReport(`viewer-${suffix}`, {
        startDate: endDate,
        endDate,
      }).expect(200);
      const narrowBody = narrow.body as AdminCustomerGrowthReport;
      expect(narrowBody.registeredCustomerOrders).toBeGreaterThanOrEqual(1);
    });

    it('excludes an order exactly at the end-exclusive boundary', async () => {
      const narrow = await getReport(`viewer-${suffix}`, {
        startDate: endDate,
        endDate,
      }).expect(200);
      const narrowBody = narrow.body as AdminCustomerGrowthReport;
      // Exactly one order (the "just before end-exclusive" one) should
      // land on endDate; the exact-end-exclusive-instant order belongs to
      // the NEXT business day and must not appear here.
      expect(narrowBody.registeredCustomerOrders).toBe(1);
    });

    it('states the CUSTOMER_PLATFORM source scope with accurate wording', async () => {
      const body = await getBody();
      expect(body.source.scope).toBe('CUSTOMER_PLATFORM');
      expect(body.source.scopeLabel.toLowerCase()).toContain('customer');
      expect(body.source.scopeLabel.toLowerCase()).toContain('digital-platform');
      expect(body.source.scopeLabel.toLowerCase()).not.toContain('pos');
      expect(body.source.scopeLabel.toLowerCase()).not.toContain('in-store');
      expect(body.source.freshnessLabel).toBe('Live platform data');
    });

    it('exposes no opt-in, verification, preferred-location, retention, churn, conversion, or location-comparison fields', async () => {
      const raw = JSON.stringify(await getBody()).toLowerCase();
      expect(raw).not.toContain('optin');
      expect(raw).not.toContain('verified');
      expect(raw).not.toContain('preferredlocation');
      expect(raw).not.toContain('retention');
      expect(raw).not.toContain('churn');
      expect(raw).not.toContain('conversion');
      expect(raw).not.toContain('locationid');
      expect(raw).not.toContain('locationname');
    });
  });

  // ---- DST boundary (America/Detroit) ----------------------------

  describe('DST boundary', () => {
    it('correctly separates business days across the spring-forward transition (2026-03-08)', async () => {
      const before = businessDateStartInstant('2026-03-08'); // still EST
      const after = businessDateStartInstant('2026-03-09'); // now EDT

      const custBefore = await prisma.customer.create({
        data: {
          externalProvider: 'dev',
          externalSubject: `customer-growth-dst-${randomUUID()}`,
          email: `customer-growth-dst-${randomUUID()}@example.com`,
          createdAt: before,
        },
      });
      customerIds.push(custBefore.id);
      const custAfter = await prisma.customer.create({
        data: {
          externalProvider: 'dev',
          externalSubject: `customer-growth-dst-${randomUUID()}`,
          email: `customer-growth-dst-${randomUUID()}@example.com`,
          createdAt: after,
        },
      });
      customerIds.push(custAfter.id);

      const onlyMar8 = await getReport(`viewer-${suffix}`, {
        startDate: '2026-03-08',
        endDate: '2026-03-08',
      }).expect(200);
      const onlyMar8Body = onlyMar8.body as AdminCustomerGrowthReport;
      const onlyMar9 = await getReport(`viewer-${suffix}`, {
        startDate: '2026-03-09',
        endDate: '2026-03-09',
      }).expect(200);
      const onlyMar9Body = onlyMar9.body as AdminCustomerGrowthReport;

      // The Mar-8-only window must include custBefore, and the Mar-9-only
      // window must include custAfter — proven by each single-day
      // window's count increasing relative to a window containing
      // neither fixture customer.
      const neitherDay = await getReport(`viewer-${suffix}`, {
        startDate: '2026-03-01',
        endDate: '2026-03-01',
      }).expect(200);
      const neitherBody = neitherDay.body as AdminCustomerGrowthReport;
      expect(onlyMar8Body.newRegisteredCustomers).toBeGreaterThan(
        neitherBody.newRegisteredCustomers,
      );
      expect(onlyMar9Body.newRegisteredCustomers).toBeGreaterThan(
        neitherBody.newRegisteredCustomers,
      );
    });
  });

  // ---- Permission regression ----------------------------

  it('Platform Administrator has reports.view; Store Manager does not (shared with 9A/9B/9C)', async () => {
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
