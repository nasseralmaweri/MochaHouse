import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  INTERNAL_PERMISSION_KEYS,
  type AdminCustomerDetail,
  type AdminCustomerGrowthReport,
  type AdminFranchiseInquiriesResponse,
  type AdminJobApplicationsResponse,
  type AdminJobOpeningOptions,
  type AdminJobOpeningsResponse,
  type AdminLocationPerformanceReport,
  type AdminLoyaltyCustomerDetail,
  type AdminOrdersOverviewReport,
} from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { resolveBusinessDate } from '../operations/application/business-date';
import { RedisModule } from '../redis/redis.module';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { CrmModule } from '../crm/crm.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { CareersModule } from '../careers/careers.module';
import { FranchisingModule } from '../franchising/franchising.module';
import { CatalogModule } from '../catalog/catalog.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { MarketingModule } from '../marketing/marketing.module';
import { OperationsModule } from '../operations/operations.module';
import { ReportsModule } from '../reports/reports.module';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';

// Cross-tenant READ isolation (and the confirmed cross-tenant writes found
// with it) for the Admin surface. Real local Postgres, real guards, real
// controllers — every request goes through InternalAuthGuard, so the
// tenant is always the server-validated active business, never a value
// the client asserts.
//
//   Tenant A = Tenant #1 (Mocha House)
//   Tenant B = the test-only isolation tenant
//
// Each business gets its own customer, catalog, careers, franchising,
// location and order fixtures. A record of the other business must read
// exactly like a missing one (same status, same message), lists must
// never include it, and writes against it must change nothing.
describe('Admin cross-tenant read isolation (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'tenant-read-isolation-spec-secret';
  const suffix = randomUUID().slice(0, 8);

  const TENANT_A = TENANT_1_MOCHA_HOUSE_ID;
  const TENANT_B = TEST_TENANT_B_ID;

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const auditIds: string[] = [];
  let authorA: string;
  let authorB: string;

  type Fixtures = {
    locationId: string;
    customerId: string;
    customerEmail: string;
    categoryId: string;
    productId: string;
    menuId: string;
    jobId: string;
    applicationId: string;
    inquiryId: string;
    paymentAttemptId: string;
    orderId: string;
  };
  let A: Fixtures;
  let B: Fixtures;

  const subjectOf = (key: string) => `internal-dev:tri-${key}-${suffix}`;
  const token = (key: string) =>
    signInternalDevJwt(
      {
        sub: subjectOf(key),
        email: `tri-${key}-${suffix}@example.com`,
        name: null,
      },
      internalSecret,
      3600,
    );

  async function member(
    key: string,
    tenantId: string,
    permissions: readonly string[],
    scope: { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null } = {
      scopeType: 'CORPORATE',
      scopeId: null,
    },
  ): Promise<string> {
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: subjectOf(key),
        email: `tri-${key}-${suffix}@example.com`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(user.id);
    const role = await prisma.internalRole.create({
      data: {
        tenantId,
        key: `tri-${key}-${randomUUID()}`,
        displayName: 'Tenant read isolation spec role',
        permissions: {
          create: permissions.map((permissionKey) => ({
            permissionKey,
            tenantId,
          })),
        },
      },
    });
    roleIds.push(role.id);
    await prisma.internalUserRoleAssignment.create({
      data: { tenantId, internalUserId: user.id, roleId: role.id, ...scope },
    });
    return user.id;
  }

  async function fixturesFor(
    tenantId: string,
    tag: string,
    authorId: string,
  ): Promise<Fixtures> {
    const location = await prisma.location.create({
      data: {
        tenantId,
        name: `TRI ${tag} ${suffix}`,
        slug: `tri-${tag}-${suffix}`,
      },
    });
    const customerEmail = `tri-${tag}-customer-${suffix}@example.test`;
    const customer = await prisma.customer.create({
      data: {
        tenantId,
        externalProvider: 'dev',
        externalSubject: `dev:tri-${tag}-${suffix}`,
        email: customerEmail,
        displayName: `TRI ${tag} Customer`,
      },
    });
    await prisma.customerLoyaltyAccount.create({
      data: { tenantId, customerId: customer.id, balance: 250 },
    });
    await prisma.customerNote.create({
      data: {
        tenantId,
        customerId: customer.id,
        authorInternalUserId: authorId,
        body: `TRI ${tag} internal note`,
      },
    });
    const category = await prisma.category.create({
      data: {
        tenantId,
        name: `TRI ${tag} Cat`,
        slug: `tri-${tag}-cat-${suffix}`,
      },
    });
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `TRI ${tag} Product`,
        slug: `tri-${tag}-product-${suffix}`,
        categoryId: category.id,
        basePrice: 450,
      },
    });
    const menu = await prisma.menu.create({
      data: {
        tenantId,
        name: `TRI ${tag} Menu`,
        slug: `tri-${tag}-menu-${suffix}`,
      },
    });
    await prisma.menuProduct.create({
      data: { tenantId, menuId: menu.id, productId: product.id },
    });
    const job = await prisma.jobOpening.create({
      data: {
        tenantId,
        title: `TRI ${tag} Barista`,
        employmentType: 'FULL_TIME',
        summary: 's',
        description: 'd',
        responsibilities: 'r',
        qualifications: 'q',
      },
    });
    const application = await prisma.jobApplication.create({
      data: {
        tenantId,
        jobOpeningId: job.id,
        jobTitleSnapshot: job.title,
        firstName: `TRI${tag}`,
        lastName: 'Applicant',
        email: `tri-${tag}-applicant-${suffix}@example.test`,
        phone: '5550000000',
        location: 'Somewhere',
        workAuthorized: true,
        availability: 'any',
        message: 'hello',
      },
    });
    await prisma.jobApplicationNote.create({
      data: {
        tenantId,
        jobApplicationId: application.id,
        authorInternalUserId: authorId,
        body: `TRI ${tag} applicant note`,
      },
    });
    const inquiry = await prisma.franchiseInquiry.create({
      data: {
        tenantId,
        firstName: `TRI${tag}`,
        lastName: 'Prospect',
        email: `tri-${tag}-prospect-${suffix}@example.test`,
        phone: '5550000001',
        city: 'Detroit',
        state: 'MI',
        country: 'US',
        preferredMarket: 'Detroit',
        consentAcknowledged: true,
      },
    });
    await prisma.franchiseInquiryNote.create({
      data: {
        tenantId,
        franchiseInquiryId: inquiry.id,
        authorInternalUserId: authorId,
        body: `TRI ${tag} franchise note`,
      },
    });
    const attempt = await prisma.paymentAttempt.create({
      data: {
        tenantId,
        idempotencyKey: `tri-${tag}-${randomUUID()}`,
        provider: 'fake',
        locationId: location.id,
        amount: 777,
        currency: 'USD',
        status: 'SUCCEEDED',
      },
    });
    const order = await prisma.order.create({
      data: {
        tenantId,
        orderNumber: `TRI-${tag}-${randomUUID().slice(0, 8)}`,
        accessToken: randomUUID(),
        locationId: location.id,
        customerId: customer.id,
        paymentAttemptId: attempt.id,
        guestName: 'TRI',
        guestPhone: '5550000002',
        currency: 'USD',
        subtotal: 777,
        status: 'RECEIVED',
      },
    });
    return {
      locationId: location.id,
      customerId: customer.id,
      customerEmail,
      categoryId: category.id,
      productId: product.id,
      menuId: menu.id,
      jobId: job.id,
      applicationId: application.id,
      inquiryId: inquiry.id,
      paymentAttemptId: attempt.id,
      orderId: order.id,
    };
  }

  async function removeFixtures(f: Fixtures | undefined) {
    if (!f) return;
    await prisma.order.deleteMany({ where: { id: f.orderId } });
    await prisma.paymentAttempt.deleteMany({
      where: { id: f.paymentAttemptId },
    });
    await prisma.franchiseInquiryNote.deleteMany({
      where: { franchiseInquiryId: f.inquiryId },
    });
    await prisma.franchiseInquiry.deleteMany({ where: { id: f.inquiryId } });
    await prisma.jobApplicationNote.deleteMany({
      where: { jobApplicationId: f.applicationId },
    });
    await prisma.jobApplication.deleteMany({ where: { id: f.applicationId } });
    await prisma.jobOpening.deleteMany({ where: { id: f.jobId } });
    await prisma.menuProduct.deleteMany({ where: { menuId: f.menuId } });
    await prisma.menu.deleteMany({ where: { id: f.menuId } });
    await prisma.product.deleteMany({ where: { id: f.productId } });
    await prisma.category.deleteMany({ where: { id: f.categoryId } });
    await prisma.internalAuditEvent.deleteMany({
      where: { targetId: f.customerId },
    });
    await prisma.mochaBeanLedgerEntry.deleteMany({
      where: { loyaltyAccount: { customerId: f.customerId } },
    });
    await prisma.customerNote.deleteMany({
      where: { customerId: f.customerId },
    });
    await prisma.customerLoyaltyAccount.deleteMany({
      where: { customerId: f.customerId },
    });
    await prisma.customer.deleteMany({ where: { id: f.customerId } });
    await prisma.location.deleteMany({ where: { id: f.locationId } });
  }

  const http = () => request(app.getHttpServer());
  const get = (key: string, tenantId: string, path: string) =>
    http()
      .get(`/api/v1/admin${path}`)
      .set('Authorization', `Bearer ${token(key)}`)
      .set('X-Tenant-Id', tenantId);
  const send = (
    method: 'post' | 'patch',
    key: string,
    tenantId: string,
    path: string,
    body: object,
  ) =>
    http()
      [method](`/api/v1/admin${path}`)
      .set('Authorization', `Bearer ${token(key)}`)
      .set('X-Tenant-Id', tenantId)
      .send(body);

  // A foreign record must be indistinguishable from a missing one.
  async function expectSameAsMissing(
    key: string,
    tenantId: string,
    foreignPath: string,
    missingPath: string,
  ) {
    const foreign = await get(key, tenantId, foreignPath);
    const missing = await get(key, tenantId, missingPath);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
  }

  type Row = { id: string };
  // supertest types every body as `any`; assertions read it through here.
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;
  const ids = (rows: Row[]) => rows.map((row) => row.id);
  // Reports bucket by the BUSINESS day (America/Detroit), not the UTC
  // calendar day: near midnight UTC the two differ, and a "today" range in
  // UTC would miss rows created just now.
  const today = resolveBusinessDate(new Date());
  const range = `?startDate=${today}&endDate=${today}`;

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        RedisModule,
        CustomerAuthModule,
        InternalAuthModule,
        CrmModule,
        LoyaltyModule,
        CareersModule,
        FranchisingModule,
        CatalogModule,
        PromotionsModule,
        MarketingModule,
        OperationsModule,
        ReportsModule,
        AdminAuditModule,
      ],
    }).compile();
    app = moduleFixture.createNestApplication<INestApplication<App>>();
    await app.init();
    prisma = app.get(PrismaService);

    await createTestTenantB(prisma);
    const all = INTERNAL_PERMISSION_KEYS;
    authorA = await member('a-admin', TENANT_A, all);
    authorB = await member('b-admin', TENANT_B, all);
    // One verified human who administers BOTH businesses.
    await member('multi', TENANT_A, all);
    await member('multi', TENANT_B, all);

    A = await fixturesFor(TENANT_A, 'a', authorA);
    B = await fixturesFor(TENANT_B, 'b', authorB);

    // A location-scoped Store Manager in Tenant A with exactly the
    // permissions a LOCATION grant can carry — no `customers.view`.
    await member(
      'manager',
      TENANT_A,
      [
        'orders.view',
        'orders.manage_status',
        'operations.view',
        'operations.tasks.complete',
        'operations.exceptions.manage',
        'locations.view',
        'locations.manage_digital_ordering',
        'catalog.overrides.manage',
      ],
      { scopeType: 'LOCATION', scopeId: A.locationId },
    );
  });

  afterAll(async () => {
    await prisma.internalAuditEvent.deleteMany({
      where: { id: { in: auditIds } },
    });
    await removeFixtures(A);
    await removeFixtures(B);
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIds } },
    });
    await prisma.internalRolePermission.deleteMany({
      where: { roleId: { in: roleIds } },
    });
    await prisma.internalRole.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    await removeTestTenantB(prisma);
    await app.close();
    process.env = { ...originalEnv };
  });

  // --- (1) customer directory and search -----------------------------

  it('(1) a Tenant A admin cannot list or search Tenant B customers', async () => {
    const list = await get('a-admin', TENANT_A, '/customers').expect(200);
    expect(ids(bodyOf<{ customers: Row[] }>(list).customers)).toContain(
      A.customerId,
    );
    expect(ids(bodyOf<{ customers: Row[] }>(list).customers)).not.toContain(
      B.customerId,
    );

    for (const q of [B.customerEmail, B.customerId, 'TRI b']) {
      const res = await get(
        'a-admin',
        TENANT_A,
        `/customers?q=${encodeURIComponent(q)}`,
      ).expect(200);
      expect(bodyOf<{ customers: Row[] }>(res).customers).toEqual([]);
    }
  });

  // --- (2) customer detail and its related records --------------------

  it('(2) a Tenant A admin cannot read a Tenant B customer, its notes or loyalty by id', async () => {
    const missing = randomUUID();
    await expectSameAsMissing(
      'a-admin',
      TENANT_A,
      `/customers/${B.customerId}`,
      `/customers/${missing}`,
    );
    await expectSameAsMissing(
      'a-admin',
      TENANT_A,
      `/customers/${B.customerId}/notes`,
      `/customers/${missing}/notes`,
    );
  });

  // --- (3) loyalty -----------------------------------------------------

  it('(3) Tenant A cannot look up, read or adjust Tenant B loyalty records', async () => {
    for (const query of [B.customerEmail, B.customerId]) {
      const res = await get(
        'a-admin',
        TENANT_A,
        `/loyalty/customers?query=${encodeURIComponent(query)}`,
      ).expect(200);
      expect(bodyOf<{ customers: Row[] }>(res).customers).toEqual([]);
    }
    await expectSameAsMissing(
      'a-admin',
      TENANT_A,
      `/loyalty/customers/${B.customerId}`,
      `/loyalty/customers/${randomUUID()}`,
    );

    const adjust = await send(
      'post',
      'a-admin',
      TENANT_A,
      `/loyalty/customers/${B.customerId}/adjustments`,
      {
        deltaBeans: 1000,
        reason: 'cross-tenant probe',
        operationKey: randomUUID(),
      },
    );
    expect(adjust.status).toBe(404);
    expect(bodyOf<{ message: string }>(adjust).message).toBe(
      'Customer not found.',
    );
    const account = await prisma.customerLoyaltyAccount.findUniqueOrThrow({
      where: { customerId: B.customerId },
      select: { balance: true, entries: { select: { id: true } } },
    });
    expect(account.balance).toBe(250);
    expect(account.entries).toEqual([]);
  });

  // --- (4) the owning business keeps normal access --------------------

  it('(4) a Tenant B admin reads Tenant B records normally', async () => {
    const list = await get('b-admin', TENANT_B, '/customers').expect(200);
    expect(ids(bodyOf<{ customers: Row[] }>(list).customers)).toEqual([
      B.customerId,
    ]);

    const detail = await get(
      'b-admin',
      TENANT_B,
      `/customers/${B.customerId}`,
    ).expect(200);
    expect(bodyOf<AdminCustomerDetail>(detail).customer.email).toBe(
      B.customerEmail,
    );
    expect(bodyOf<AdminCustomerDetail>(detail).mochaBeans.balance).toBe(250);
    expect(
      bodyOf<AdminCustomerDetail>(detail).notes.map((n) => n.body),
    ).toEqual(['TRI b internal note']);

    const loyalty = await get(
      'b-admin',
      TENANT_B,
      `/loyalty/customers/${B.customerId}`,
    ).expect(200);
    expect(bodyOf<AdminLoyaltyCustomerDetail>(loyalty).customer.balance).toBe(
      250,
    );

    await get('b-admin', TENANT_B, `/careers/jobs/${B.jobId}`).expect(200);
    await get('b-admin', TENANT_B, `/catalog/products/${B.productId}`).expect(
      200,
    );
    await get(
      'b-admin',
      TENANT_B,
      `/franchising/inquiries/${B.inquiryId}`,
    ).expect(200);
  });

  // --- (5) one person, two businesses ---------------------------------

  it('(5) a user of both businesses sees only the actively selected business', async () => {
    for (const [tenantId, own, other] of [
      [TENANT_A, A, B],
      [TENANT_B, B, A],
    ] as const) {
      const customers = await get('multi', tenantId, '/customers').expect(200);
      expect(ids(bodyOf<{ customers: Row[] }>(customers).customers)).toContain(
        own.customerId,
      );
      expect(
        ids(bodyOf<{ customers: Row[] }>(customers).customers),
      ).not.toContain(other.customerId);

      const products = await get('multi', tenantId, '/catalog/products').expect(
        200,
      );
      expect(ids(bodyOf<Row[]>(products))).toContain(own.productId);
      expect(ids(bodyOf<Row[]>(products))).not.toContain(other.productId);

      const jobs = await get('multi', tenantId, '/careers/jobs').expect(200);
      expect(ids(bodyOf<AdminJobOpeningsResponse>(jobs).jobs)).toContain(
        own.jobId,
      );
      expect(ids(bodyOf<AdminJobOpeningsResponse>(jobs).jobs)).not.toContain(
        other.jobId,
      );

      await get('multi', tenantId, `/customers/${own.customerId}`).expect(200);
      await get('multi', tenantId, `/customers/${other.customerId}`).expect(
        404,
      );
    }
  });

  // --- (6) location-scoped Store Manager --------------------------------

  it('(6) a Store Manager without customers.view stays denied', async () => {
    for (const path of [
      '/customers',
      `/customers/${A.customerId}`,
      `/customers/${A.customerId}/notes`,
      `/loyalty/customers?query=${encodeURIComponent(A.customerEmail)}`,
      `/loyalty/customers/${A.customerId}`,
      '/careers/applications',
      '/franchising/inquiries',
      `/reports/orders-overview${range}`,
    ]) {
      const res = await get('manager', TENANT_A, path);
      expect(res.status).toBe(403);
    }
  });

  // --- (7) forged headers and unauthorized business selection ----------

  it('(7) forged tenant headers and unauthorized business selection are rejected', async () => {
    // A Tenant A-only admin naming Tenant B is not let in at all.
    const forged = await get('a-admin', TENANT_B, '/customers');
    expect(forged.status).toBe(403);
    expect(JSON.stringify(forged.body)).not.toContain(B.customerEmail);
    // A malformed business id is refused before any read.
    await get('a-admin', 'not-a-uuid', '/customers').expect(400);
    // No token, no access.
    await http()
      .get('/api/v1/admin/customers')
      .set('X-Tenant-Id', TENANT_A)
      .expect(401);
  });

  // --- (8) related read paths and the confirmed writes ------------------

  it('(8a) careers and franchising reads never cross tenants', async () => {
    const jobs = await get('a-admin', TENANT_A, '/careers/jobs').expect(200);
    expect(ids(bodyOf<AdminJobOpeningsResponse>(jobs).jobs)).not.toContain(
      B.jobId,
    );
    const options = await get(
      'a-admin',
      TENANT_A,
      '/careers/jobs/options',
    ).expect(200);
    expect(
      ids(bodyOf<AdminJobOpeningOptions>(options).locations),
    ).not.toContain(B.locationId);
    expect(ids(bodyOf<AdminJobOpeningOptions>(options).locations)).toContain(
      A.locationId,
    );

    const apps = await get('a-admin', TENANT_A, '/careers/applications').expect(
      200,
    );
    expect(
      ids(bodyOf<AdminJobApplicationsResponse>(apps).applications),
    ).not.toContain(B.applicationId);
    const inquiries = await get(
      'a-admin',
      TENANT_A,
      '/franchising/inquiries',
    ).expect(200);
    expect(
      ids(bodyOf<AdminFranchiseInquiriesResponse>(inquiries).inquiries),
    ).not.toContain(B.inquiryId);

    const missing = randomUUID();
    for (const [foreign, absent] of [
      [`/careers/jobs/${B.jobId}`, `/careers/jobs/${missing}`],
      [
        `/careers/applications/${B.applicationId}`,
        `/careers/applications/${missing}`,
      ],
      [
        `/careers/applications/${B.applicationId}/notes`,
        `/careers/applications/${missing}/notes`,
      ],
      [
        `/franchising/inquiries/${B.inquiryId}`,
        `/franchising/inquiries/${missing}`,
      ],
      [
        `/franchising/inquiries/${B.inquiryId}/notes`,
        `/franchising/inquiries/${missing}/notes`,
      ],
    ]) {
      await expectSameAsMissing('a-admin', TENANT_A, foreign, absent);
    }
  });

  it('(8b) catalog reads, pickers and catalog writes never cross tenants', async () => {
    const products = await get('a-admin', TENANT_A, '/catalog/products').expect(
      200,
    );
    expect(ids(bodyOf<Row[]>(products))).not.toContain(B.productId);
    const menus = await get('a-admin', TENANT_A, '/catalog/menus').expect(200);
    expect(ids(bodyOf<Row[]>(menus))).not.toContain(B.menuId);
    await expectSameAsMissing(
      'a-admin',
      TENANT_A,
      `/catalog/products/${B.productId}`,
      `/catalog/products/${randomUUID()}`,
    );
    await expectSameAsMissing(
      'a-admin',
      TENANT_A,
      `/catalog/menus/${B.menuId}`,
      `/catalog/menus/${randomUUID()}`,
    );

    for (const path of [
      '/promotions/options',
      '/marketing/campaigns/options',
      '/loyalty/catalog-options',
      '/loyalty/bonus-promotion-options',
    ]) {
      const res = await get('a-admin', TENANT_A, path).expect(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(B.productId);
      expect(text).not.toContain(B.categoryId);
      expect(text).not.toContain(B.locationId);
      expect(text).toContain(A.productId);
    }

    await send(
      'patch',
      'a-admin',
      TENANT_A,
      `/catalog/products/${B.productId}`,
      {
        name: 'cross-tenant probe',
      },
    ).expect(404);
    await send(
      'patch',
      'a-admin',
      TENANT_A,
      `/catalog/menus/${B.menuId}/products/${B.productId}/assignment`,
      { isActive: false },
    ).expect(404);
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: B.productId },
    });
    expect(product.name).toBe('TRI b Product');
    const placement = await prisma.menuProduct.findUniqueOrThrow({
      where: { menuId_productId: { menuId: B.menuId, productId: B.productId } },
    });
    expect(placement.isActive).toBe(true);
  });

  it('(8c) the checklist templates of another tenant are neither read nor changed', async () => {
    const template = await prisma.checklistTemplate.findUnique({
      where: {
        tenantId_key: { tenantId: TENANT_1_MOCHA_HOUSE_ID, key: 'opening' },
      },
      include: { items: { take: 1, orderBy: { sortOrder: 'asc' } } },
    });
    // The seeded templates belong to Tenant #1.
    expect(template?.tenantId).toBe(TENANT_A);
    const item = template!.items[0];

    const read = await get(
      'b-admin',
      TENANT_B,
      '/operations/opening-checklist/template',
    );
    expect(read.status).toBe(404);
    expect(JSON.stringify(read.body)).not.toContain(item.label);

    await send(
      'patch',
      'b-admin',
      TENANT_B,
      `/operations/opening-checklist/template/items/${item.id}`,
      { label: 'cross-tenant probe' },
    ).expect(404);
    await send(
      'post',
      'b-admin',
      TENANT_B,
      '/operations/opening-checklist/template/sections/rename',
      { from: item.section, to: 'cross-tenant probe' },
    ).expect(404);
    const after = await prisma.checklistTemplateItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(after.label).toBe(item.label);
    expect(after.section).toBe(item.section);

    // The owning tenant still reads its template.
    await get(
      'a-admin',
      TENANT_A,
      '/operations/opening-checklist/template',
    ).expect(200);
  });

  it('(8d) reports count only the active tenant', async () => {
    for (const [key, tenantId, own, other] of [
      ['a-admin', TENANT_A, A, B],
      ['b-admin', TENANT_B, B, A],
    ] as const) {
      const overview = await get(
        key,
        tenantId,
        `/reports/orders-overview${range}`,
      ).expect(200);
      const locations = ids(
        bodyOf<AdminOrdersOverviewReport>(overview).availableLocations,
      );
      expect(locations).toContain(own.locationId);
      expect(locations).not.toContain(other.locationId);
      await get(
        key,
        tenantId,
        `/reports/orders-overview${range}&locationId=${other.locationId}`,
      ).expect(400);

      const perf = await get(
        key,
        tenantId,
        `/reports/location-performance${range}`,
      ).expect(200);
      const perfIds = bodyOf<AdminLocationPerformanceReport>(
        perf,
      ).locations.map((row) => row.locationId);
      expect(perfIds).toContain(own.locationId);
      expect(perfIds).not.toContain(other.locationId);

      const checklists = await get(
        key,
        tenantId,
        `/reports/operations-checklists${range}`,
      ).expect(200);
      expect(JSON.stringify(checklists.body)).not.toContain(other.locationId);

      const exportCsv = await get(
        key,
        tenantId,
        `/reports/location-performance/export${range}`,
      ).expect(200);
      expect(exportCsv.text).not.toContain(
        `TRI ${tenantId === TENANT_A ? 'b' : 'a'} `,
      );
    }

    // Tenant B's figures are exactly its own single fixture order/customer.
    const growthB = await get(
      'b-admin',
      TENANT_B,
      `/reports/customer-growth${range}`,
    ).expect(200);
    expect(
      bodyOf<AdminCustomerGrowthReport>(growthB).registeredCustomersAsOfEndDate,
    ).toBe(1);
    expect(
      bodyOf<AdminCustomerGrowthReport>(growthB).registeredCustomerOrders,
    ).toBe(1);
    const overviewB = await get(
      'b-admin',
      TENANT_B,
      `/reports/orders-overview${range}`,
    ).expect(200);
    expect(bodyOf<AdminOrdersOverviewReport>(overviewB).totalOrders).toBe(1);
    expect(
      bodyOf<AdminOrdersOverviewReport>(overviewB).digitalSalesMinorUnits,
    ).toBe(777);
  });

  it('(8e) the Admin activity log shows only the active business', async () => {
    // Access-change events as the audit writer records them: actor and
    // subject are the business's own InternalUser rows and the event carries
    // the actor's tenantId.
    for (const [actor, tenantId, reason] of [
      [authorA, TENANT_A, `TRI a staff audit ${suffix}`],
      [authorB, TENANT_B, `TRI b staff audit ${suffix}`],
    ] as const) {
      const event = await prisma.internalAuditEvent.create({
        data: {
          tenantId,
          actorInternalUserId: actor,
          action: 'internal_user.status_changed',
          targetType: 'internal_user',
          targetId: actor,
          reason,
        },
      });
      auditIds.push(event.id);
    }

    for (const [key, tenantId, own, other] of [
      ['a-admin', TENANT_A, 'a', 'b'],
      ['b-admin', TENANT_B, 'b', 'a'],
    ] as const) {
      const res = await get(key, tenantId, '/audit').expect(200);
      const text = JSON.stringify(res.body);
      expect(text).toContain(`TRI ${own} staff audit ${suffix}`);
      expect(text).not.toContain(`TRI ${other} staff audit ${suffix}`);
    }
  });
});
