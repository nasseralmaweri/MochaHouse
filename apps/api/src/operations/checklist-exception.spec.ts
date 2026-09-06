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

type Status = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
type Scope = { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null };

// Opening Checklist — Management Exception (Milestone 6C), over real local
// Postgres. Covers the dedicated permission, the reason rules, the
// state-machine integrity (open ⇄ completed, open ⇄ exception; never both),
// that an exception resolves the item and the checklist without rendering
// as an ordinary checkmark, and the audit events (exactly one per
// log/clear, none for routine Complete/Undo).
describe('Opening Checklist management exception (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'checklist-exception-spec-internal-secret';
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
        key: `exc-spec-${suffix}-${randomUUID()}`,
        displayName: 'Exception Spec Role',
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
        name: `Exception Spec Loc ${randomUUID()}`,
        slug: `exc-loc-${randomUUID()}`,
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

  const getChecklist = (key: string, locationId: string) =>
    request(app.getHttpServer())
      .get(
        `/api/v1/admin/operations/opening-checklist?locationId=${encodeURIComponent(locationId)}`,
      )
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`);

  const completeItem = (key: string, itemId: string, locationId: string) =>
    request(app.getHttpServer())
      .post(
        `/api/v1/admin/operations/opening-checklist/items/${itemId}/complete`,
      )
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send({ locationId });

  const undoItem = (key: string, itemId: string, locationId: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/admin/operations/opening-checklist/items/${itemId}/undo`)
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send({ locationId });

  const logException = (key: string, itemId: string, body: unknown) =>
    request(app.getHttpServer())
      .post(
        `/api/v1/admin/operations/opening-checklist/items/${itemId}/exception`,
      )
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  const clearException = (key: string, itemId: string, body: unknown) =>
    request(app.getHttpServer())
      .post(
        `/api/v1/admin/operations/opening-checklist/items/${itemId}/exception/clear`,
      )
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  async function itemIds(key: string, locationId: string): Promise<string[]> {
    const body = (await getChecklist(key, locationId).expect(200))
      .body as OpeningChecklistResponse;
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
    process.env.AUTH_DEV_JWT_SECRET =
      'checklist-exception-spec-customer-secret';

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

    // A full store manager for locA: view + complete + exceptions.
    await makeUserWithRole(
      'managerA',
      [
        'operations.view',
        'operations.tasks.complete',
        'operations.exceptions.manage',
      ],
      { scopeType: 'LOCATION', scopeId: locA },
    );
    // Complete only — must NOT be able to log an exception.
    await makeUserWithRole(
      'completerA',
      ['operations.view', 'operations.tasks.complete'],
      { scopeType: 'LOCATION', scopeId: locA },
    );
    // Corporate: view + complete + exceptions everywhere.
    await makeUserWithRole(
      'corp',
      [
        'operations.view',
        'operations.tasks.complete',
        'operations.exceptions.manage',
      ],
      { scopeType: 'CORPORATE', scopeId: null },
    );
    // The seeded built-in Store Manager role — proves the seed grants the
    // exception capability.
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

  // ---- Permission / scope -------------------------------------

  it('operations.exceptions.manage is required (complete permission is not enough)', async () => {
    const [itemId] = await itemIds('managerA', locA);
    await logException('completerA', itemId, {
      locationId: locA,
      reason: 'Fridge was down',
    }).expect(403);
    await clearException('completerA', itemId, { locationId: locA }).expect(
      403,
    );
  });

  it('the exception permission is location-scoped', async () => {
    const [itemId] = await itemIds('corp', locA);
    // managerA holds exceptions only at locA.
    await logException('managerA', itemId, {
      locationId: locB,
      reason: 'x',
    }).expect(403);
  });

  it('the seeded Store Manager role can log an exception', async () => {
    const [itemId] = await itemIds('storeMgr', locA);
    await logException('storeMgr', itemId, {
      locationId: locA,
      reason: 'Vendor delivery missed',
    }).expect(201);
  });

  // ---- Reason validation --------------------------------------

  it('requires a non-blank reason of at most 500 characters', async () => {
    const [itemId] = await itemIds('managerA', locA);
    await logException('managerA', itemId, { locationId: locA }).expect(400);
    await logException('managerA', itemId, {
      locationId: locA,
      reason: '   ',
    }).expect(400);
    await logException('managerA', itemId, {
      locationId: locA,
      reason: 'x'.repeat(501),
    }).expect(400);
  });

  // ---- Log / clear + projection ------------------------------

  it('logs an exception: item is resolved, distinct from a normal completion', async () => {
    const [itemId] = await itemIds('managerA', locA);
    const res = await logException('managerA', itemId, {
      locationId: locA,
      reason: '  Water heater failed inspection  ',
    }).expect(201);
    const body = res.body as OpeningChecklistResponse;
    const item = body.sections
      .flatMap((s) => s.items)
      .find((i) => i.id === itemId)!;

    expect(item.status).toBe('exception');
    expect(item.resolved).toBe(true);
    expect(item.completed).toBe(false);
    expect(item.completedBy).toBeNull();
    expect(item.completedAt).toBeNull();
    expect(item.exception?.reason).toBe('Water heater failed inspection');
    expect(item.exception?.by).toEqual({ name: `managerA-${suffix}` });
    expect(typeof item.exception?.at).toBe('string');

    expect(body.progress.completed).toBe(0);
    expect(body.progress.resolved).toBe(1);

    const row = await prisma.checklistInstanceItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    expect(row.exceptionReason).toBe('Water heater failed inspection');
    expect(row.exceptionAt).not.toBeNull();
    expect(row.completedAt).toBeNull();
  });

  it('clears an exception: item returns to open', async () => {
    const [itemId] = await itemIds('managerA', locA);
    await logException('managerA', itemId, {
      locationId: locA,
      reason: 'Reason A',
    }).expect(201);
    const res = await clearException('managerA', itemId, {
      locationId: locA,
    }).expect(201);
    const item = (res.body as OpeningChecklistResponse).sections
      .flatMap((s) => s.items)
      .find((i) => i.id === itemId)!;
    expect(item.status).toBe('open');
    expect(item.resolved).toBe(false);
    expect(item.exception).toBeNull();
  });

  // ---- State-machine integrity ------------------------------

  it('a completed item cannot be given an exception (409); an exception item cannot be completed (409)', async () => {
    const [a, b] = await itemIds('managerA', locA);

    await completeItem('managerA', a, locA).expect(201);
    await logException('managerA', a, {
      locationId: locA,
      reason: 'too late',
    }).expect(409);
    const rowA = await prisma.checklistInstanceItem.findUniqueOrThrow({
      where: { id: a },
    });
    expect(rowA.completedAt).not.toBeNull();
    expect(rowA.exceptionAt).toBeNull();

    await logException('managerA', b, {
      locationId: locA,
      reason: 'broken',
    }).expect(201);
    await completeItem('managerA', b, locA).expect(409);
    const rowB = await prisma.checklistInstanceItem.findUniqueOrThrow({
      where: { id: b },
    });
    expect(rowB.exceptionAt).not.toBeNull();
    expect(rowB.completedAt).toBeNull();
  });

  it('Undo does not touch an exception; Clear does not touch a normal completion', async () => {
    const [a, b] = await itemIds('managerA', locA);
    await logException('managerA', a, { locationId: locA, reason: 'r' }).expect(
      201,
    );
    await undoItem('managerA', a, locA).expect(201); // no-op on an exception item
    expect(
      (
        await prisma.checklistInstanceItem.findUniqueOrThrow({
          where: { id: a },
        })
      ).exceptionAt,
    ).not.toBeNull();

    await completeItem('managerA', b, locA).expect(201);
    await clearException('managerA', b, { locationId: locA }).expect(201); // no-op
    expect(
      (
        await prisma.checklistInstanceItem.findUniqueOrThrow({
          where: { id: b },
        })
      ).completedAt,
    ).not.toBeNull();
  });

  // ---- Checklist-level resolution ---------------------------

  it('the checklist reaches complete with a mix of completions and one exception', async () => {
    const ids = await itemIds('managerA', locA);
    for (const id of ids.slice(0, -1)) {
      await completeItem('managerA', id, locA).expect(201);
    }
    let body = (await getChecklist('managerA', locA).expect(200))
      .body as OpeningChecklistResponse;
    expect(body.progress.isComplete).toBe(false);

    body = (
      await logException('managerA', ids.at(-1)!, {
        locationId: locA,
        reason: 'Drive-thru headset dead — parts on order',
      }).expect(201)
    ).body as OpeningChecklistResponse;

    expect(body.progress.completed).toBe(ids.length - 1);
    expect(body.progress.resolved).toBe(ids.length);
    expect(body.progress.isComplete).toBe(true);

    const instance = await prisma.checklistInstance.findFirstOrThrow({
      where: { locationId: locA },
    });
    expect(instance.completedAt).not.toBeNull();

    // Clearing the exception makes the checklist incomplete again.
    await clearException('managerA', ids.at(-1)!, { locationId: locA }).expect(
      201,
    );
    const after = await prisma.checklistInstance.findFirstOrThrow({
      where: { locationId: locA },
    });
    expect(after.completedAt).toBeNull();
  });

  // ---- Cross-location / historical safety -------------------

  it('a cross-location exception request is rejected without leaking', async () => {
    const [itemA] = await itemIds('managerA', locA);
    await logException('corp', itemA, { locationId: locB, reason: 'x' }).expect(
      404,
    );
    expect(
      (
        await prisma.checklistInstanceItem.findUniqueOrThrow({
          where: { id: itemA },
        })
      ).exceptionAt,
    ).toBeNull();
  });

  it('a template edit after an exception is logged never rewrites the instance', async () => {
    const [itemId] = await itemIds('managerA', locA);
    await logException('managerA', itemId, {
      locationId: locA,
      reason: 'Original reason',
    }).expect(201);

    const template = await prisma.checklistTemplate.findUniqueOrThrow({
      where: { key: 'opening' },
    });
    const firstTemplateItem =
      await prisma.checklistTemplateItem.findFirstOrThrow({
        where: { templateId: template.id },
        orderBy: { sortOrder: 'asc' },
      });
    await prisma.checklistTemplateItem.update({
      where: { id: firstTemplateItem.id },
      data: { label: 'HQ REWORDED' },
    });
    try {
      const body = (await getChecklist('managerA', locA).expect(200))
        .body as OpeningChecklistResponse;
      const item = body.sections
        .flatMap((s) => s.items)
        .find((i) => i.id === itemId)!;
      expect(item.status).toBe('exception');
      expect(item.exception?.reason).toBe('Original reason');
      expect(
        body.sections.flatMap((s) => s.items.map((i) => i.label)),
      ).not.toContain('HQ REWORDED');
    } finally {
      await prisma.checklistTemplateItem.update({
        where: { id: firstTemplateItem.id },
        data: { label: firstTemplateItem.label },
      });
    }
  });

  // ---- Audit ------------------------------------------------

  it('logging and clearing each write exactly one InternalAuditEvent; routine ops write none', async () => {
    const [a, b] = await itemIds('managerA', locA);

    const actor = await prisma.internalUser.findFirstOrThrow({
      where: { externalSubject: `internal-dev:managerA-${suffix}` },
    });

    await logException('managerA', a, {
      locationId: locA,
      reason: 'Compressor tripped the breaker',
    }).expect(201);

    const logged = await prisma.internalAuditEvent.findMany({
      where: { action: 'operations.checklist_exception_logged' },
    });
    expect(logged).toHaveLength(1);
    expect(logged[0].actorInternalUserId).toBe(actor.id);
    expect(logged[0].targetType).toBe('checklist_instance_item');
    expect(logged[0].targetId).toBe(a);
    expect(logged[0].reason).toBe('Compressor tripped the breaker');
    expect(logged[0].afterData).toMatchObject({
      resolution: 'exception',
      reason: 'Compressor tripped the breaker',
      location: { id: locA },
    });

    await clearException('managerA', a, { locationId: locA }).expect(201);
    const cleared = await prisma.internalAuditEvent.findMany({
      where: { action: 'operations.checklist_exception_cleared' },
    });
    expect(cleared).toHaveLength(1);
    expect(cleared[0].targetId).toBe(a);

    // Routine Complete / Undo write nothing.
    const before = await prisma.internalAuditEvent.count();
    await completeItem('managerA', b, locA).expect(201);
    await undoItem('managerA', b, locA).expect(201);
    expect(await prisma.internalAuditEvent.count()).toBe(before);

    // An idempotent no-op clear (item already open) writes nothing.
    await clearException('managerA', b, { locationId: locA }).expect(201);
    expect(
      await prisma.internalAuditEvent.count({
        where: { action: 'operations.checklist_exception_cleared' },
      }),
    ).toBe(1);
  });

  it('these exception events do not appear in the Admin activity log', async () => {
    // The activity log is scoped to internal-user targets; a
    // checklist_instance_item event must never surface there.
    const [itemId] = await itemIds('managerA', locA);
    await logException('managerA', itemId, {
      locationId: locA,
      reason: 'Kept off the activity log',
    }).expect(201);

    const rows = await prisma.internalAuditEvent.findMany({
      where: { targetType: 'internal_user' },
    });
    expect(
      rows.some((r) => r.action.startsWith('operations.checklist_exception')),
    ).toBe(false);
  });

  // ---- Concurrency ----------------------------------------

  it('concurrent Complete + Log Exception resolve the item exactly one way', async () => {
    const [itemId] = await itemIds('managerA', locA);
    // supertest only rejects on a transport error, so Promise.all resolves
    // with both responses regardless of their HTTP status.
    const results = await Promise.all([
      completeItem('managerA', itemId, locA),
      logException('managerA', itemId, { locationId: locA, reason: 'race' }),
    ]);
    const statuses = results.map((r) => r.status);
    // One wins (201), the other conflicts (409).
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(1);

    const row = await prisma.checklistInstanceItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    const completedResolved =
      row.completedAt !== null && row.exceptionAt === null;
    const exceptionResolved =
      row.exceptionAt !== null && row.completedAt === null;
    expect(completedResolved || exceptionResolved).toBe(true);
  });
});
