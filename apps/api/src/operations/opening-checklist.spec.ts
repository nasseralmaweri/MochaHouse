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
import {
  businessDateToStorage,
  resolveBusinessDate,
} from './application/business-date';

type Status = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

// Admin → Operations → Today → Opening Checklist (Milestone 6B), over real
// local Postgres. Authentication / lifecycle enforcement is proven in
// internal-authorization.spec — this covers the checklist workflow,
// per-location scope, snapshot history, and the derived completion state.
describe('Opening Checklist (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'opening-checklist-spec-internal-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const locationIds: string[] = [];
  const instanceIds: string[] = [];
  const roles: Record<string, string> = {};

  let locA: string;
  let locB: string;

  const token = (key: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${key}`, email: `${key}@example.com`, name: null },
      internalSecret,
      3600,
    );

  async function makeUser(key: string, status: Status = 'ACTIVE'): Promise<string> {
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
        key: `opening-spec-${suffix}-${randomUUID()}`,
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

  async function makeLocation(): Promise<string> {
    const location = await prisma.location.create({
      data: {
        name: `Opening Spec Loc ${randomUUID()}`,
        slug: `opening-loc-${randomUUID()}`,
        isActive: true,
        isDigitalOrderingEnabled: true,
      },
    });
    locationIds.push(location.id);
    return location.id;
  }

  const getChecklist = (key: string, locationId: string) =>
    request(app.getHttpServer())
      .get(
        `/api/v1/admin/operations/opening-checklist?locationId=${encodeURIComponent(
          locationId,
        )}`,
      )
      .set('Authorization', `Bearer ${token(key)}`);

  const completeItem = (key: string, itemId: string, locationId: string) =>
    request(app.getHttpServer())
      .post(
        `/api/v1/admin/operations/opening-checklist/items/${itemId}/complete`,
      )
      .set('Authorization', `Bearer ${token(key)}`)
      .send({ locationId });

  const undoItem = (key: string, itemId: string, locationId: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/admin/operations/opening-checklist/items/${itemId}/undo`)
      .set('Authorization', `Bearer ${token(key)}`)
      .send({ locationId });

  async function openingTemplateId(): Promise<string> {
    const template = await prisma.checklistTemplate.findUniqueOrThrow({
      where: { key: 'opening' },
    });
    return template.id;
  }

  function allItemIds(checklist: OpeningChecklistResponse): string[] {
    return checklist.sections.flatMap((s) => s.items.map((i) => i.id));
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'opening-checklist-spec-customer-secret';

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

    roles.viewCorp = await makeRole('Ops View Corp', ['operations.view']);
    roles.fullCorp = await makeRole('Ops Full Corp', [
      'operations.view',
      'operations.tasks.complete',
    ]);
    roles.viewLocA = await makeRole('Ops View Loc', ['operations.view']);
    roles.fullLocA = await makeRole('Ops Full Loc', [
      'operations.view',
      'operations.tasks.complete',
    ]);

    await makeUser(`viewCorp-${suffix}`);
    await assign(userIds.at(-1)!, roles.viewCorp, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await makeUser(`fullCorp-${suffix}`);
    await assign(userIds.at(-1)!, roles.fullCorp, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await makeUser(`viewLocA-${suffix}`);
    await assign(userIds.at(-1)!, roles.viewLocA, {
      scopeType: 'LOCATION',
      scopeId: locA,
    });

    await makeUser(`fullLocA-${suffix}`);
    await assign(userIds.at(-1)!, roles.fullLocA, {
      scopeType: 'LOCATION',
      scopeId: locA,
    });

    // A Store Manager (the seeded built-in role) at locA — proves the seed
    // grants operations.tasks.complete location-scoped.
    const storeManager = await prisma.internalRole.findUniqueOrThrow({
      where: { key: 'store-manager' },
    });
    await makeUser(`storeMgr-${suffix}`);
    await assign(userIds.at(-1)!, storeManager.id, {
      scopeType: 'LOCATION',
      scopeId: locA,
    });
  }, 45_000);

  afterEach(async () => {
    // Each test starts from "no instance for locA/locB today". Snapshot
    // history tests that need a stale instance create their own.
    await prisma.checklistInstanceItem.deleteMany({
      where: { checklistInstance: { locationId: { in: [locA, locB] } } },
    });
    await prisma.checklistInstance.deleteMany({
      where: { locationId: { in: [locA, locB] } },
    });
  });

  afterAll(async () => {
    await prisma.checklistInstanceItem.deleteMany({
      where: { checklistInstanceId: { in: instanceIds } },
    });
    await prisma.checklistInstance.deleteMany({
      where: { locationId: { in: locationIds } },
    });
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

  // ---- GET: lazy creation + idempotency (1-3) ----------------------

  it('GET lazily creates today\'s Opening Checklist (1)', async () => {
    const before = await prisma.checklistInstance.count({
      where: { locationId: locA },
    });
    expect(before).toBe(0);

    const res = await getChecklist(`viewCorp-${suffix}`, locA).expect(200);
    const body = res.body as OpeningChecklistResponse;

    expect(body.locationId).toBe(locA);
    expect(body.title).toBe('Opening Checklist');
    expect(body.businessDate).toBe(resolveBusinessDate(new Date()));
    expect(body.progress.total).toBe(23);
    expect(body.progress.completed).toBe(0);
    expect(body.progress.isComplete).toBe(false);
    expect(body.sections.map((s) => s.name)).toEqual([
      'Building & Security',
      'Equipment',
      'Coffee & Beverage Preparation',
      'Food Preparation & Stocking',
      'Cash & POS',
      'Final Readiness',
    ]);

    const after = await prisma.checklistInstance.count({
      where: { locationId: locA },
    });
    expect(after).toBe(1);
  });

  it('a second GET returns the same instance (2)', async () => {
    await getChecklist(`viewCorp-${suffix}`, locA).expect(200);
    await getChecklist(`fullLocA-${suffix}`, locA).expect(200);

    const instances = await prisma.checklistInstance.findMany({
      where: { locationId: locA },
    });
    expect(instances).toHaveLength(1);
  });

  it('concurrent GET/create produces exactly one instance (3)', async () => {
    const results = await Promise.all([
      getChecklist(`viewCorp-${suffix}`, locA),
      getChecklist(`fullCorp-${suffix}`, locA),
      getChecklist(`viewLocA-${suffix}`, locA),
      getChecklist(`fullLocA-${suffix}`, locA),
    ]);
    for (const res of results) {
      expect(res.status).toBe(200);
    }

    const instances = await prisma.checklistInstance.findMany({
      where: { locationId: locA },
      include: { items: true },
    });
    expect(instances).toHaveLength(1);
    // Never a partially populated instance.
    expect(instances[0].items).toHaveLength(23);

    const ids = new Set(
      results.map((r) => (r.body as OpeningChecklistResponse).sections[0].items[0].id),
    );
    expect(ids.size).toBe(1);
  });

  // ---- Snapshot / item-toggle foundation (4, 5, 22) ---------------

  it('only ACTIVE template items are snapshotted into a new instance (4)', async () => {
    const templateId = await openingTemplateId();
    const target = await prisma.checklistTemplateItem.findFirstOrThrow({
      where: { templateId, label: 'Fill ice bins.' },
    });
    await prisma.checklistTemplateItem.update({
      where: { id: target.id },
      data: { isActive: false },
    });
    try {
      const res = await getChecklist(`viewCorp-${suffix}`, locB).expect(200);
      const body = res.body as OpeningChecklistResponse;
      expect(body.progress.total).toBe(22);
      expect(
        body.sections.flatMap((s) => s.items.map((i) => i.label)),
      ).not.toContain('Fill ice bins.');
    } finally {
      await prisma.checklistTemplateItem.update({
        where: { id: target.id },
        data: { isActive: true },
      });
      await prisma.checklistInstance.deleteMany({ where: { locationId: locB } });
    }
  });

  it('a template edit/toggle AFTER creation never rewrites the existing instance (5, 22)', async () => {
    const res = await getChecklist(`viewCorp-${suffix}`, locA).expect(200);
    const before = res.body as OpeningChecklistResponse;
    const originalLabels = before.sections.flatMap((s) =>
      s.items.map((i) => i.label),
    );

    const templateId = await openingTemplateId();
    const first = await prisma.checklistTemplateItem.findFirstOrThrow({
      where: { templateId, sortOrder: 1 },
    });
    await prisma.checklistTemplateItem.update({
      where: { id: first.id },
      data: { label: 'REWORDED IN 6B-2', isActive: false, sortOrder: 99 },
    });
    try {
      const after = (
        await getChecklist(`viewCorp-${suffix}`, locA).expect(200)
      ).body as OpeningChecklistResponse;
      expect(
        after.sections.flatMap((s) => s.items.map((i) => i.label)),
      ).toEqual(originalLabels);
      expect(after.progress.total).toBe(23);
    } finally {
      await prisma.checklistTemplateItem.update({
        where: { id: first.id },
        data: {
          label: 'Unlock employee entrance and disarm security alarm.',
          isActive: true,
          sortOrder: 1,
        },
      });
    }
  });

  // ---- Authorization / location scope (6, 7, 20, 21) --------------

  it('operations.view is required to view (6)', async () => {
    await makeUser(`noPerm-${suffix}`);
    await assign(
      userIds.at(-1)!,
      await makeRole('Orders Only', ['orders.view']),
      { scopeType: 'CORPORATE', scopeId: null },
    );
    await getChecklist(`noPerm-${suffix}`, locA).expect(403);
  });

  it('a LOCATION-scoped viewer cannot access another location (7)', async () => {
    await getChecklist(`viewLocA-${suffix}`, locB).expect(403);
    // No instance is created for a location the caller can't see.
    expect(
      await prisma.checklistInstance.count({ where: { locationId: locB } }),
    ).toBe(0);
  });

  it('operations.tasks.complete is required to Complete (8)', async () => {
    const checklist = (
      await getChecklist(`fullCorp-${suffix}`, locA).expect(200)
    ).body as OpeningChecklistResponse;
    const itemId = allItemIds(checklist)[0];
    await completeItem(`viewCorp-${suffix}`, itemId, locA).expect(403);
    await completeItem(`viewLocA-${suffix}`, itemId, locA).expect(403);
  });

  it('operations.tasks.complete is required to Undo (9)', async () => {
    const checklist = (
      await getChecklist(`fullCorp-${suffix}`, locA).expect(200)
    ).body as OpeningChecklistResponse;
    const itemId = allItemIds(checklist)[0];
    await completeItem(`fullCorp-${suffix}`, itemId, locA).expect(201);
    await undoItem(`viewCorp-${suffix}`, itemId, locA).expect(403);
  });

  it('a cross-location mutation does not leak or act on another location (20)', async () => {
    const checklistA = (
      await getChecklist(`fullCorp-${suffix}`, locA).expect(200)
    ).body as OpeningChecklistResponse;
    const itemA = allItemIds(checklistA)[0];

    // fullLocA holds complete only at locA. Claiming locB (unauthorized) → 403.
    await completeItem(`fullLocA-${suffix}`, itemA, locB).expect(403);

    // fullCorp is authorized for locB, but itemA belongs to locA's instance
    // → 404 (non-leaking), and itemA stays incomplete.
    await completeItem(`fullCorp-${suffix}`, itemA, locB).expect(404);

    const item = await prisma.checklistInstanceItem.findUniqueOrThrow({
      where: { id: itemA },
    });
    expect(item.completedAt).toBeNull();
  });

  it('a prior-business-date mutation is rejected without leaking (21)', async () => {
    const templateId = await openingTemplateId();
    const yesterday = new Date(businessDateToStorage(resolveBusinessDate(new Date())));
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    const stale = await prisma.checklistInstance.create({
      data: {
        templateId,
        locationId: locA,
        businessDate: yesterday,
        items: {
          create: [
            { section: 'Building & Security', label: 'Old item', sortOrder: 1 },
          ],
        },
      },
      include: { items: true },
    });
    instanceIds.push(stale.id);

    await completeItem(`fullCorp-${suffix}`, stale.items[0].id, locA).expect(404);
    await undoItem(`fullCorp-${suffix}`, stale.items[0].id, locA).expect(404);

    const item = await prisma.checklistInstanceItem.findUniqueOrThrow({
      where: { id: stale.items[0].id },
    });
    expect(item.completedAt).toBeNull();
  });

  it('Store Manager receives operations.tasks.complete location-scoped (10)', async () => {
    const checklist = (
      await getChecklist(`storeMgr-${suffix}`, locA).expect(200)
    ).body as OpeningChecklistResponse;
    const itemId = allItemIds(checklist)[0];

    await completeItem(`storeMgr-${suffix}`, itemId, locA).expect(201);
    // ...but only for their assigned location.
    await getChecklist(`storeMgr-${suffix}`, locB).expect(403);
  });

  // ---- Complete behaviour (11-15) --------------------------------

  it('Complete records the actor and a timestamp (11)', async () => {
    const checklist = (
      await getChecklist(`fullLocA-${suffix}`, locA).expect(200)
    ).body as OpeningChecklistResponse;
    const itemId = allItemIds(checklist)[0];

    const res = await completeItem(`fullLocA-${suffix}`, itemId, locA).expect(
      201,
    );
    const body = res.body as OpeningChecklistResponse;
    const item = body.sections
      .flatMap((s) => s.items)
      .find((i) => i.id === itemId)!;
    expect(item.completed).toBe(true);
    expect(item.completedBy).toEqual({ name: `fullLocA-${suffix}` });
    expect(typeof item.completedAt).toBe('string');

    const row = await prisma.checklistInstanceItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    const actor = await prisma.internalUser.findFirstOrThrow({
      where: { externalSubject: `internal-dev:fullLocA-${suffix}` },
    });
    expect(row.completedByInternalUserId).toBe(actor.id);
    expect(row.completedAt).not.toBeNull();
  });

  it('Complete increments progress (12)', async () => {
    const checklist = (
      await getChecklist(`fullCorp-${suffix}`, locA).expect(200)
    ).body as OpeningChecklistResponse;
    const [a, b] = allItemIds(checklist);

    const afterOne = (
      await completeItem(`fullCorp-${suffix}`, a, locA).expect(201)
    ).body as OpeningChecklistResponse;
    expect(afterOne.progress.completed).toBe(1);

    const afterTwo = (
      await completeItem(`fullCorp-${suffix}`, b, locA).expect(201)
    ).body as OpeningChecklistResponse;
    expect(afterTwo.progress.completed).toBe(2);
    expect(afterTwo.progress.isComplete).toBe(false);
  });

  it('Complete is idempotent (13)', async () => {
    const checklist = (
      await getChecklist(`fullCorp-${suffix}`, locA).expect(200)
    ).body as OpeningChecklistResponse;
    const itemId = allItemIds(checklist)[0];

    const first = (
      await completeItem(`fullCorp-${suffix}`, itemId, locA).expect(201)
    ).body as OpeningChecklistResponse;
    const firstAt = first.sections
      .flatMap((s) => s.items)
      .find((i) => i.id === itemId)!.completedAt;

    // A different actor re-completes — a no-op; original actor/time kept.
    const second = (
      await completeItem(`fullLocA-${suffix}`, itemId, locA).expect(201)
    ).body as OpeningChecklistResponse;
    const secondItem = second.sections
      .flatMap((s) => s.items)
      .find((i) => i.id === itemId)!;
    expect(secondItem.completedAt).toBe(firstAt);
    expect(secondItem.completedBy).toEqual({ name: `fullCorp-${suffix}` });
    expect(second.progress.completed).toBe(1);
  });

  it('concurrent Complete does not corrupt state (14)', async () => {
    const checklist = (
      await getChecklist(`fullCorp-${suffix}`, locA).expect(200)
    ).body as OpeningChecklistResponse;
    const itemId = allItemIds(checklist)[0];

    const results = await Promise.all([
      completeItem(`fullCorp-${suffix}`, itemId, locA),
      completeItem(`fullLocA-${suffix}`, itemId, locA),
      completeItem(`fullCorp-${suffix}`, itemId, locA),
    ]);
    for (const r of results) expect(r.status).toBe(201);

    const row = await prisma.checklistInstanceItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    // actor + timestamp are either both set or both null — here, both set.
    expect(row.completedAt).not.toBeNull();
    expect(row.completedByInternalUserId).not.toBeNull();

    const completedCount = await prisma.checklistInstanceItem.count({
      where: { checklistInstanceId: row.checklistInstanceId, completedAt: { not: null } },
    });
    expect(completedCount).toBe(1);
  });

  it('final completion sets ChecklistInstance.completedAt (15)', async () => {
    const checklist = (
      await getChecklist(`fullCorp-${suffix}`, locA).expect(200)
    ).body as OpeningChecklistResponse;
    const ids = allItemIds(checklist);

    let last: OpeningChecklistResponse | undefined;
    for (const id of ids) {
      last = (await completeItem(`fullCorp-${suffix}`, id, locA).expect(201))
        .body as OpeningChecklistResponse;
    }
    expect(last!.progress.isComplete).toBe(true);
    expect(last!.progress.completed).toBe(23);

    const instance = await prisma.checklistInstance.findFirstOrThrow({
      where: { locationId: locA },
    });
    expect(instance.completedAt).not.toBeNull();
  });

  // ---- Undo behaviour (16-19) -----------------------------------

  it('Undo clears the item actor and timestamp (16)', async () => {
    const checklist = (
      await getChecklist(`fullCorp-${suffix}`, locA).expect(200)
    ).body as OpeningChecklistResponse;
    const itemId = allItemIds(checklist)[0];

    await completeItem(`fullCorp-${suffix}`, itemId, locA).expect(201);
    const res = (
      await undoItem(`fullCorp-${suffix}`, itemId, locA).expect(201)
    ).body as OpeningChecklistResponse;

    const item = res.sections.flatMap((s) => s.items).find((i) => i.id === itemId)!;
    expect(item.completed).toBe(false);
    expect(item.completedBy).toBeNull();
    expect(item.completedAt).toBeNull();

    const row = await prisma.checklistInstanceItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    expect(row.completedAt).toBeNull();
    expect(row.completedByInternalUserId).toBeNull();
  });

  it('Undo decrements progress (17)', async () => {
    const checklist = (
      await getChecklist(`fullCorp-${suffix}`, locA).expect(200)
    ).body as OpeningChecklistResponse;
    const [a, b] = allItemIds(checklist);

    await completeItem(`fullCorp-${suffix}`, a, locA).expect(201);
    const two = (
      await completeItem(`fullCorp-${suffix}`, b, locA).expect(201)
    ).body as OpeningChecklistResponse;
    expect(two.progress.completed).toBe(2);

    const undone = (
      await undoItem(`fullCorp-${suffix}`, a, locA).expect(201)
    ).body as OpeningChecklistResponse;
    expect(undone.progress.completed).toBe(1);
  });

  it('Undo clears ChecklistInstance.completedAt when the checklist becomes incomplete (18)', async () => {
    const checklist = (
      await getChecklist(`fullCorp-${suffix}`, locA).expect(200)
    ).body as OpeningChecklistResponse;
    const ids = allItemIds(checklist);
    for (const id of ids) {
      await completeItem(`fullCorp-${suffix}`, id, locA).expect(201);
    }
    let instance = await prisma.checklistInstance.findFirstOrThrow({
      where: { locationId: locA },
    });
    expect(instance.completedAt).not.toBeNull();

    const res = (
      await undoItem(`fullCorp-${suffix}`, ids[0], locA).expect(201)
    ).body as OpeningChecklistResponse;
    expect(res.progress.isComplete).toBe(false);

    instance = await prisma.checklistInstance.findFirstOrThrow({
      where: { locationId: locA },
    });
    expect(instance.completedAt).toBeNull();
  });

  it('Undo is idempotent (19)', async () => {
    const checklist = (
      await getChecklist(`fullCorp-${suffix}`, locA).expect(200)
    ).body as OpeningChecklistResponse;
    const itemId = allItemIds(checklist)[0];

    // Undo on an already-incomplete item — a no-op.
    const first = (
      await undoItem(`fullCorp-${suffix}`, itemId, locA).expect(201)
    ).body as OpeningChecklistResponse;
    expect(first.progress.completed).toBe(0);

    await completeItem(`fullCorp-${suffix}`, itemId, locA).expect(201);
    await undoItem(`fullCorp-${suffix}`, itemId, locA).expect(201);
    const third = (
      await undoItem(`fullCorp-${suffix}`, itemId, locA).expect(201)
    ).body as OpeningChecklistResponse;
    expect(third.progress.completed).toBe(0);
  });

  // ---- Audit + projection (23, 24) -----------------------------

  it('routine Complete / Undo create no InternalAuditEvent (23)', async () => {
    const before = await prisma.internalAuditEvent.count();
    const checklist = (
      await getChecklist(`fullCorp-${suffix}`, locA).expect(200)
    ).body as OpeningChecklistResponse;
    const [a, b] = allItemIds(checklist);
    await completeItem(`fullCorp-${suffix}`, a, locA).expect(201);
    await completeItem(`fullCorp-${suffix}`, b, locA).expect(201);
    await undoItem(`fullCorp-${suffix}`, a, locA).expect(201);
    expect(await prisma.internalAuditEvent.count()).toBe(before);
  });

  it('the projection exposes only intended business-facing fields (24)', async () => {
    const res = await getChecklist(`fullCorp-${suffix}`, locA).expect(200);
    const body = res.body as OpeningChecklistResponse;

    expect(Object.keys(body).sort()).toEqual(
      ['businessDate', 'locationId', 'locationName', 'progress', 'sections', 'title'].sort(),
    );
    expect(Object.keys(body.progress).sort()).toEqual(
      ['completed', 'isComplete', 'total'].sort(),
    );
    for (const section of body.sections) {
      expect(Object.keys(section).sort()).toEqual(['items', 'name'].sort());
      for (const item of section.items) {
        expect(Object.keys(item).sort()).toEqual(
          ['completed', 'completedAt', 'completedBy', 'id', 'label'].sort(),
        );
      }
    }

    const raw = JSON.stringify(body);
    const templateId = await openingTemplateId();
    for (const forbidden of [
      templateId,
      'templateId',
      'permissionKey',
      'operations.',
      'internalUserId',
      'externalSubject',
      'checklistInstanceId',
      'sortOrder',
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  // ---- Permission catalog regression --------------------------

  it('operations.tasks.complete exists, allows CORPORATE and LOCATION, and Store Manager has it', async () => {
    const sm = await prisma.internalRole.findUniqueOrThrow({
      where: { key: 'store-manager' },
      include: { permissions: true },
    });
    expect(sm.permissions.map((p) => p.permissionKey)).toContain(
      'operations.tasks.complete',
    );

    const pa = await prisma.internalRole.findUniqueOrThrow({
      where: { key: 'platform-administrator' },
      include: { permissions: true },
    });
    expect(pa.permissions.map((p) => p.permissionKey)).toContain(
      'operations.tasks.complete',
    );

    // LOCATION grant works (fullLocA acted at locA above); CORPORATE works
    // (fullCorp acted throughout). A CORPORATE-only permission held only via
    // LOCATION is the case proven in permission-catalog.spec — not repeated.
  });
});
