import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  TENANT_1_MOCHA_HOUSE_ID,
  createTenantContext,
  type TenantContext,
} from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { CatalogModule } from '../catalog/catalog.module';
import { OperationsModule } from '../operations/operations.module';
import { CatalogService } from '../catalog/application/catalog.service';
import { OperationsTasksService } from '../operations/application/operations-tasks.service';
import { ChecklistExecutionService } from '../operations/application/checklist-execution.service';
import { ChecklistTemplateConfigService } from '../operations/application/checklist-template-config.service';
import { AuthorizationContext } from '../internal-auth/authorization/authorization-context';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';

// Milestone S0D-2A — every write in the locations / catalog / pricing /
// store-operations domain persists an explicit tenant that comes from the
// server-resolved TenantContext or a validated parent — never from client
// input — and can structurally belong to test Tenant B when (and only when)
// a server-side TenantContext for Tenant B is supplied.
describe('S0D-2A explicit tenant writes — catalog & store operations (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 's0d2a-tenant-writes-internal-secret';
  const suffix = randomUUID().slice(0, 8);

  const corporate = [{ scopeType: 'CORPORATE' as const, scopeId: null }];
  const authorization = AuthorizationContext.of({
    'operations.view': corporate,
    'operations.tasks.complete': corporate,
    'operations.checklists.configure': corporate,
    'catalog.overrides.manage': corporate,
  });
  const contextFor = (tenantId: string): TenantContext =>
    createTenantContext({
      tenantId,
      principalType: 'system',
      requestId: `s0d2a-${randomUUID()}`,
    });

  // One fully wired catalog + operations fixture per tenant.
  interface TenantFixture {
    tenantId: string;
    locationId: string;
    menuId: string;
    productId: string;
    categoryId: string;
    templateKey: string;
    templateId: string;
    actorId: string;
  }
  let t1: TenantFixture;
  let tb: TenantFixture;
  const roleIds: string[] = [];

  async function makeFixture(
    tenantId: string,
    label: string,
  ): Promise<TenantFixture> {
    const location = await prisma.location.create({
      data: {
        tenantId,
        name: `S0D2A ${label} ${suffix}`,
        slug: `s0d2a-${label}-${suffix}`,
      },
    });
    const category = await prisma.category.create({
      data: {
        tenantId,
        name: `S0D2A ${label}`,
        slug: `s0d2a-cat-${label}-${suffix}`,
      },
    });
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `S0D2A ${label} product`,
        slug: `s0d2a-prod-${label}-${suffix}`,
        basePrice: 400,
        categoryId: category.id,
      },
    });
    const menu = await prisma.menu.create({
      data: {
        tenantId,
        name: `S0D2A ${label} menu`,
        slug: `s0d2a-menu-${label}-${suffix}`,
      },
    });
    await prisma.menuProduct.create({
      data: { tenantId, menuId: menu.id, productId: product.id },
    });
    await prisma.locationMenu.create({
      data: { tenantId, locationId: location.id, menuId: menu.id },
    });
    const templateKey = `s0d2a-${label}-${suffix}`;
    const template = await prisma.checklistTemplate.create({
      data: {
        tenantId,
        key: templateKey,
        name: `S0D2A ${label} checklist`,
        items: {
          create: [
            { tenantId, section: 'Open', label: 'Unlock doors', sortOrder: 1 },
          ],
        },
      },
    });
    const actor = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:s0d2a-${label}-${suffix}@example.com`,
        email: `s0d2a-${label}-${suffix}@example.com`,
        displayName: `S0D2A ${label}`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    return {
      tenantId,
      locationId: location.id,
      menuId: menu.id,
      productId: product.id,
      categoryId: category.id,
      templateKey,
      templateId: template.id,
      actorId: actor.id,
    };
  }

  async function removeFixture(f: TenantFixture) {
    await prisma.operationsTask.deleteMany({
      where: { locationId: f.locationId },
    });
    await prisma.checklistInstance.deleteMany({
      where: { locationId: f.locationId },
    });
    await prisma.locationProductPriceOverride.deleteMany({
      where: { locationId: f.locationId },
    });
    await prisma.locationProductAvailabilityOverride.deleteMany({
      where: { locationId: f.locationId },
    });
    await prisma.locationMenu.deleteMany({
      where: { locationId: f.locationId },
    });
    await prisma.menuProduct.deleteMany({ where: { menuId: f.menuId } });
    await prisma.product.deleteMany({ where: { id: f.productId } });
    await prisma.category.deleteMany({ where: { id: f.categoryId } });
    await prisma.menu.deleteMany({ where: { id: f.menuId } });
    await prisma.checklistTemplate.deleteMany({ where: { id: f.templateId } });
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: f.actorId },
    });
    await prisma.internalUser.deleteMany({ where: { id: f.actorId } });
    await prisma.location.deleteMany({ where: { id: f.locationId } });
  }

  const token = () =>
    signInternalDevJwt(
      {
        sub: `internal-dev:s0d2a-t1-${suffix}@example.com`,
        email: `s0d2a-t1-${suffix}@example.com`,
        name: null,
      },
      internalSecret,
      3600,
    );

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 's0d2a-tenant-writes-customer-secret';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        CatalogModule,
        OperationsModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);

    await createTestTenantB(prisma);
    t1 = await makeFixture(TENANT_1_MOCHA_HOUSE_ID, 't1');
    tb = await makeFixture(TEST_TENANT_B_ID, 'tb');

    // The HTTP caller: a Tenant #1 staff member with CORPORATE scope. Note
    // CORPORATE currently authorizes EVERY location, including Tenant B's
    // (S0F makes it tenant-wide) — the write-path ownership check below is
    // what refuses Tenant B's location.
    const role = await prisma.internalRole.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        key: `s0d2a-role-${suffix}`,
        displayName: 'S0D-2A spec role',
        permissions: {
          create: [
            'operations.view',
            'operations.tasks.complete',
            'catalog.overrides.manage',
          ].map((permissionKey) => ({ permissionKey, tenantId: TENANT_1_MOCHA_HOUSE_ID })),
        },
      },
    });
    roleIds.push(role.id);
    await prisma.internalUserRoleAssignment.create({
      data: {
        internalUserId: t1.actorId,
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        roleId: role.id,
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await removeFixture(t1);
    await removeFixture(tb);
    for (const id of roleIds) {
      await prisma.internalRolePermission.deleteMany({ where: { roleId: id } });
      await prisma.internalRole.deleteMany({ where: { id } });
    }
    // Succeeds only because every Tenant B row above is gone (FK RESTRICT).
    await removeTestTenantB(prisma);
    await app.close();
    process.env = { ...originalEnv };
  });

  // Milestone S0F — on Admin routes X-Tenant-Id is no longer an ignored
  // spoof: it is the validated business-selection header. A Tenant #1-only
  // administrator naming Tenant B there is refused outright (403) and
  // nothing is written; body / query tenant ids are still simply ignored.
  describe('HTTP: clients cannot choose the tenant (the admin operates in their own business, Tenant #1)', () => {
    const spoof = {
      query: { tenantId: TEST_TENANT_B_ID },
      header: TEST_TENANT_B_ID,
    };

    it('an operations task is persisted for Tenant #1 despite Tenant B in body and query; a Tenant B header is refused', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/operations/tasks')
        .query(spoof.query)
        .set('Authorization', `Bearer ${token()}`)
        .send({
          locationId: t1.locationId,
          title: 'Spoof check',
          tenantId: TEST_TENANT_B_ID,
        })
        .expect(201);

      const task = await prisma.operationsTask.findFirstOrThrow({
        where: { locationId: t1.locationId, title: 'Spoof check' },
      });
      expect(task.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);

      await request(app.getHttpServer())
        .post('/api/v1/admin/operations/tasks')
        .set('Authorization', `Bearer ${token()}`)
        .set('x-tenant-id', spoof.header)
        .send({ locationId: t1.locationId, title: 'Header spoof check' })
        .expect(403);
      expect(
        await prisma.operationsTask.count({
          where: { title: 'Header spoof check' },
        }),
      ).toBe(0);
    });

    it('price and availability overrides are persisted for Tenant #1 despite Tenant B in the body', async () => {
      const base = `/api/v1/admin/catalog/locations/${t1.locationId}/menus/${t1.menuId}/products/${t1.productId}`;
      // A Tenant B business selection is refused before anything is written.
      await request(app.getHttpServer())
        .put(`${base}/price-override`)
        .set('Authorization', `Bearer ${token()}`)
        .set('x-tenant-id', spoof.header)
        .send({ price: 1 })
        .expect(403);
      await request(app.getHttpServer())
        .put(`${base}/price-override`)
        .query(spoof.query)
        .set('Authorization', `Bearer ${token()}`)
        .send({ price: 425, tenantId: TEST_TENANT_B_ID })
        .expect(200);
      await request(app.getHttpServer())
        .put(`${base}/availability-override`)
        .set('Authorization', `Bearer ${token()}`)
        .send({ isAvailable: false, tenantId: TEST_TENANT_B_ID })
        .expect(200);

      const where = {
        locationId: t1.locationId,
        menuId: t1.menuId,
        productId: t1.productId,
      };
      expect(
        (await prisma.locationProductPriceOverride.findFirstOrThrow({ where }))
          .tenantId,
      ).toBe(TENANT_1_MOCHA_HOUSE_ID);
      expect(
        (
          await prisma.locationProductAvailabilityOverride.findFirstOrThrow({
            where,
          })
        ).tenantId,
      ).toBe(TENANT_1_MOCHA_HOUSE_ID);
    });

    it("today's checklist instance and its item snapshots are created for Tenant #1 despite Tenant B in the query; a Tenant B header is refused", async () => {
      await request(app.getHttpServer())
        .get('/api/v1/admin/operations/opening-checklist')
        .query({ locationId: t1.locationId })
        .set('Authorization', `Bearer ${token()}`)
        .set('x-tenant-id', spoof.header)
        .expect(403);
      expect(
        await prisma.checklistInstance.count({
          where: { locationId: t1.locationId },
        }),
      ).toBe(0);

      await request(app.getHttpServer())
        .get('/api/v1/admin/operations/opening-checklist')
        .query({ locationId: t1.locationId, ...spoof.query })
        .set('Authorization', `Bearer ${token()}`)
        .expect(200);

      const instance = await prisma.checklistInstance.findFirstOrThrow({
        where: { locationId: t1.locationId },
        include: { items: true },
      });
      expect(instance.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
      expect(instance.items.length).toBeGreaterThan(0);
      expect(
        instance.items.every(
          (item) => item.tenantId === TENANT_1_MOCHA_HOUSE_ID,
        ),
      ).toBe(true);
    });

    // Milestone S0F — was 404 from each service's tenant-scoped lookup. A
    // location the active business does not own is now refused one layer
    // earlier, by the tenant-bounded AuthorizationContext (403), before the
    // service reads anything; nothing is created either way.
    it("refuses writes against another tenant's location even for a CORPORATE caller, creating nothing", async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/operations/tasks')
        .set('Authorization', `Bearer ${token()}`)
        .send({ locationId: tb.locationId, title: 'Cross-tenant task' })
        .expect(403);
      await request(app.getHttpServer())
        .put(
          `/api/v1/admin/catalog/locations/${tb.locationId}/menus/${tb.menuId}/products/${tb.productId}/price-override`,
        )
        .set('Authorization', `Bearer ${token()}`)
        .send({ price: 1 })
        .expect(403);
      await request(app.getHttpServer())
        .get('/api/v1/admin/operations/opening-checklist')
        .query({ locationId: tb.locationId })
        .set('Authorization', `Bearer ${token()}`)
        .expect(403);

      expect(
        await prisma.operationsTask.count({
          where: { locationId: tb.locationId },
        }),
      ).toBe(0);
      expect(
        await prisma.locationProductPriceOverride.count({
          where: { locationId: tb.locationId },
        }),
      ).toBe(0);
      expect(
        await prisma.checklistInstance.count({
          where: { locationId: tb.locationId },
        }),
      ).toBe(0);
    });
  });

  describe('structural writes for test Tenant B under an explicit Tenant B context', () => {
    it('operations task, overrides, checklist instance + items and template item all belong to Tenant B', async () => {
      const ctxB = contextFor(TEST_TENANT_B_ID);

      await app
        .get(OperationsTasksService)
        .create(
          tb.locationId,
          { title: 'Tenant B task' },
          tb.actorId,
          authorization,
          ctxB,
        );
      await app
        .get(CatalogService)
        .setProductPriceOverride(
          tb.locationId,
          tb.menuId,
          tb.productId,
          450,
          authorization,
          ctxB,
        );
      await app
        .get(CatalogService)
        .setProductAvailabilityOverride(
          tb.locationId,
          tb.menuId,
          tb.productId,
          true,
          authorization,
          ctxB,
        );
      await app
        .get(ChecklistExecutionService)
        .getToday(tb.templateKey, tb.locationId, authorization, ctxB);
      await app
        .get(ChecklistTemplateConfigService)
        .addItem(
          tb.templateKey,
          { section: 'Close', label: 'Lock doors' },
          authorization,
          ctxB,
        );

      const where = { locationId: tb.locationId };
      expect(
        (await prisma.operationsTask.findFirstOrThrow({ where })).tenantId,
      ).toBe(TEST_TENANT_B_ID);
      expect(
        (await prisma.locationProductPriceOverride.findFirstOrThrow({ where }))
          .tenantId,
      ).toBe(TEST_TENANT_B_ID);
      expect(
        (
          await prisma.locationProductAvailabilityOverride.findFirstOrThrow({
            where,
          })
        ).tenantId,
      ).toBe(TEST_TENANT_B_ID);
      const instance = await prisma.checklistInstance.findFirstOrThrow({
        where,
        include: { items: true },
      });
      expect(instance.tenantId).toBe(TEST_TENANT_B_ID);
      expect(instance.items.map((item) => item.tenantId)).toEqual([
        TEST_TENANT_B_ID,
      ]);
      const templateItems = await prisma.checklistTemplateItem.findMany({
        where: { templateId: tb.templateId },
      });
      expect(templateItems).toHaveLength(2);
      expect(
        templateItems.every((item) => item.tenantId === TEST_TENANT_B_ID),
      ).toBe(true);
    });

    it("a Tenant B context cannot write against Tenant #1's location or template, and vice versa", async () => {
      const ctxB = contextFor(TEST_TENANT_B_ID);
      const ctx1 = contextFor(TENANT_1_MOCHA_HOUSE_ID);

      await expect(
        app
          .get(OperationsTasksService)
          .create(
            t1.locationId,
            { title: 'x' },
            tb.actorId,
            authorization,
            ctxB,
          ),
      ).rejects.toThrow(NotFoundException);
      await expect(
        app
          .get(CatalogService)
          .setProductPriceOverride(
            t1.locationId,
            t1.menuId,
            t1.productId,
            1,
            authorization,
            ctxB,
          ),
      ).rejects.toThrow(NotFoundException);
      await expect(
        app
          .get(ChecklistExecutionService)
          .getToday(t1.templateKey, t1.locationId, authorization, ctxB),
      ).rejects.toThrow(NotFoundException);
      await expect(
        app
          .get(ChecklistTemplateConfigService)
          .addItem(
            t1.templateKey,
            { section: 'X', label: 'Y' },
            authorization,
            ctxB,
          ),
      ).rejects.toThrow(NotFoundException);
      await expect(
        app
          .get(ChecklistTemplateConfigService)
          .addItem(
            tb.templateKey,
            { section: 'X', label: 'Y' },
            authorization,
            ctx1,
          ),
      ).rejects.toThrow(NotFoundException);

      expect(
        await prisma.checklistTemplateItem.count({
          where: { templateId: t1.templateId },
        }),
      ).toBe(1);
    });
  });

  describe('the database refuses tenantless rows in converted tables', () => {
    it('rejects a Location without a tenant', async () => {
      await expect(
        prisma.$executeRaw`INSERT INTO "Location" (id, name, slug, "updatedAt")
          VALUES (${`s0d2a-null-${suffix}`}, 'No tenant', ${`s0d2a-null-${suffix}`}, now())`,
      ).rejects.toThrow(/null value in column "tenantId"/);
    });
  });
});
