import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminCustomerGrowthReport,
  AdminLocationPerformanceReport,
  AdminOperationsChecklistReport,
  AdminOrdersOverviewReport,
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

// A minimal, RFC-4180-aware CSV parser for test assertions only — handles
// quoted fields with embedded commas/quotes/CRLF correctly, which a naive
// String.split(',') could not.
function parseCsv(buffer: Buffer): string[][] {
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      i += 1;
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 2;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function findRow(rows: string[][], firstCell: string): string[] | undefined {
  return rows.find((r) => r[0] === firstCell);
}

describe('Admin reports — CSV export (integration, Milestone 9E)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'admin-reports-export-spec-internal-secret';
  const customerSecret = 'admin-reports-export-spec-customer-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const locationIds: string[] = [];
  const paymentAttemptIds: string[] = [];
  const orderIds: string[] = [];
  const customerIds: string[] = [];
  const instanceIds: string[] = [];
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
        key: `export-spec-${suffix}-${randomUUID()}`,
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
        slug: `export-spec-loc-${randomUUID()}`,
        isActive: true,
        isDigitalOrderingEnabled: true,
      },
    });
    locationIds.push(location.id);
    return location.id;
  }

  async function makeOrder(options: {
    locationId: string;
    customerId?: string | null;
    subtotal: number;
    status?: 'RECEIVED' | 'ACCEPTED' | 'PREPARING' | 'READY' | 'COMPLETED';
    createdAt: Date;
  }): Promise<string> {
    const attempt = await prisma.paymentAttempt.create({
      data: {
        idempotencyKey: `export-spec-${randomUUID()}`,
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
        orderNumber: `EXP-${randomUUID().slice(0, 8)}`,
        accessToken: randomUUID(),
        locationId: options.locationId,
        customerId: options.customerId ?? null,
        paymentAttemptId: attempt.id,
        guestName: 'Export Spec',
        guestPhone: '5550000000',
        currency: 'USD',
        subtotal: options.subtotal,
        status: options.status ?? 'RECEIVED',
        createdAt: options.createdAt,
      },
    });
    orderIds.push(order.id);
    return order.id;
  }

  async function makeCustomer(createdAt: Date): Promise<string> {
    const customer = await prisma.customer.create({
      data: {
        externalProvider: 'dev',
        externalSubject: `export-spec-${randomUUID()}`,
        email: `export-spec-${randomUUID()}@example.com`,
        createdAt,
      },
    });
    customerIds.push(customer.id);
    return customer.id;
  }

  const getJson = (path: string, key: string, qs: string) =>
    request(app.getHttpServer())
      .get(`${path}${qs}`)
      .set('Authorization', `Bearer ${token(key)}`);

  const getExport = (path: string, key: string, qs: string) =>
    request(app.getHttpServer())
      .get(`${path}${qs}`)
      .set('Authorization', `Bearer ${token(key)}`);

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
    await prisma.checklistInstance.deleteMany({
      where: { id: { in: instanceIds } },
    });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.paymentAttempt.deleteMany({
      where: { id: { in: paymentAttemptIds } },
    });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.location.deleteMany({ where: { id: { in: locationIds } } });
    await app.close();
    process.env = { ...originalEnv };
  });

  // ---- Shared authorization/scope (checked once, via 9A's export as a
  // representative — the guard stack is identical on all four routes) ---

  describe('authorization (shared guard stack)', () => {
    const qs = '?startDate=2020-01-01&endDate=2020-01-01';

    it('an ACTIVE corporate user with reports.view gets 200', async () => {
      await getExport(
        '/api/v1/admin/reports/orders-overview/export',
        `viewer-${suffix}`,
        qs,
      ).expect(200);
    });

    it('an ACTIVE user without reports.view gets 403', async () => {
      await getExport(
        '/api/v1/admin/reports/orders-overview/export',
        `noPerm-${suffix}`,
        qs,
      ).expect(403);
    });

    it('a LOCATION-only reports.view grant cannot satisfy the CORPORATE-only route (403)', async () => {
      await getExport(
        '/api/v1/admin/reports/orders-overview/export',
        `locViewer-${suffix}`,
        qs,
      ).expect(403);
    });

    it('a customer token is rejected (401)', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/admin/reports/orders-overview/export${qs}`)
        .set('Authorization', `Bearer ${customerToken()}`)
        .expect(401);
    });

    it('a DISABLED internal user is blocked (403)', async () => {
      await getExport(
        '/api/v1/admin/reports/orders-overview/export',
        `disabled-${suffix}`,
        qs,
      ).expect(403);
    });

    it('inherits the same date validation as the JSON route (missing endDate -> 400)', async () => {
      await getExport(
        '/api/v1/admin/reports/orders-overview/export',
        `viewer-${suffix}`,
        '?startDate=2020-01-01',
      ).expect(400);
    });

    it('inherits the same date validation as the JSON route (start > end -> 400)', async () => {
      await getExport(
        '/api/v1/admin/reports/orders-overview/export',
        `viewer-${suffix}`,
        '?startDate=2020-01-10&endDate=2020-01-01',
      ).expect(400);
    });
  });

  // ---- Content-Type / Content-Disposition / BOM (checked once per route,
  // using a zero-activity range) ------------------------------------

  describe('response headers and BOM', () => {
    const cases: [string, string][] = [
      [
        '/api/v1/admin/reports/orders-overview/export',
        'mocha-house-digital-sales-orders_2020-01-01_to_2020-01-01.csv',
      ],
      [
        '/api/v1/admin/reports/location-performance/export',
        'mocha-house-location-performance_2020-01-01_to_2020-01-01.csv',
      ],
      [
        '/api/v1/admin/reports/operations-checklists/export',
        'mocha-house-operations-checklist-visibility_2020-01-01_to_2020-01-01.csv',
      ],
      [
        '/api/v1/admin/reports/customer-growth/export',
        'mocha-house-customer-growth-ordering_2020-01-01_to_2020-01-01.csv',
      ],
    ];

    it.each(cases)(
      '%s returns text/csv, an attachment Content-Disposition with the deterministic filename, and a UTF-8 BOM',
      async (path, filename) => {
        const res = await getExport(
          path,
          `viewer-${suffix}`,
          '?startDate=2020-01-01&endDate=2020-01-01',
        ).expect(200);
        expect(res.headers['content-type']).toContain('text/csv');
        expect(res.headers['content-type']).toContain('charset=utf-8');
        expect(res.headers['content-disposition']).toBe(
          `attachment; filename="${filename}"`,
        );
        const buffer = Buffer.from(res.text, 'utf8');
        expect(buffer[0]).toBe(0xef);
        expect(buffer[1]).toBe(0xbb);
        expect(buffer[2]).toBe(0xbf);
      },
    );
  });

  // ---- 9A — Digital Sales & Orders -------------------------------

  describe('9A export', () => {
    const startDate = '2029-01-10';
    const endDate = '2029-01-12';
    const day = businessDateStartInstant('2029-01-11');
    let location: string;
    let specialLocation: string;

    beforeAll(async () => {
      location = await makeLocation(`Export Spec Loc ${suffix}`);
      specialLocation = await makeLocation(
        `Ann Arbor, "Main St"\nSuite 2 ${suffix}`,
      );

      await makeOrder({
        locationId: location,
        subtotal: 1000,
        status: 'COMPLETED',
        createdAt: day,
      });
      await makeOrder({
        locationId: location,
        subtotal: 500,
        status: 'RECEIVED',
        createdAt: day,
      });
    }, 30_000);

    it('CSV values match the JSON endpoint for the same filters', async () => {
      const jsonRes = await getJson(
        '/api/v1/admin/reports/orders-overview',
        `viewer-${suffix}`,
        `?startDate=${startDate}&endDate=${endDate}&locationId=${location}`,
      ).expect(200);
      const json = jsonRes.body as AdminOrdersOverviewReport;

      const csvRes = await getExport(
        '/api/v1/admin/reports/orders-overview/export',
        `viewer-${suffix}`,
        `?startDate=${startDate}&endDate=${endDate}&locationId=${location}`,
      ).expect(200);
      const rows = parseCsv(Buffer.from(csvRes.text, 'utf8'));

      expect(findRow(rows, 'Start Date')?.[1]).toBe(startDate);
      expect(findRow(rows, 'End Date')?.[1]).toBe(endDate);
      expect(findRow(rows, 'Location')?.[1]).toBe(json.location!.name);
      expect(findRow(rows, 'Source Scope')?.[1]).toBe(json.source.scope);
      expect(findRow(rows, 'Source Description')?.[1]).toBe(
        json.source.scopeLabel,
      );
      expect(findRow(rows, 'Data Freshness')?.[1]).toBe(
        json.source.freshnessLabel,
      );
      expect(findRow(rows, 'Total Orders')?.[1]).toBe(
        String(json.totalOrders),
      );
      expect(findRow(rows, 'Completed Orders')?.[1]).toBe(
        String(json.completedOrders),
      );
      expect(findRow(rows, 'Digital Sales (USD)')?.[1]).toBe(
        (json.digitalSalesMinorUnits / 100).toFixed(2),
      );
      expect(findRow(rows, 'Average Order Value (USD)')?.[1]).toBe(
        (json.averageOrderValueMinorUnits / 100).toFixed(2),
      );
      // Status breakdown section present with every status row.
      const statusHeaderIndex = rows.findIndex(
        (r) => r[0] === 'Order Status',
      );
      expect(statusHeaderIndex).toBeGreaterThan(-1);
      expect(rows[statusHeaderIndex]).toEqual(['Order Status', 'Count']);
      const completedRow = rows[statusHeaderIndex + 5];
      expect(completedRow).toEqual([
        'Completed',
        String(json.statusBreakdown.COMPLETED),
      ]);
    });

    it('with no location filter, Location metadata row reads "All locations" and no locationId appears in the filename', async () => {
      const res = await getExport(
        '/api/v1/admin/reports/orders-overview/export',
        `viewer-${suffix}`,
        `?startDate=${startDate}&endDate=${endDate}`,
      ).expect(200);
      const rows = parseCsv(Buffer.from(res.text, 'utf8'));
      expect(findRow(rows, 'Location')?.[1]).toBe('All locations');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="mocha-house-digital-sales-orders_${startDate}_to_${endDate}.csv"`,
      );
    });

    it('the selected location is reflected in the export filename', async () => {
      const res = await getExport(
        '/api/v1/admin/reports/orders-overview/export',
        `viewer-${suffix}`,
        `?startDate=${startDate}&endDate=${endDate}&locationId=${location}`,
      ).expect(200);
      expect(res.headers['content-disposition']).toContain(
        'export-spec-loc',
      );
    });

    it('a location name with a comma, quote and embedded newline is escaped correctly in the Location metadata row', async () => {
      const res = await getExport(
        '/api/v1/admin/reports/orders-overview/export',
        `viewer-${suffix}`,
        `?startDate=${startDate}&endDate=${endDate}&locationId=${specialLocation}`,
      ).expect(200);
      const rows = parseCsv(Buffer.from(res.text, 'utf8'));
      expect(findRow(rows, 'Location')?.[1]).toBe(
        `Ann Arbor, "Main St"\nSuite 2 ${suffix}`,
      );
    });

    it('zero-order range produces a well-formed CSV with all-zero values', async () => {
      const res = await getExport(
        '/api/v1/admin/reports/orders-overview/export',
        `viewer-${suffix}`,
        '?startDate=2020-01-01&endDate=2020-01-01',
      ).expect(200);
      const rows = parseCsv(Buffer.from(res.text, 'utf8'));
      expect(findRow(rows, 'Total Orders')?.[1]).toBe('0');
      expect(findRow(rows, 'Digital Sales (USD)')?.[1]).toBe('0.00');
    });
  });

  // ---- 9B — Location Performance -----------------------------------

  describe('9B export', () => {
    it('CSV values, row ordering and the Completed % caveat match the JSON endpoint', async () => {
      const startDate = '2020-01-01';
      const endDate = '2020-01-01';
      const jsonRes = await getJson(
        '/api/v1/admin/reports/location-performance',
        `viewer-${suffix}`,
        `?startDate=${startDate}&endDate=${endDate}`,
      ).expect(200);
      const json = jsonRes.body as AdminLocationPerformanceReport;

      const csvRes = await getExport(
        '/api/v1/admin/reports/location-performance/export',
        `viewer-${suffix}`,
        `?startDate=${startDate}&endDate=${endDate}`,
      ).expect(200);
      const rows = parseCsv(Buffer.from(csvRes.text, 'utf8'));

      expect(
        rows.some((r) =>
          r[1]?.startsWith('Completed % reflects orders whose current status'),
        ),
      ).toBe(true);

      const headerIndex = rows.findIndex((r) => r[0] === 'Location');
      expect(rows[headerIndex]).toEqual([
        'Location',
        'Active',
        'Digital Ordering Enabled',
        'Total Orders',
        'Completed Orders',
        'Completed %',
        'Digital Sales (USD)',
        'Average Order Value (USD)',
      ]);
      const dataRows = rows.slice(headerIndex + 1);
      expect(dataRows.map((r) => r[0])).toEqual(
        json.locations.map((l) => l.locationName),
      );
      if (json.locations.length > 0) {
        const firstJson = json.locations[0];
        const firstCsv = dataRows[0];
        expect(firstCsv[1]).toBe(firstJson.isActive ? 'Yes' : 'No');
        expect(firstCsv[5]).toBe(String(firstJson.completedPercent));
      }
    });

    it('a location name with a comma and quote is escaped correctly in a data row', async () => {
      const specialLocation = await prisma.location.create({
        data: {
          name: `Special, "Loc" ${suffix}`,
          slug: `export-spec-b-${randomUUID()}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      });
      locationIds.push(specialLocation.id);

      const res = await getExport(
        '/api/v1/admin/reports/location-performance/export',
        `viewer-${suffix}`,
        '?startDate=2020-01-01&endDate=2020-01-01',
      ).expect(200);
      const rows = parseCsv(Buffer.from(res.text, 'utf8'));
      expect(
        rows.some((r) => r[0] === `Special, "Loc" ${suffix}`),
      ).toBe(true);
    });

    it('a location name starting with whitespace + a formula-trigger character is protected in the real export', async () => {
      const formulaLocation = await prisma.location.create({
        data: {
          name: `   =SUM(A1:A2) ${suffix}`,
          slug: `export-spec-formula-${randomUUID()}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      });
      locationIds.push(formulaLocation.id);

      const res = await getExport(
        '/api/v1/admin/reports/location-performance/export',
        `viewer-${suffix}`,
        '?startDate=2020-01-01&endDate=2020-01-01',
      ).expect(200);
      const rows = parseCsv(Buffer.from(res.text, 'utf8'));
      expect(
        rows.some((r) => r[0] === `'   =SUM(A1:A2) ${suffix}`),
      ).toBe(true);
    });
  });

  // ---- 9C — Operations Checklist Visibility --------------------------

  describe('9C export', () => {
    it('both caveats are present verbatim, Current Exceptions columns exist, and no missed/compliance field appears', async () => {
      const res = await getExport(
        '/api/v1/admin/reports/operations-checklists/export',
        `viewer-${suffix}`,
        '?startDate=2020-01-01&endDate=2020-01-01',
      ).expect(200);
      const rows = parseCsv(Buffer.from(res.text, 'utf8'));

      expect(
        rows.some((r) =>
          r[1]?.includes(
            'Checklist instances are created when staff access a checklist',
          ),
        ),
      ).toBe(true);
      expect(
        rows.some((r) =>
          r[1]?.includes('Current Exceptions reflects exceptions still recorded'),
        ),
      ).toBe(true);

      const headerIndex = rows.findIndex((r) => r[0] === 'Location');
      expect(rows[headerIndex]).toEqual([
        'Location',
        'Active',
        'Opening Started',
        'Opening Completed',
        'Opening Current Exceptions',
        'Closing Started',
        'Closing Completed',
        'Closing Current Exceptions',
      ]);

      // No METRIC/COLUMN is ever named "missed" or "compliance" — the
      // word "missed" legitimately appears once, inside the caveat prose
      // itself (explaining that we do NOT report it), which the earlier
      // assertions already pinned down verbatim; this checks the data
      // shape, not the free-text note.
      const headerAndDataRows = rows.slice(headerIndex);
      const structuralText = headerAndDataRows
        .flat()
        .join('|')
        .toLowerCase();
      expect(structuralText).not.toContain('missed');
      expect(structuralText).not.toContain('compliance');
      expect(structuralText).not.toContain('percent');
      expect(structuralText).not.toContain('%');
    });
  });

  // ---- 9D — Customer Growth & Ordering -------------------------------

  describe('9D export', () => {
    it('exposes exactly the six approved metrics, both disclosures, and no customer-level rows', async () => {
      const startDate = '2029-02-10';
      const endDate = '2029-02-12';
      const midDay = businessDateStartInstant('2029-02-11');
      const customerLocation = await makeLocation(
        `Customer Growth Export Loc ${suffix}`,
      );
      const customer = await makeCustomer(midDay);
      await makeOrder({
        locationId: customerLocation,
        customerId: customer,
        subtotal: 500,
        createdAt: midDay,
      });

      const jsonRes = await getJson(
        '/api/v1/admin/reports/customer-growth',
        `viewer-${suffix}`,
        `?startDate=${startDate}&endDate=${endDate}`,
      ).expect(200);
      const json = jsonRes.body as AdminCustomerGrowthReport;

      const csvRes = await getExport(
        '/api/v1/admin/reports/customer-growth/export',
        `viewer-${suffix}`,
        `?startDate=${startDate}&endDate=${endDate}`,
      ).expect(200);
      const rows = parseCsv(Buffer.from(csvRes.text, 'utf8'));

      expect(
        rows.some((r) =>
          r[1]?.includes('Repeat Registered Customers means registered'),
        ),
      ).toBe(true);
      expect(
        rows.some((r) =>
          r[1]?.includes('Order-based figures include digital-platform'),
        ),
      ).toBe(true);

      expect(findRow(rows, 'Registered Customers as of End Date')?.[1]).toBe(
        String(json.registeredCustomersAsOfEndDate),
      );
      expect(findRow(rows, 'New Registered Customers')?.[1]).toBe(
        String(json.newRegisteredCustomers),
      );
      expect(findRow(rows, 'Registered Customers With Orders')?.[1]).toBe(
        String(json.registeredCustomersWithOrders),
      );
      expect(findRow(rows, 'Repeat Registered Customers')?.[1]).toBe(
        String(json.repeatRegisteredCustomers),
      );
      expect(findRow(rows, 'Registered Customer Orders')?.[1]).toBe(
        String(json.registeredCustomerOrders),
      );
      expect(findRow(rows, 'Guest Orders')?.[1]).toBe(
        String(json.guestOrders),
      );

      // No customer-level data (e.g. an email address) ever appears.
      const raw = csvRes.text;
      expect(raw).not.toContain('@example.com');
    });
  });

  // ---- JSON regression (contract shape / values unaffected) ----------

  it('the JSON endpoints remain unaffected by the export routes existing', async () => {
    const res = await getJson(
      '/api/v1/admin/reports/orders-overview',
      `viewer-${suffix}`,
      '?startDate=2020-01-01&endDate=2020-01-01',
    ).expect(200);
    const body = res.body as AdminOrdersOverviewReport;
    expect(Object.keys(body).sort()).toEqual(
      [
        'filters',
        'location',
        'availableLocations',
        'totalOrders',
        'completedOrders',
        'digitalSalesMinorUnits',
        'averageOrderValueMinorUnits',
        'statusBreakdown',
        'source',
      ].sort(),
    );
  });
});
