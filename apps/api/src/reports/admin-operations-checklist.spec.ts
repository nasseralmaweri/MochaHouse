import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { AdminOperationsChecklistReport } from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { ReportsModule } from './reports.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';
import { businessDateToStorage } from '../operations/application/business-date';

type Status = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

// Milestone 9C — HQ Operations Checklist Visibility, over real local
// Postgres. This is OPERATIONS VISIBILITY, not compliance scoring: the
// tests below deliberately prove the two load-bearing semantic rules —
// (1) a location with zero recorded instances is included with all-zero
// counts, never reported as "missed"; (2) "Current Exceptions" reflects
// only the live state of ChecklistInstanceItem.exceptionAt, so a
// logged-then-cleared exception is NOT counted — alongside the usual
// permission/scope/date-validation/inclusion/sorting/source coverage.
describe('Admin reports — operations checklist visibility (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'admin-ops-checklist-spec-internal-secret';
  const customerSecret = 'admin-ops-checklist-spec-customer-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const locationIds: string[] = [];
  const instanceIds: string[] = [];
  const roles: Record<string, string> = {};
  let openingTemplateId: string;
  let closingTemplateId: string;

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
        key: `ops-checklist-spec-${suffix}-${randomUUID()}`,
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

  async function makeLocation(
    name: string,
    options: { isActive?: boolean } = {},
  ): Promise<string> {
    const location = await prisma.location.create({
      data: {
        name,
        slug: `ops-checklist-loc-${randomUUID()}`,
        isActive: options.isActive ?? true,
        isDigitalOrderingEnabled: true,
      },
    });
    locationIds.push(location.id);
    return location.id;
  }

  async function makeInstance(options: {
    templateId: string;
    locationId: string;
    businessDate: string; // YYYY-MM-DD
    completedAt?: Date | null;
    items?: {
      completedAt?: Date | null;
      exceptionAt?: Date | null;
      exceptionReason?: string | null;
    }[];
  }): Promise<string> {
    const instance = await prisma.checklistInstance.create({
      data: {
        templateId: options.templateId,
        locationId: options.locationId,
        businessDate: businessDateToStorage(options.businessDate),
        completedAt: options.completedAt ?? null,
        items: {
          create: (options.items ?? []).map((item, index) => ({
            section: 'Test Section',
            label: `Test item ${index + 1}`,
            sortOrder: index + 1,
            completedAt: item.completedAt ?? null,
            exceptionAt: item.exceptionAt ?? null,
            exceptionReason: item.exceptionReason ?? null,
          })),
        },
      },
    });
    instanceIds.push(instance.id);
    return instance.id;
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
      .get(`/api/v1/admin/reports/operations-checklists${qs ? `?${qs}` : ''}`)
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

    const opening = await prisma.checklistTemplate.findUniqueOrThrow({
      where: { key: 'opening' },
      select: { id: true },
    });
    const closing = await prisma.checklistTemplate.findUniqueOrThrow({
      where: { key: 'closing' },
      select: { id: true },
    });
    openingTemplateId = opening.id;
    closingTemplateId = closing.id;

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
        '/api/v1/admin/reports/operations-checklists?startDate=2020-01-01&endDate=2020-01-01',
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

  // ---- Fixtures: inclusion rule, classification, metrics, boundaries -

  describe('with fixtures', () => {
    const startDate = '2027-05-10';
    const endDate = '2027-05-12';
    const midDay = '2027-05-11';
    const dayBefore = '2027-05-09';
    const dayAfter = '2027-05-13';

    let activeZeroActivity: string;
    let activeWithActivity: string;
    let inactiveWithActivity: string;
    let inactiveNoActivity: string;
    let boundaryLocation: string;

    beforeAll(async () => {
      activeZeroActivity = await makeLocation(`ZZZ Active Zero ${suffix}`);
      activeWithActivity = await makeLocation(`AAA Active Activity ${suffix}`);
      inactiveWithActivity = await makeLocation(`Inactive History ${suffix}`, {
        isActive: false,
      });
      inactiveNoActivity = await makeLocation(`Inactive Empty ${suffix}`, {
        isActive: false,
      });
      boundaryLocation = await makeLocation(`Boundary Loc ${suffix}`);

      // activeWithActivity: 2 opening instances (on two different in-range
      // business dates — one location can only have one instance per
      // template per day), 1 closing instance.
      // Opening #1 (startDate): started, NOT completed. One item has a
      // CURRENT exception.
      await makeInstance({
        templateId: openingTemplateId,
        locationId: activeWithActivity,
        businessDate: startDate,
        completedAt: null,
        items: [{ exceptionAt: new Date() }],
      });
      // Opening #2 (midDay): started AND completed. One item completed
      // normally (not an exception); one item's live state is "no
      // exception" — standing in for a logged-then-cleared exception,
      // which is indistinguishable from "never exceptioned" at the
      // live-row level (that IS the point of the Current Exceptions
      // limitation).
      await makeInstance({
        templateId: openingTemplateId,
        locationId: activeWithActivity,
        businessDate: midDay,
        completedAt: new Date(),
        items: [{ completedAt: new Date() }, { exceptionAt: null }],
      });
      // Closing #1: started, not completed. One item has a current exception.
      await makeInstance({
        templateId: closingTemplateId,
        locationId: activeWithActivity,
        businessDate: midDay,
        completedAt: null,
        items: [{ exceptionAt: new Date() }],
      });

      // inactiveWithActivity: 1 opening instance in range.
      await makeInstance({
        templateId: openingTemplateId,
        locationId: inactiveWithActivity,
        businessDate: midDay,
        completedAt: new Date(),
      });

      // Boundary fixtures — all opening, one per boundary case.
      await makeInstance({
        templateId: openingTemplateId,
        locationId: boundaryLocation,
        businessDate: dayBefore, // excluded: before the range
      });
      await makeInstance({
        templateId: openingTemplateId,
        locationId: boundaryLocation,
        businessDate: startDate, // included: exactly the start boundary
      });
      await makeInstance({
        templateId: openingTemplateId,
        locationId: boundaryLocation,
        businessDate: endDate, // included: exactly the end boundary
      });
      await makeInstance({
        templateId: openingTemplateId,
        locationId: boundaryLocation,
        businessDate: dayAfter, // excluded: after the range
      });
    }, 30_000);

    function rowFor(report: AdminOperationsChecklistReport, locationId: string) {
      return report.locations.find((l) => l.locationId === locationId);
    }

    it('includes an active location with zero recorded checklist activity, all-zero', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate,
        endDate,
      }).expect(200);
      const body = res.body as AdminOperationsChecklistReport;
      const row = rowFor(body, activeZeroActivity)!;
      expect(row).toBeDefined();
      expect(row.isActive).toBe(true);
      expect(row.openingStarted).toBe(0);
      expect(row.openingCompleted).toBe(0);
      expect(row.openingCurrentExceptions).toBe(0);
      expect(row.closingStarted).toBe(0);
      expect(row.closingCompleted).toBe(0);
      expect(row.closingCurrentExceptions).toBe(0);
    });

    it('includes an inactive location with activity in the selected period', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate,
        endDate,
      }).expect(200);
      const body = res.body as AdminOperationsChecklistReport;
      const row = rowFor(body, inactiveWithActivity)!;
      expect(row).toBeDefined();
      expect(row.isActive).toBe(false);
      expect(row.openingStarted).toBe(1);
      expect(row.openingCompleted).toBe(1);
    });

    it('excludes an inactive location with no activity in the selected period', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate,
        endDate,
      }).expect(200);
      const body = res.body as AdminOperationsChecklistReport;
      expect(rowFor(body, inactiveNoActivity)).toBeUndefined();
    });

    it('classifies opening and closing independently, with correct Started/Completed/Current Exceptions', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate,
        endDate,
      }).expect(200);
      const body = res.body as AdminOperationsChecklistReport;
      const row = rowFor(body, activeWithActivity)!;

      expect(row.openingStarted).toBe(2);
      expect(row.openingCompleted).toBe(1);
      // Only opening instance #1's item carries a live exception; instance
      // #2's completed item and its "cleared" stand-in do not count.
      expect(row.openingCurrentExceptions).toBe(1);

      expect(row.closingStarted).toBe(1);
      expect(row.closingCompleted).toBe(0);
      expect(row.closingCurrentExceptions).toBe(1);
    });

    it('a completed, non-exception item is not counted as a current exception', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate,
        endDate,
      }).expect(200);
      const body = res.body as AdminOperationsChecklistReport;
      // If the normally-completed item in opening instance #2 were
      // miscounted, openingCurrentExceptions would be 2, not 1.
      expect(rowFor(body, activeWithActivity)!.openingCurrentExceptions).toBe(
        1,
      );
    });

    it('a cleared exception (live exceptionAt null) is not counted', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate,
        endDate,
      }).expect(200);
      const body = res.body as AdminOperationsChecklistReport;
      // Total items across both opening instances is 3 (1 + 2); only 1
      // carries a live exception, proving the "cleared" stand-in item is
      // excluded.
      expect(rowFor(body, activeWithActivity)!.openingCurrentExceptions).toBe(
        1,
      );
    });

    it('over the full range, only the two boundary-dated instances count (2 of the 4 seeded)', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate,
        endDate,
      }).expect(200);
      const body = res.body as AdminOperationsChecklistReport;
      // Four instances exist for this location, one per day: dayBefore,
      // startDate, endDate, dayAfter. Only startDate and endDate fall
      // inside [startDate, endDate], so this must be exactly 2 — not 0, 1,
      // 3, or 4.
      expect(rowFor(body, boundaryLocation)!.openingStarted).toBe(2);
    });

    it('includes the exact start-boundary business date when narrowed to just that day', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate,
        endDate: startDate,
      }).expect(200);
      const body = res.body as AdminOperationsChecklistReport;
      expect(rowFor(body, boundaryLocation)!.openingStarted).toBe(1);
    });

    it('includes the exact end-boundary business date when narrowed to just that day', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate: endDate,
        endDate,
      }).expect(200);
      const body = res.body as AdminOperationsChecklistReport;
      expect(rowFor(body, boundaryLocation)!.openingStarted).toBe(1);
    });

    it('excludes the day immediately before the range when narrowed to just that day', async () => {
      // dayBefore's own instance exists (proving the fixture itself is
      // real and queryable on its own day) — combined with the "2 of 4"
      // test above, this confirms it is excluded specifically because of
      // the range filter, not because the fixture never existed.
      const ownDay = await getReport(`viewer-${suffix}`, {
        startDate: dayBefore,
        endDate: dayBefore,
      }).expect(200);
      expect(
        rowFor(ownDay.body as AdminOperationsChecklistReport, boundaryLocation)!
          .openingStarted,
      ).toBe(1);
    });

    it('excludes the day immediately after the range when narrowed to just that day', async () => {
      const ownDay = await getReport(`viewer-${suffix}`, {
        startDate: dayAfter,
        endDate: dayAfter,
      }).expect(200);
      expect(
        rowFor(ownDay.body as AdminOperationsChecklistReport, boundaryLocation)!
          .openingStarted,
      ).toBe(1);
    });

    it('trusts the persisted ChecklistInstance.completedAt rather than recomputing from items', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate,
        endDate,
      }).expect(200);
      const body = res.body as AdminOperationsChecklistReport;
      // Opening instance #1 was created with completedAt: null even though
      // it has an item (exceptioned); it must NOT count toward Completed.
      // Opening instance #2 was created with completedAt explicitly set;
      // it must count, regardless of its items' individual states.
      expect(rowFor(body, activeWithActivity)!.openingCompleted).toBe(1);
    });

    it('sorts rows by locationName ascending, never by a metric', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate,
        endDate,
      }).expect(200);
      const body = res.body as AdminOperationsChecklistReport;
      const names = body.locations
        .map((l) => l.locationName)
        .filter((name) =>
          [
            `ZZZ Active Zero ${suffix}`,
            `AAA Active Activity ${suffix}`,
            `Inactive History ${suffix}`,
          ].includes(name),
        );
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
      expect(
        names.indexOf(`AAA Active Activity ${suffix}`),
      ).toBeLessThan(names.indexOf(`ZZZ Active Zero ${suffix}`));
    });

    it('exposes no actor identifiers, percentage, or missed/compliance field', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate,
        endDate,
      }).expect(200);
      const raw = JSON.stringify(res.body).toLowerCase();
      expect(raw).not.toContain('completedby');
      expect(raw).not.toContain('exceptionby');
      expect(raw).not.toContain('actor');
      expect(raw).not.toContain('percent');
      expect(raw).not.toContain('rate');
      expect(raw).not.toContain('missed');
      expect(raw).not.toContain('compliance');
      expect(raw).not.toContain('score');
    });

    it('states the INTERNAL_OPERATIONS source scope, never digital-platform wording', async () => {
      const res = await getReport(`viewer-${suffix}`, {
        startDate,
        endDate,
      }).expect(200);
      const body = res.body as AdminOperationsChecklistReport;
      expect(body.source.scope).toBe('INTERNAL_OPERATIONS');
      expect(body.source.scopeLabel.toLowerCase()).toContain('operations');
      expect(body.source.scopeLabel.toLowerCase()).not.toContain('digital-platform');
      expect(body.source.scopeLabel.toLowerCase()).not.toContain('pos');
      expect(body.source.freshnessLabel).toBe('Live platform data');
    });
  });

  // ---- Permission regression ----------------------------

  it('Platform Administrator has reports.view; Store Manager does not (shared with 9A/9B)', async () => {
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
