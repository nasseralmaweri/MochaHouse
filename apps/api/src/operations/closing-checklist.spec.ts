import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { OpeningChecklistResponse } from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { OperationsModule } from './operations.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { resolveBusinessDate } from './application/business-date';

type Status = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
type Scope = { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null };

// Closing Checklist (Milestone 6D), over real local Postgres. The
// execution and configuration services are shared with the Opening
// Checklist (parameterised by ChecklistTemplate.key), so this spec proves
// the CLOSING wiring — the seeded 14-item standard, section order,
// location/business-date scoping, Complete/Undo/progress, the Management
// Exception, and that Opening and Closing instances stay isolated.
describe('Closing Checklist (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'closing-checklist-spec-internal-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const locationIds: string[] = [];

  let locA: string;
  let locB: string;

  const token = (key: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${key}`, email: `${key}@example.com`, name: null },
      internalSecret,
      3600,
    );

  async function makeUser(
    key: string,
    status: Status = 'ACTIVE',
  ): Promise<string> {
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

  async function makeRole(permissionKeys: string[]): Promise<string> {
    const role = await prisma.internalRole.create({
      data: {
        key: `closing-spec-${suffix}-${randomUUID()}`,
        displayName: 'Closing Spec Role',
        permissions: {
          create: permissionKeys.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    roleIds.push(role.id);
    return role.id;
  }

  async function assign(userId: string, roleId: string, scope: Scope) {
    await prisma.internalUserRoleAssignment.create({
      data: { internalUserId: userId, roleId, ...scope },
    });
  }

  async function makeLocation(): Promise<string> {
    const location = await prisma.location.create({
      data: {
        name: `Closing Spec Loc ${randomUUID()}`,
        slug: `closing-loc-${randomUUID()}`,
        isActive: true,
        isDigitalOrderingEnabled: true,
      },
    });
    locationIds.push(location.id);
    return location.id;
  }

  async function makeUserWithRole(
    key: string,
    permissionKeys: string[],
    scope: Scope,
  ): Promise<void> {
    const roleId = await makeRole(permissionKeys);
    const userId = await makeUser(`${key}-${suffix}`);
    await assign(userId, roleId, scope);
  }

  const base = (kind: 'closing' | 'opening') =>
    `/api/v1/admin/operations/${kind}-checklist`;

  const getChecklist = (
    key: string,
    locationId: string,
    kind: 'closing' | 'opening' = 'closing',
  ) =>
    request(app.getHttpServer())
      .get(`${base(kind)}?locationId=${encodeURIComponent(locationId)}`)
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`);

  const completeItem = (
    key: string,
    itemId: string,
    locationId: string,
    kind: 'closing' | 'opening' = 'closing',
  ) =>
    request(app.getHttpServer())
      .post(`${base(kind)}/items/${itemId}/complete`)
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send({ locationId });

  const undoItem = (key: string, itemId: string, locationId: string) =>
    request(app.getHttpServer())
      .post(`${base('closing')}/items/${itemId}/undo`)
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send({ locationId });

  const logException = (key: string, itemId: string, body: unknown) =>
    request(app.getHttpServer())
      .post(`${base('closing')}/items/${itemId}/exception`)
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  const clearException = (key: string, itemId: string, body: unknown) =>
    request(app.getHttpServer())
      .post(`${base('closing')}/items/${itemId}/exception/clear`)
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  function itemIds(body: OpeningChecklistResponse): string[] {
    return body.sections.flatMap((s) => s.items.map((i) => i.id));
  }

  async function clearInstances(): Promise<void> {
    await prisma.checklistInstanceItem.deleteMany({
      where: { checklistInstance: { locationId: { in: [locA, locB] } } },
    });
    await prisma.checklistInstance.deleteMany({
      where: { locationId: { in: [locA, locB] } },
    });
  }

  async function clearAuditEvents(): Promise<void> {
    await prisma.internalAuditEvent.deleteMany({
      where: {
        actorInternalUserId: { in: userIds },
        action: {
          in: [
            'operations.checklist_exception_logged',
            'operations.checklist_exception_cleared',
          ],
        },
      },
    });
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'closing-checklist-spec-customer-secret';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        OperationsModule,
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    locA = await makeLocation();
    locB = await makeLocation();

    await makeUserWithRole('viewCorp', ['operations.view'], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await makeUserWithRole(
      'managerA',
      [
        'operations.view',
        'operations.tasks.complete',
        'operations.exceptions.manage',
      ],
      { scopeType: 'LOCATION', scopeId: locA },
    );
    await makeUserWithRole(
      'completerA',
      ['operations.view', 'operations.tasks.complete'],
      { scopeType: 'LOCATION', scopeId: locA },
    );
    await makeUser(`noPerm-${suffix}`);

    // A Store Manager (the seeded built-in role) at locA — proves the seed
    // grants both execution and exception capability for Closing too.
    const storeManager = await prisma.internalRole.findUniqueOrThrow({
      where: { key: 'store-manager' },
    });
    const storeMgr = await makeUser(`storeMgr-${suffix}`);
    await assign(storeMgr, storeManager.id, {
      scopeType: 'LOCATION',
      scopeId: locA,
    });
  }, 45_000);

  afterEach(async () => {
    await clearAuditEvents();
    await clearInstances();
  });

  afterAll(async () => {
    await clearAuditEvents();
    await clearInstances();
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIds } },
    });
    for (const id of roleIds) {
      await prisma.internalRolePermission.deleteMany({ where: { roleId: id } });
      await prisma.internalRole.deleteMany({ where: { id } });
    }
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.location.deleteMany({ where: { id: { in: locationIds } } });
    await app.close();
    process.env = { ...originalEnv };
  });

  // ---- GET: lazy creation + seeded standard ---------------------

  it("GET lazily creates today's Closing Checklist with the seeded 14 items in section order", async () => {
    expect(
      await prisma.checklistInstance.count({
        where: { locationId: locA, template: { key: 'closing' } },
      }),
    ).toBe(0);

    const body = (await getChecklist('managerA', locA).expect(200))
      .body as OpeningChecklistResponse;

    expect(body.title).toBe('Closing Checklist');
    expect(body.businessDate).toBe(resolveBusinessDate(new Date()));
    expect(body.progress).toEqual({
      completed: 0,
      resolved: 0,
      total: 14,
      isComplete: false,
    });
    expect(body.sections.map((s) => s.name)).toEqual([
      'End-of-Shift & Cleaning',
      'Cash Handling & Security',
      'Building & Final Close',
    ]);
    expect(body.sections.map((s) => s.items.length)).toEqual([7, 3, 4]);
    expect(body.sections[0].items[0].label).toBe(
      'Properly store all perishable food items using FIFO.',
    );
    // The cash-float item is a plain checkbox — no dollar field anywhere.
    expect(JSON.stringify(body)).not.toMatch(
      /float.*\$|floatAmount|cashFloat/i,
    );

    expect(
      await prisma.checklistInstance.count({
        where: { locationId: locA, template: { key: 'closing' } },
      }),
    ).toBe(1);
  });

  it('a second GET returns the same instance', async () => {
    await getChecklist('managerA', locA).expect(200);
    await getChecklist('completerA', locA).expect(200);
    expect(
      await prisma.checklistInstance.count({
        where: { locationId: locA, template: { key: 'closing' } },
      }),
    ).toBe(1);
  });

  it('Opening and Closing are separate instances for the same location/day', async () => {
    await getChecklist('managerA', locA, 'opening').expect(200);
    await getChecklist('managerA', locA, 'closing').expect(200);
    const instances = await prisma.checklistInstance.findMany({
      where: { locationId: locA },
      include: { template: { select: { key: true } } },
    });
    expect(instances.map((i) => i.template.key).sort()).toEqual([
      'closing',
      'opening',
    ]);
  });

  // ---- Authorization / scope ----------------------------------

  it('operations.view is required to read', async () => {
    await getChecklist('noPerm', locA).expect(403);
    // no instance is created for a caller who can't see the location
    expect(
      await prisma.checklistInstance.count({ where: { locationId: locA } }),
    ).toBe(0);
  });

  it('operations.tasks.complete is required to Complete / Undo', async () => {
    const body = (await getChecklist('managerA', locA).expect(200))
      .body as OpeningChecklistResponse;
    const [id] = itemIds(body);
    await completeItem('viewCorp', id, locA).expect(403);
  });

  it('a location-scoped user cannot act on another location', async () => {
    const body = (await getChecklist('managerA', locA).expect(200))
      .body as OpeningChecklistResponse;
    const [id] = itemIds(body);
    await getChecklist('managerA', locB).expect(403);
    await completeItem('managerA', id, locB).expect(403);
  });

  it('a Closing endpoint rejects an Opening item id (cross-checklist isolation)', async () => {
    const opening = (
      await getChecklist('managerA', locA, 'opening').expect(200)
    ).body as OpeningChecklistResponse;
    const openingItemId = itemIds(opening)[0];
    // Same permission + location + business date, but the item belongs to
    // the Opening instance → 404 from the Closing route.
    await completeItem('managerA', openingItemId, locA, 'closing').expect(404);
    await logException('managerA', openingItemId, {
      locationId: locA,
      reason: 'x',
    }).expect(404);
  });

  // ---- Complete / Undo / progress ----------------------------

  it('completes items, tracks progress, and marks the instance complete', async () => {
    const ids = itemIds(
      (await getChecklist('managerA', locA).expect(200))
        .body as OpeningChecklistResponse,
    );

    let body = (await completeItem('managerA', ids[0], locA).expect(201))
      .body as OpeningChecklistResponse;
    expect(body.progress.completed).toBe(1);
    expect(body.progress.resolved).toBe(1);
    expect(body.sections[0].items[0]).toMatchObject({
      status: 'completed',
      completed: true,
      completedBy: { name: `managerA-${suffix}` },
    });

    body = (await undoItem('managerA', ids[0], locA).expect(201))
      .body as OpeningChecklistResponse;
    expect(body.progress.completed).toBe(0);

    for (const id of ids) {
      body = (await completeItem('managerA', id, locA).expect(201))
        .body as OpeningChecklistResponse;
    }
    expect(body.progress.isComplete).toBe(true);
    expect(
      (
        await prisma.checklistInstance.findFirstOrThrow({
          where: { locationId: locA, template: { key: 'closing' } },
        })
      ).completedAt,
    ).not.toBeNull();
  });

  // ---- Management Exception (shared 6C behaviour) ------------

  it('logs and clears a management exception; it counts as resolved but stays distinct', async () => {
    const ids = itemIds(
      (await getChecklist('managerA', locA).expect(200))
        .body as OpeningChecklistResponse,
    );

    // Complete everything except the last item.
    for (const id of ids.slice(0, -1)) {
      await completeItem('managerA', id, locA).expect(201);
    }

    const withException = (
      await logException('managerA', ids.at(-1)!, {
        locationId: locA,
        reason: '  Safe would not lock — service scheduled  ',
      }).expect(201)
    ).body as OpeningChecklistResponse;

    const item = withException.sections
      .flatMap((s) => s.items)
      .find((i) => i.id === ids.at(-1));
    expect(item).toMatchObject({
      status: 'exception',
      resolved: true,
      completed: false,
      completedAt: null,
    });
    expect(item?.exception?.reason).toBe(
      'Safe would not lock — service scheduled',
    );
    expect(withException.progress.completed).toBe(13);
    expect(withException.progress.resolved).toBe(14);
    expect(withException.progress.isComplete).toBe(true);

    // Clearing the exception makes the checklist incomplete again.
    const cleared = (
      await clearException('managerA', ids.at(-1)!, {
        locationId: locA,
      }).expect(201)
    ).body as OpeningChecklistResponse;
    expect(
      cleared.sections.flatMap((s) => s.items).find((i) => i.id === ids.at(-1))
        ?.status,
    ).toBe('open');
    expect(cleared.progress.isComplete).toBe(false);
  });

  it('operations.exceptions.manage is required; a completer-only user cannot', async () => {
    const [id] = itemIds(
      (await getChecklist('managerA', locA).expect(200))
        .body as OpeningChecklistResponse,
    );
    await logException('completerA', id, {
      locationId: locA,
      reason: 'nope',
    }).expect(403);
  });

  it('the seeded Store Manager role can log a Closing exception', async () => {
    const [id] = itemIds(
      (await getChecklist('storeMgr', locA).expect(200))
        .body as OpeningChecklistResponse,
    );
    await logException('storeMgr', id, {
      locationId: locA,
      reason: 'Delivery blocked the loading dock',
    }).expect(201);
  });

  it('a blank / over-long exception reason is rejected', async () => {
    const [id] = itemIds(
      (await getChecklist('managerA', locA).expect(200))
        .body as OpeningChecklistResponse,
    );
    await logException('managerA', id, {
      locationId: locA,
      reason: '   ',
    }).expect(400);
    await logException('managerA', id, {
      locationId: locA,
      reason: 'x'.repeat(501),
    }).expect(400);
  });

  it('completion and exception are mutually exclusive (409 both ways)', async () => {
    const ids = itemIds(
      (await getChecklist('managerA', locA).expect(200))
        .body as OpeningChecklistResponse,
    );
    await completeItem('managerA', ids[0], locA).expect(201);
    await logException('managerA', ids[0], {
      locationId: locA,
      reason: 'too late',
    }).expect(409);

    await logException('managerA', ids[1], {
      locationId: locA,
      reason: 'broken',
    }).expect(201);
    await completeItem('managerA', ids[1], locA).expect(409);
  });

  // ---- Exception audit (shared 6C behaviour) ----------------

  it('logging / clearing a Closing exception writes exactly one audit event each; routine ops write none', async () => {
    const ids = itemIds(
      (await getChecklist('managerA', locA).expect(200))
        .body as OpeningChecklistResponse,
    );
    const actor = await prisma.internalUser.findFirstOrThrow({
      where: { externalSubject: `internal-dev:managerA-${suffix}` },
    });

    await logException('managerA', ids[0], {
      locationId: locA,
      reason: 'Alarm panel fault',
    }).expect(201);
    const logged = await prisma.internalAuditEvent.findMany({
      where: { action: 'operations.checklist_exception_logged' },
    });
    expect(logged).toHaveLength(1);
    expect(logged[0].actorInternalUserId).toBe(actor.id);
    expect(logged[0].targetType).toBe('checklist_instance_item');
    expect(logged[0].targetId).toBe(ids[0]);
    expect(logged[0].reason).toBe('Alarm panel fault');

    await clearException('managerA', ids[0], { locationId: locA }).expect(201);
    expect(
      await prisma.internalAuditEvent.count({
        where: { action: 'operations.checklist_exception_cleared' },
      }),
    ).toBe(1);

    const before = await prisma.internalAuditEvent.count();
    await completeItem('managerA', ids[1], locA).expect(201);
    await undoItem('managerA', ids[1], locA).expect(201);
    expect(await prisma.internalAuditEvent.count()).toBe(before);
  });

  // ---- Historical snapshot safety --------------------------

  it('an HQ template edit after an instance exists never rewrites that instance', async () => {
    const before = (await getChecklist('managerA', locA).expect(200))
      .body as OpeningChecklistResponse;
    const labelsBefore = before.sections.flatMap((s) =>
      s.items.map((i) => i.label),
    );

    const template = await prisma.checklistTemplate.findUniqueOrThrow({
      where: { key: 'closing' },
    });
    const firstItem = await prisma.checklistTemplateItem.findFirstOrThrow({
      where: { templateId: template.id },
      orderBy: { sortOrder: 'asc' },
    });
    await prisma.checklistTemplateItem.update({
      where: { id: firstItem.id },
      data: { label: 'HQ REWORDED CLOSING', isActive: false },
    });
    try {
      const after = (await getChecklist('managerA', locA).expect(200))
        .body as OpeningChecklistResponse;
      expect(
        after.sections.flatMap((s) => s.items.map((i) => i.label)),
      ).toEqual(labelsBefore);
      expect(after.progress.total).toBe(14);
    } finally {
      await prisma.checklistTemplateItem.update({
        where: { id: firstItem.id },
        data: { label: firstItem.label, isActive: true },
      });
    }
  });

  it('a NEW instance reflects the current active Closing template', async () => {
    const template = await prisma.checklistTemplate.findUniqueOrThrow({
      where: { key: 'closing' },
    });
    const target = await prisma.checklistTemplateItem.findFirstOrThrow({
      where: { templateId: template.id, label: 'Prepare next-day sandwiches.' },
    });
    await prisma.checklistTemplateItem.update({
      where: { id: target.id },
      data: { isActive: false },
    });
    try {
      // afterEach clears locA's instance, so this GET creates a fresh one.
      const body = (await getChecklist('managerA', locA).expect(200))
        .body as OpeningChecklistResponse;
      expect(body.progress.total).toBe(13);
      expect(
        body.sections.flatMap((s) => s.items.map((i) => i.label)),
      ).not.toContain('Prepare next-day sandwiches.');
    } finally {
      await prisma.checklistTemplateItem.update({
        where: { id: target.id },
        data: { isActive: true },
      });
    }
  });
});
