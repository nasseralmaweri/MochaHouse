import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { OpeningChecklistTemplateConfigResponse } from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { OperationsModule } from './operations.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';

type Scope = { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null };

// HQ configuration of the Closing Checklist (Milestone 6D). The config
// service is shared with the Opening Checklist (6B-2 tests it exhaustively),
// so this spec proves the CLOSING wiring: the same
// `operations.checklists.configure` permission, the seeded 14-item
// standard, and — crucially — that configuring one checklist never touches
// the other.
describe('Closing Checklist configuration (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'closing-config-spec-internal-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];

  let closingTemplateId: string;
  let snapshot: {
    id: string;
    section: string;
    label: string;
    sortOrder: number;
    isActive: boolean;
  }[] = [];

  const token = (key: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${key}`, email: `${key}@example.com`, name: null },
      internalSecret,
      3600,
    );

  async function makeUser(key: string): Promise<string> {
    const user = await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${key}`,
        email: `${key}@example.com`,
        displayName: key,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function makeUserWithRole(
    key: string,
    permissionKeys: string[],
    scope: Scope,
  ): Promise<void> {
    const role = await prisma.internalRole.create({
      data: {
        key: `closing-cfg-${suffix}-${randomUUID()}`,
        displayName: 'Closing Cfg Role',
        permissions: {
          create: permissionKeys.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    roleIds.push(role.id);
    const userId = await makeUser(`${key}-${suffix}`);
    await prisma.internalUserRoleAssignment.create({
      data: { internalUserId: userId, roleId: role.id, ...scope },
    });
  }

  const cfg = (kind: 'closing' | 'opening') =>
    `/api/v1/admin/operations/${kind}-checklist/template`;

  const getConfig = (key: string, kind: 'closing' | 'opening' = 'closing') =>
    request(app.getHttpServer())
      .get(cfg(kind))
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`);

  const patchItem = (key: string, itemId: string, body: unknown) =>
    request(app.getHttpServer())
      .patch(`${cfg('closing')}/items/${itemId}`)
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  const addItem = (key: string, body: unknown) =>
    request(app.getHttpServer())
      .post(`${cfg('closing')}/items`)
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  const moveSection = (key: string, body: unknown) =>
    request(app.getHttpServer())
      .post(`${cfg('closing')}/sections/move`)
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  const renameSection = (key: string, body: unknown) =>
    request(app.getHttpServer())
      .post(`${cfg('closing')}/sections/rename`)
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  async function restoreTemplate(): Promise<void> {
    await prisma.checklistTemplateItem.deleteMany({
      where: {
        templateId: closingTemplateId,
        id: { notIn: snapshot.map((s) => s.id) },
      },
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

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'closing-config-spec-customer-secret';

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
      where: { key: 'closing' },
    });
    closingTemplateId = template.id;
    snapshot = (
      await prisma.checklistTemplateItem.findMany({
        where: { templateId: closingTemplateId },
        orderBy: { sortOrder: 'asc' },
      })
    ).map((i) => ({
      id: i.id,
      section: i.section,
      label: i.label,
      sortOrder: i.sortOrder,
      isActive: i.isActive,
    }));

    await makeUserWithRole('cfgCorp', ['operations.checklists.configure'], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await makeUserWithRole('viewCorp', ['operations.view'], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await makeUser(`noPerm-${suffix}`);

    const storeManager = await prisma.internalRole.findUniqueOrThrow({
      where: { key: 'store-manager' },
    });
    const sm = await makeUser(`storeMgr-${suffix}`);
    await prisma.internalUserRoleAssignment.create({
      data: {
        internalUserId: sm,
        roleId: storeManager.id,
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });
  }, 45_000);

  afterEach(restoreTemplate);

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
    await app.close();
    process.env = { ...originalEnv };
  });

  it('requires operations.checklists.configure (corporate-only)', async () => {
    await getConfig('noPerm').expect(403);
    await getConfig('viewCorp').expect(403);
    // Store Manager holds the permission only via LOCATION scope in the
    // real seed → but this spec assigned it at CORPORATE. A LOCATION grant
    // of a corporate-only key is proven in permission-catalog.spec.
  });

  it('GET returns the seeded 14 Closing items in section order', async () => {
    const body = (await getConfig('cfgCorp').expect(200))
      .body as OpeningChecklistTemplateConfigResponse;
    expect(body.title).toBe('Closing Checklist');
    expect(body.sections.map((s) => s.name)).toEqual([
      'End-of-Shift & Cleaning',
      'Cash Handling & Security',
      'Building & Final Close',
    ]);
    expect(body.sections.flatMap((s) => s.items)).toHaveLength(14);
    expect(body.sections[0].items[0].label).toBe(
      'Properly store all perishable food items using FIFO.',
    );
  });

  it('edits wording, toggles active state, adds an item, renames and reorders sections', async () => {
    const first = await prisma.checklistTemplateItem.findFirstOrThrow({
      where: { templateId: closingTemplateId },
      orderBy: { sortOrder: 'asc' },
    });

    await patchItem('cfgCorp', first.id, {
      label: 'Store all perishables using FIFO and label them.',
    }).expect(200);
    await patchItem('cfgCorp', first.id, { isActive: false }).expect(200);
    await addItem('cfgCorp', {
      section: 'Building & Final Close',
      label: 'Confirm the patio furniture is brought in.',
    }).expect(201);
    await renameSection('cfgCorp', {
      from: 'Building & Final Close',
      to: 'Final Close',
    }).expect(201);

    const body = (
      await moveSection('cfgCorp', {
        section: 'Cash Handling & Security',
        direction: 'up',
      }).expect(201)
    ).body as OpeningChecklistTemplateConfigResponse;

    expect(body.sections.map((s) => s.name)).toEqual([
      'Cash Handling & Security',
      'End-of-Shift & Cleaning',
      'Final Close',
    ]);
    const labels = body.sections.flatMap((s) => s.items.map((i) => i.label));
    expect(labels).toContain(
      'Store all perishables using FIFO and label them.',
    );
    expect(labels).toContain('Confirm the patio furniture is brought in.');
    expect(
      body.sections.flatMap((s) => s.items).find((i) => i.id === first.id)
        ?.isActive,
    ).toBe(false);
  });

  it('configuring the Closing Checklist never touches the Opening Checklist', async () => {
    const openingBefore = (await getConfig('cfgCorp', 'opening').expect(200))
      .body as OpeningChecklistTemplateConfigResponse;

    await renameSection('cfgCorp', {
      from: 'End-of-Shift & Cleaning',
      to: 'Shift Wind-Down',
    }).expect(201);
    const closingFirst = await prisma.checklistTemplateItem.findFirstOrThrow({
      where: { templateId: closingTemplateId },
      orderBy: { sortOrder: 'asc' },
    });
    await patchItem('cfgCorp', closingFirst.id, {
      label: 'CHANGED ON CLOSING ONLY',
    }).expect(200);

    const openingAfter = (await getConfig('cfgCorp', 'opening').expect(200))
      .body as OpeningChecklistTemplateConfigResponse;
    expect(openingAfter).toEqual(openingBefore);
  });

  it('an HQ-configured item cannot be hard-deleted (inactive only)', async () => {
    const first = await prisma.checklistTemplateItem.findFirstOrThrow({
      where: { templateId: closingTemplateId },
      orderBy: { sortOrder: 'asc' },
    });
    // There is no DELETE route on the config controller.
    await request(app.getHttpServer())
      .delete(`${cfg('closing')}/items/${first.id}`)
      .set('Authorization', `Bearer ${token(`cfgCorp-${suffix}`)}`)
      .expect(404);
  });
});
