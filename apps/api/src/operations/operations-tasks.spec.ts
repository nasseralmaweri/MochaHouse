import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { OperationsTasksResponse } from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { OperationsModule } from './operations.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import {
  businessDateToStorage,
  resolveBusinessDate,
} from './application/business-date';

type Status = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
type Scope = { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null };

// Today's Tasks (Milestone 6C), over real local Postgres. Covers the
// current-business-date scope, location scoping, the read/write permission
// split, the Add / Complete / Reopen / Delete actions and the "no
// rollover" rule (a prior-day task cannot be listed or mutated).
describe("Today's Tasks (integration)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'operations-tasks-spec-internal-secret';
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
        key: `tasks-spec-${suffix}-${randomUUID()}`,
        displayName: 'Tasks Spec Role',
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
        name: `Tasks Spec Loc ${randomUUID()}`,
        slug: `tasks-loc-${randomUUID()}`,
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

  const listTasks = (key: string, locationId: string) =>
    request(app.getHttpServer())
      .get(
        `/api/v1/admin/operations/tasks?locationId=${encodeURIComponent(locationId)}`,
      )
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`);

  const addTask = (key: string, body: unknown) =>
    request(app.getHttpServer())
      .post('/api/v1/admin/operations/tasks')
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  const taskAction = (
    key: string,
    taskId: string,
    action: 'complete' | 'reopen' | 'delete',
    locationId: string,
  ) =>
    request(app.getHttpServer())
      .post(`/api/v1/admin/operations/tasks/${taskId}/${action}`)
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send({ locationId });

  const today = () => businessDateToStorage(resolveBusinessDate(new Date()));

  async function clearTasks(): Promise<void> {
    await prisma.operationsTask.deleteMany({
      where: { locationId: { in: [locA, locB] } },
    });
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'operations-tasks-spec-customer-secret';

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

    await makeUserWithRole(
      'managerA',
      ['operations.view', 'operations.tasks.complete'],
      { scopeType: 'LOCATION', scopeId: locA },
    );
    await makeUserWithRole('viewerA', ['operations.view'], {
      scopeType: 'LOCATION',
      scopeId: locA,
    });
    await makeUserWithRole(
      'corpManager',
      ['operations.view', 'operations.tasks.complete'],
      { scopeType: 'CORPORATE', scopeId: null },
    );
    await makeUser(`noPerm-${suffix}`);
  }, 45_000);

  afterEach(clearTasks);

  afterAll(async () => {
    await clearTasks();
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

  // ---- Authorization -------------------------------------------

  it('GET requires operations.view for the location', async () => {
    await listTasks('noPerm', locA).expect(403);
    await listTasks('managerA', locB).expect(403); // manager is scoped to locA
  });

  it('write actions require operations.tasks.complete for the location', async () => {
    await addTask('viewerA', { locationId: locA, title: 'nope' }).expect(403);
    await addTask('managerA', { locationId: locB, title: 'nope' }).expect(403);
  });

  it('a viewer can read but not write', async () => {
    const created = await prisma.operationsTask.create({
      data: {
        locationId: locA,
        businessDate: today(),
        title: 'Seeded task',
        createdByInternalUserId: userIds[0],
      },
    });
    const body = (await listTasks('viewerA', locA).expect(200))
      .body as OperationsTasksResponse;
    expect(body.tasks.map((t) => t.id)).toContain(created.id);
    await taskAction('viewerA', created.id, 'complete', locA).expect(403);
  });

  // ---- Create / list ------------------------------------------

  it('adds a task for today and lists it (open, with creator)', async () => {
    const res = await addTask('managerA', {
      locationId: locA,
      title: '  Restock the pastry case  ',
      note: '  extra croissants  ',
    }).expect(201);
    const body = res.body as OperationsTasksResponse;
    expect(body.locationId).toBe(locA);
    expect(body.businessDate).toBe(resolveBusinessDate(new Date()));
    expect(body.openCount).toBe(1);
    expect(body.doneCount).toBe(0);
    const task = body.tasks[0];
    expect(task.title).toBe('Restock the pastry case');
    expect(task.note).toBe('extra croissants');
    expect(task.done).toBe(false);
    expect(task.createdBy).toEqual({ name: `managerA-${suffix}` });

    const row = await prisma.operationsTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.businessDate.getTime()).toBe(today().getTime());
    expect(row.note).toBe('extra croissants');
  });

  it('an empty note is stored as null', async () => {
    const body = (
      await addTask('managerA', {
        locationId: locA,
        title: 'No note',
        note: '   ',
      }).expect(201)
    ).body as OperationsTasksResponse;
    expect(body.tasks[0].note).toBeNull();
  });

  it('rejects a blank / over-long title and an over-long note', async () => {
    await addTask('managerA', { locationId: locA, title: '   ' }).expect(400);
    await addTask('managerA', {
      locationId: locA,
      title: 'x'.repeat(201),
    }).expect(400);
    await addTask('managerA', {
      locationId: locA,
      title: 'ok',
      note: 'y'.repeat(501),
    }).expect(400);
  });

  // ---- Complete / reopen / delete ----------------------------

  it('completes, reopens and deletes a task', async () => {
    const taskId = (
      (
        await addTask('managerA', {
          locationId: locA,
          title: 'Do the thing',
        }).expect(201)
      ).body as OperationsTasksResponse
    ).tasks[0].id;

    const done = (
      await taskAction('managerA', taskId, 'complete', locA).expect(201)
    ).body as OperationsTasksResponse;
    expect(done.doneCount).toBe(1);
    expect(done.openCount).toBe(0);
    expect(done.tasks[0].done).toBe(true);
    expect(done.tasks[0].completedBy).toEqual({ name: `managerA-${suffix}` });

    // Idempotent re-complete.
    await taskAction('managerA', taskId, 'complete', locA).expect(201);

    const reopened = (
      await taskAction('managerA', taskId, 'reopen', locA).expect(201)
    ).body as OperationsTasksResponse;
    expect(reopened.openCount).toBe(1);
    expect(reopened.tasks[0].done).toBe(false);
    expect(reopened.tasks[0].completedBy).toBeNull();

    const afterDelete = (
      await taskAction('managerA', taskId, 'delete', locA).expect(201)
    ).body as OperationsTasksResponse;
    expect(afterDelete.tasks).toHaveLength(0);
    expect(
      await prisma.operationsTask.findUnique({ where: { id: taskId } }),
    ).toBeNull();
  });

  it('open tasks are listed before done tasks, oldest first', async () => {
    const first = (
      (
        await addTask('managerA', { locationId: locA, title: 'First' }).expect(
          201,
        )
      ).body as OperationsTasksResponse
    ).tasks[0].id;
    await addTask('managerA', { locationId: locA, title: 'Second' }).expect(
      201,
    );
    await addTask('managerA', { locationId: locA, title: 'Third' }).expect(201);
    await taskAction('managerA', first, 'complete', locA).expect(201);

    const body = (await listTasks('managerA', locA).expect(200))
      .body as OperationsTasksResponse;
    expect(body.tasks.map((t) => t.title)).toEqual([
      'Second',
      'Third',
      'First',
    ]);
    expect(body.tasks.map((t) => t.done)).toEqual([false, false, true]);
  });

  // ---- Cross-location + no-rollover --------------------------

  it("a task cannot be acted on from another location's request", async () => {
    const taskId = (
      (
        await addTask('managerA', { locationId: locA, title: 'A task' }).expect(
          201,
        )
      ).body as OperationsTasksResponse
    ).tasks[0].id;
    // corpManager is authorized for locB too, but the task belongs to locA.
    await taskAction('corpManager', taskId, 'complete', locB).expect(404);
  });

  it("yesterday's tasks do not roll over and cannot be listed or mutated", async () => {
    const yesterday = new Date(today());
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const stale = await prisma.operationsTask.create({
      data: {
        locationId: locA,
        businessDate: yesterday,
        title: 'Yesterday task',
        createdByInternalUserId: userIds[0],
      },
    });

    const body = (await listTasks('managerA', locA).expect(200))
      .body as OperationsTasksResponse;
    expect(body.tasks.map((t) => t.id)).not.toContain(stale.id);

    await taskAction('managerA', stale.id, 'complete', locA).expect(404);
    await taskAction('managerA', stale.id, 'delete', locA).expect(404);

    await prisma.operationsTask.delete({ where: { id: stale.id } });
  });

  it('unknown task id is a 404', async () => {
    await taskAction('managerA', randomUUID(), 'complete', locA).expect(404);
  });

  // ---- Audit isolation --------------------------------------

  it('routine task actions create no InternalAuditEvent', async () => {
    const before = await prisma.internalAuditEvent.count();
    const taskId = (
      (
        await addTask('managerA', {
          locationId: locA,
          title: 'Quiet task',
        }).expect(201)
      ).body as OperationsTasksResponse
    ).tasks[0].id;
    await taskAction('managerA', taskId, 'complete', locA).expect(201);
    await taskAction('managerA', taskId, 'reopen', locA).expect(201);
    await taskAction('managerA', taskId, 'delete', locA).expect(201);
    expect(await prisma.internalAuditEvent.count()).toBe(before);
  });
});
