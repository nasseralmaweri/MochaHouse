import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  OpeningChecklistResponse,
  OpeningChecklistTemplateConfigResponse,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { OperationsModule } from './operations.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';

type Status = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
type Scope = { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null };

// Admin → Operations → Opening Checklist → Configuration (Milestone 6B-2),
// over real local Postgres. Authentication / lifecycle enforcement is
// proven in internal-authorization.spec — this covers the HQ configuration
// workflow: permission + corporate scope, item/section editing, ordering,
// and — most importantly — that configuration never rewrites a checklist a
// location has already created.
//
// These tests mutate the SHARED seeded `opening` template. `beforeAll`
// snapshots it and `afterEach` restores it exactly (including sortOrder),
// so the 6B execution spec's 23-item assumptions are untouched.
describe('Opening Checklist configuration (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'checklist-config-spec-internal-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const locationIds: string[] = [];
  const roles: Record<string, string> = {};

  let templateId: string;
  let snapshot: {
    id: string;
    section: string;
    label: string;
    sortOrder: number;
    isActive: boolean;
  }[] = [];

  let locInstanceA: string;
  let locInstanceB: string;

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

  async function makeRole(
    displayName: string,
    permissionKeys: string[],
  ): Promise<string> {
    const role = await prisma.internalRole.create({
      data: {
        key: `cfg-spec-${suffix}-${randomUUID()}`,
        displayName,
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
        name: `Config Spec Loc ${randomUUID()}`,
        slug: `config-loc-${randomUUID()}`,
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
    const roleId = await makeRole(key, permissionKeys);
    roles[key] = roleId;
    const userId = await makeUser(`${key}-${suffix}`);
    await assign(userId, roleId, scope);
  }

  const getConfig = (key: string) =>
    request(app.getHttpServer())
      .get('/api/v1/admin/operations/opening-checklist/template')
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`);

  const patchItem = (key: string, itemId: string, body: unknown) =>
    request(app.getHttpServer())
      .patch(
        `/api/v1/admin/operations/opening-checklist/template/items/${itemId}`,
      )
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  const addItem = (key: string, body: unknown) =>
    request(app.getHttpServer())
      .post('/api/v1/admin/operations/opening-checklist/template/items')
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  const moveItem = (key: string, itemId: string, body: unknown) =>
    request(app.getHttpServer())
      .post(
        `/api/v1/admin/operations/opening-checklist/template/items/${itemId}/move`,
      )
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  const renameSection = (key: string, body: unknown) =>
    request(app.getHttpServer())
      .post(
        '/api/v1/admin/operations/opening-checklist/template/sections/rename',
      )
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  const moveSection = (key: string, body: unknown) =>
    request(app.getHttpServer())
      .post('/api/v1/admin/operations/opening-checklist/template/sections/move')
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  const getInstance = (key: string, locationId: string) =>
    request(app.getHttpServer())
      .get(
        `/api/v1/admin/operations/opening-checklist?locationId=${encodeURIComponent(
          locationId,
        )}`,
      )
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`);

  const completeInstanceItem = (
    key: string,
    itemId: string,
    locationId: string,
  ) =>
    request(app.getHttpServer())
      .post(
        `/api/v1/admin/operations/opening-checklist/items/${itemId}/complete`,
      )
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send({ locationId });

  function allLabels(config: OpeningChecklistTemplateConfigResponse): string[] {
    return config.sections.flatMap((s) => s.items.map((i) => i.label));
  }

  async function firstItemOf(section: string): Promise<string> {
    const item = await prisma.checklistTemplateItem.findFirstOrThrow({
      where: { templateId, section },
      orderBy: { sortOrder: 'asc' },
    });
    return item.id;
  }

  async function restoreTemplate(): Promise<void> {
    const ids = snapshot.map((s) => s.id);
    await prisma.checklistTemplateItem.deleteMany({
      where: { templateId, id: { notIn: ids } },
    });
    for (const original of snapshot) {
      await prisma.checklistTemplateItem.update({
        where: { id: original.id },
        data: {
          section: original.section,
          label: original.label,
          sortOrder: original.sortOrder,
          isActive: original.isActive,
        },
      });
    }
  }

  async function clearTestInstances(): Promise<void> {
    await prisma.checklistInstanceItem.deleteMany({
      where: {
        checklistInstance: { locationId: { in: [locInstanceA, locInstanceB] } },
      },
    });
    await prisma.checklistInstance.deleteMany({
      where: { locationId: { in: [locInstanceA, locInstanceB] } },
    });
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'checklist-config-spec-customer-secret';

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

    const template = await prisma.checklistTemplate.findUniqueOrThrow({
      where: { key: 'opening' },
    });
    templateId = template.id;
    snapshot = (
      await prisma.checklistTemplateItem.findMany({
        where: { templateId },
        orderBy: { sortOrder: 'asc' },
      })
    ).map((i) => ({
      id: i.id,
      section: i.section,
      label: i.label,
      sortOrder: i.sortOrder,
      isActive: i.isActive,
    }));

    locInstanceA = await makeLocation();
    locInstanceB = await makeLocation();

    await makeUserWithRole('cfgCorp', ['operations.checklists.configure'], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    // A LOCATION-scoped grant of a CORPORATE-only permission — PermissionGuard
    // must reject it.
    const locForCfg = await makeLocation();
    await makeUserWithRole('cfgLoc', ['operations.checklists.configure'], {
      scopeType: 'LOCATION',
      scopeId: locForCfg,
    });
    await makeUserWithRole('viewCorp', ['operations.view'], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await makeUserWithRole('execCorp', ['operations.tasks.complete'], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await makeUserWithRole(
      'opsCorp',
      ['operations.view', 'operations.tasks.complete'],
      { scopeType: 'CORPORATE', scopeId: null },
    );
    await makeUser(`noPerm-${suffix}`);

    // A Store Manager (the seeded built-in role) — proves the seed does NOT
    // grant checklist configuration.
    const storeManager = await prisma.internalRole.findUniqueOrThrow({
      where: { key: 'store-manager' },
    });
    const storeMgrUser = await makeUser(`storeMgr-${suffix}`);
    await assign(storeMgrUser, storeManager.id, {
      scopeType: 'LOCATION',
      scopeId: locInstanceA,
    });
  }, 45_000);

  afterEach(async () => {
    await restoreTemplate();
    await clearTestInstances();
  });

  afterAll(async () => {
    await restoreTemplate();
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

  // ---- Authorization / scope --------------------------------------

  it('GET requires operations.checklists.configure', async () => {
    await getConfig('noPerm').expect(403);
    await getConfig('viewCorp').expect(403);
    await getConfig('execCorp').expect(403);
  });

  it('a LOCATION-scoped grant of the configure permission is rejected (corporate-only)', async () => {
    await getConfig('cfgLoc').expect(403);
    const itemId = await firstItemOf('Equipment');
    await patchItem('cfgLoc', itemId, { label: 'nope' }).expect(403);
    await addItem('cfgLoc', { section: 'Equipment', label: 'nope' }).expect(
      403,
    );
  });

  it('a Store Manager cannot configure the corporate checklist', async () => {
    await getConfig('storeMgr').expect(403);
    const itemId = await firstItemOf('Equipment');
    await patchItem('storeMgr', itemId, { isActive: false }).expect(403);
  });

  it('configuration permission does not grant checklist execution', async () => {
    // cfgCorp holds only operations.checklists.configure.
    await getInstance('cfgCorp', locInstanceA).expect(403);
  });

  it('execution permission does not grant configuration', async () => {
    await getConfig('opsCorp').expect(403);
  });

  // ---- GET projection --------------------------------------------

  it('GET returns every section and item, active and inactive, in order', async () => {
    const itemId = await firstItemOf('Equipment');
    await patchItem('cfgCorp', itemId, { isActive: false }).expect(200);

    const res = await getConfig('cfgCorp').expect(200);
    const body = res.body as OpeningChecklistTemplateConfigResponse;

    expect(body.title).toBe('Opening Checklist');
    expect(body.sections.map((s) => s.name)).toEqual([
      'Building & Security',
      'Equipment',
      'Coffee & Beverage Preparation',
      'Food Preparation & Stocking',
      'Cash & POS',
      'Final Readiness',
    ]);
    expect(allLabels(body)).toHaveLength(23);
    const equipment = body.sections.find((s) => s.name === 'Equipment')!;
    expect(equipment.items[0].isActive).toBe(false);
    expect(equipment.items.some((i) => i.isActive)).toBe(true);

    // Move affordances at the boundaries.
    expect(body.sections[0].canMoveUp).toBe(false);
    expect(body.sections[body.sections.length - 1].canMoveDown).toBe(false);
    expect(equipment.items[0].canMoveUp).toBe(false);
    expect(equipment.items[equipment.items.length - 1].canMoveDown).toBe(false);
  });

  // ---- Item wording ---------------------------------------------

  it('edits item wording (trimmed) and reflects it on GET', async () => {
    const itemId = await firstItemOf('Cash & POS');
    const res = await patchItem('cfgCorp', itemId, {
      label: '  Count the opening float carefully.  ',
    }).expect(200);
    const body = res.body as OpeningChecklistTemplateConfigResponse;
    expect(allLabels(body)).toContain('Count the opening float carefully.');

    const stored = await prisma.checklistTemplateItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    expect(stored.label).toBe('Count the opening float carefully.');
  });

  it('rejects blank item wording', async () => {
    const itemId = await firstItemOf('Cash & POS');
    await patchItem('cfgCorp', itemId, { label: '   ' }).expect(400);
    await patchItem('cfgCorp', itemId, {}).expect(400);
  });

  it('unknown item id is a 404', async () => {
    await patchItem('cfgCorp', randomUUID(), { label: 'x' }).expect(404);
    await moveItem('cfgCorp', randomUUID(), { direction: 'up' }).expect(404);
  });

  // ---- Active / inactive --------------------------------------

  it('toggles an item Active -> Inactive -> Active', async () => {
    const itemId = await firstItemOf('Final Readiness');

    const off = (
      await patchItem('cfgCorp', itemId, { isActive: false }).expect(200)
    ).body as OpeningChecklistTemplateConfigResponse;
    expect(
      off.sections.flatMap((s) => s.items).find((i) => i.id === itemId)
        ?.isActive,
    ).toBe(false);

    const on = (
      await patchItem('cfgCorp', itemId, { isActive: true }).expect(200)
    ).body as OpeningChecklistTemplateConfigResponse;
    expect(
      on.sections.flatMap((s) => s.items).find((i) => i.id === itemId)
        ?.isActive,
    ).toBe(true);
  });

  it('inactive items are excluded from a newly created instance', async () => {
    const target = await prisma.checklistTemplateItem.findFirstOrThrow({
      where: { templateId, label: 'Fill ice bins.' },
    });
    await patchItem('cfgCorp', target.id, { isActive: false }).expect(200);

    const body = (await getInstance('opsCorp', locInstanceA).expect(200))
      .body as OpeningChecklistResponse;
    expect(body.progress.total).toBe(22);
    expect(
      body.sections.flatMap((s) => s.items.map((i) => i.label)),
    ).not.toContain('Fill ice bins.');
  });

  // ---- Add item / create section -----------------------------

  it('adds an item to the end of an existing section, Active by default', async () => {
    const res = await addItem('cfgCorp', {
      section: 'Equipment',
      label: 'Check the water filter indicator.',
    }).expect(201);
    const body = res.body as OpeningChecklistTemplateConfigResponse;
    const equipment = body.sections.find((s) => s.name === 'Equipment')!;
    expect(equipment.items[equipment.items.length - 1].label).toBe(
      'Check the water filter indicator.',
    );
    expect(equipment.items[equipment.items.length - 1].isActive).toBe(true);
    // Section order is unchanged; nothing leaked past Equipment.
    expect(body.sections.map((s) => s.name)).toEqual([
      'Building & Security',
      'Equipment',
      'Coffee & Beverage Preparation',
      'Food Preparation & Stocking',
      'Cash & POS',
      'Final Readiness',
    ]);
  });

  it('adds an item under a brand-new section, appended last', async () => {
    const res = await addItem('cfgCorp', {
      section: 'Team Huddle',
      label: 'Brief the team on the daily specials.',
    }).expect(201);
    const body = res.body as OpeningChecklistTemplateConfigResponse;
    expect(body.sections[body.sections.length - 1].name).toBe('Team Huddle');
    expect(body.sections[body.sections.length - 1].items).toHaveLength(1);
  });

  it('reuses an existing section when the name differs only by case/whitespace', async () => {
    await addItem('cfgCorp', {
      section: '  equipment ',
      label: 'Wipe down the steam wands.',
    }).expect(201);
    const body = (await getConfig('cfgCorp').expect(200))
      .body as OpeningChecklistTemplateConfigResponse;
    expect(body.sections.filter((s) => s.name === 'Equipment')).toHaveLength(1);
    expect(body.sections.map((s) => s.name)).not.toContain('  equipment ');
    const equipment = body.sections.find((s) => s.name === 'Equipment')!;
    expect(
      equipment.items.some((i) => i.label === 'Wipe down the steam wands.'),
    ).toBe(true);
  });

  it('rejects a blank section name on add', async () => {
    await addItem('cfgCorp', { section: '  ', label: 'x' }).expect(400);
    await addItem('cfgCorp', { section: 'Equipment', label: '  ' }).expect(400);
  });

  // ---- Section rename ----------------------------------------

  it('renames a section, moving all its items, order preserved', async () => {
    const before = (await getConfig('cfgCorp').expect(200))
      .body as OpeningChecklistTemplateConfigResponse;
    const equipmentLabels = before.sections
      .find((s) => s.name === 'Equipment')!
      .items.map((i) => i.label);

    const res = await renameSection('cfgCorp', {
      from: 'Equipment',
      to: 'Equipment & Machines',
    }).expect(201);
    const body = res.body as OpeningChecklistTemplateConfigResponse;
    expect(body.sections.map((s) => s.name)).toEqual([
      'Building & Security',
      'Equipment & Machines',
      'Coffee & Beverage Preparation',
      'Food Preparation & Stocking',
      'Cash & POS',
      'Final Readiness',
    ]);
    expect(
      body.sections
        .find((s) => s.name === 'Equipment & Machines')!
        .items.map((i) => i.label),
    ).toEqual(equipmentLabels);
  });

  it('rejects a rename that would collide with another section', async () => {
    await renameSection('cfgCorp', {
      from: 'Equipment',
      to: '  cash & pos ',
    }).expect(400);
  });

  it('rejects a blank rename target and an unknown source section', async () => {
    await renameSection('cfgCorp', { from: 'Equipment', to: '   ' }).expect(
      400,
    );
    await renameSection('cfgCorp', { from: 'Nope', to: 'Whatever' }).expect(
      404,
    );
  });

  it('a section rename never rewrites an already-created instance', async () => {
    const instance = (await getInstance('opsCorp', locInstanceA).expect(200))
      .body as OpeningChecklistResponse;
    const sectionsBefore = instance.sections.map((s) => s.name);
    expect(sectionsBefore).toContain('Equipment');

    await renameSection('cfgCorp', {
      from: 'Equipment',
      to: 'Machines',
    }).expect(201);

    const after = (await getInstance('opsCorp', locInstanceA).expect(200))
      .body as OpeningChecklistResponse;
    expect(after.sections.map((s) => s.name)).toEqual(sectionsBefore);

    const rows = await prisma.checklistInstanceItem.findMany({
      where: { checklistInstance: { locationId: locInstanceA } },
      select: { section: true },
      distinct: ['section'],
    });
    expect(rows.map((r) => r.section)).toContain('Equipment');
    expect(rows.map((r) => r.section)).not.toContain('Machines');
  });

  // ---- Item reorder within a section ------------------------

  it('moves an item up and down within its section', async () => {
    const before = (await getConfig('cfgCorp').expect(200))
      .body as OpeningChecklistTemplateConfigResponse;
    const security = before.sections.find(
      (s) => s.name === 'Building & Security',
    )!;
    const first = security.items[0];
    const second = security.items[1];

    const down = (
      await moveItem('cfgCorp', first.id, { direction: 'down' }).expect(201)
    ).body as OpeningChecklistTemplateConfigResponse;
    const securityAfter = down.sections.find(
      (s) => s.name === 'Building & Security',
    )!;
    expect(securityAfter.items[0].id).toBe(second.id);
    expect(securityAfter.items[1].id).toBe(first.id);

    const up = (
      await moveItem('cfgCorp', first.id, { direction: 'up' }).expect(201)
    ).body as OpeningChecklistTemplateConfigResponse;
    expect(
      up.sections.find((s) => s.name === 'Building & Security')!.items[0].id,
    ).toBe(first.id);
  });

  it('rejects moving the first item up or the last item down within a section', async () => {
    const config = (await getConfig('cfgCorp').expect(200))
      .body as OpeningChecklistTemplateConfigResponse;
    const security = config.sections.find(
      (s) => s.name === 'Building & Security',
    )!;
    await moveItem('cfgCorp', security.items[0].id, {
      direction: 'up',
    }).expect(400);
    await moveItem('cfgCorp', security.items[security.items.length - 1].id, {
      direction: 'down',
    }).expect(400);
  });

  it('rejects an invalid move direction', async () => {
    const itemId = await firstItemOf('Equipment');
    await moveItem('cfgCorp', itemId, { direction: 'sideways' }).expect(400);
  });

  // ---- Section reorder -------------------------------------

  it('moves a section up and down', async () => {
    const down = (
      await moveSection('cfgCorp', {
        section: 'Building & Security',
        direction: 'down',
      }).expect(201)
    ).body as OpeningChecklistTemplateConfigResponse;
    expect(down.sections.map((s) => s.name)).toEqual([
      'Equipment',
      'Building & Security',
      'Coffee & Beverage Preparation',
      'Food Preparation & Stocking',
      'Cash & POS',
      'Final Readiness',
    ]);

    const up = (
      await moveSection('cfgCorp', {
        section: 'Building & Security',
        direction: 'up',
      }).expect(201)
    ).body as OpeningChecklistTemplateConfigResponse;
    expect(up.sections[0].name).toBe('Building & Security');
  });

  it('rejects moving the first section up or the last section down', async () => {
    await moveSection('cfgCorp', {
      section: 'Building & Security',
      direction: 'up',
    }).expect(400);
    await moveSection('cfgCorp', {
      section: 'Final Readiness',
      direction: 'down',
    }).expect(400);
  });

  // ---- Deterministic ordering into new instances -----------

  it('a new instance lists sections and items in the HQ-defined order', async () => {
    await moveSection('cfgCorp', {
      section: 'Final Readiness',
      direction: 'up',
    }).expect(201);
    const second = await prisma.checklistTemplateItem.findFirstOrThrow({
      where: { templateId, section: 'Equipment' },
      orderBy: { sortOrder: 'asc' },
      skip: 1,
    });
    await moveItem('cfgCorp', second.id, { direction: 'up' }).expect(201);

    const config = (await getConfig('cfgCorp').expect(200))
      .body as OpeningChecklistTemplateConfigResponse;
    const instance = (await getInstance('opsCorp', locInstanceB).expect(200))
      .body as OpeningChecklistResponse;

    expect(instance.sections.map((s) => s.name)).toEqual(
      config.sections.map((s) => s.name),
    );
    expect(
      instance.sections.flatMap((s) => s.items.map((i) => i.label)),
    ).toEqual(config.sections.flatMap((s) => s.items.map((i) => i.label)));
  });

  it('a new instance reflects the latest wording and additions', async () => {
    const itemId = await firstItemOf('Coffee & Beverage Preparation');
    await patchItem('cfgCorp', itemId, {
      label: 'Brew the first pot of drip coffee.',
    }).expect(200);
    await addItem('cfgCorp', {
      section: 'Coffee & Beverage Preparation',
      label: 'Taste the espresso and adjust the grind.',
    }).expect(201);

    const instance = (await getInstance('opsCorp', locInstanceA).expect(200))
      .body as OpeningChecklistResponse;
    const labels = instance.sections.flatMap((s) =>
      s.items.map((i) => i.label),
    );
    expect(labels).toContain('Brew the first pot of drip coffee.');
    expect(labels).toContain('Taste the espresso and adjust the grind.');
    expect(instance.progress.total).toBe(24);
  });

  // ---- Historical-instance preservation --------------------

  it('template edits after an instance exists never change that instance', async () => {
    const before = (await getInstance('opsCorp', locInstanceA).expect(200))
      .body as OpeningChecklistResponse;
    const labelsBefore = before.sections.flatMap((s) =>
      s.items.map((i) => i.label),
    );
    const sectionsBefore = before.sections.map((s) => s.name);

    // Complete one item so we can prove completion state survives too.
    const firstItemId = before.sections[0].items[0].id;
    await completeInstanceItem('opsCorp', firstItemId, locInstanceA).expect(
      201,
    );

    // A broad set of configuration changes.
    const equip = await firstItemOf('Equipment');
    await patchItem('cfgCorp', equip, {
      label: 'REWORDED',
      isActive: false,
    }).expect(200);
    await addItem('cfgCorp', {
      section: 'Equipment',
      label: 'A brand new item.',
    }).expect(201);
    await moveItem('cfgCorp', await firstItemOf('Cash & POS'), {
      direction: 'down',
    }).expect(201);
    await moveSection('cfgCorp', {
      section: 'Equipment',
      direction: 'up',
    }).expect(201);
    await renameSection('cfgCorp', {
      from: 'Final Readiness',
      to: 'Wrap Up',
    }).expect(201);

    const after = (await getInstance('opsCorp', locInstanceA).expect(200))
      .body as OpeningChecklistResponse;
    expect(after.sections.map((s) => s.name)).toEqual(sectionsBefore);
    expect(after.sections.flatMap((s) => s.items.map((i) => i.label))).toEqual(
      labelsBefore,
    );
    expect(after.progress.total).toBe(23);
    expect(after.sections[0].items[0].completed).toBe(true);
  });

  // ---- Audit --------------------------------------------

  it('configuration writes create no InternalAuditEvent', async () => {
    const before = await prisma.internalAuditEvent.count();

    const itemId = await firstItemOf('Equipment');
    await patchItem('cfgCorp', itemId, { label: 'Audited? no.' }).expect(200);
    await patchItem('cfgCorp', itemId, { isActive: false }).expect(200);
    await addItem('cfgCorp', { section: 'Equipment', label: 'x' }).expect(201);
    await moveItem('cfgCorp', await firstItemOf('Cash & POS'), {
      direction: 'down',
    }).expect(201);
    await moveSection('cfgCorp', {
      section: 'Equipment',
      direction: 'up',
    }).expect(201);
    await renameSection('cfgCorp', {
      from: 'Cash & POS',
      to: 'Register',
    }).expect(201);

    const after = await prisma.internalAuditEvent.count();
    expect(after).toBe(before);
  });
});
