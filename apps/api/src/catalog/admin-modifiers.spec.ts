import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
} from '@mocha-house/testing';
import type {
  AdminModifierGroupDetail,
  AdminModifierGroupSummary,
  AdminProductModifiersResponse,
  LocationMenuResponse,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { LocationsModule } from '../locations/locations.module';
import { CatalogModule } from './catalog.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';

// Product Modifier Management over real HTTP: corporate-only access (view vs
// edit), strict isolation between two businesses, validation at the
// boundary, the orderability rule, append-only history in the same
// transaction, race safety, and the customer menu reflecting the result.
describe('Product Modifier Management (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const secret = 'pmm-modifiers-internal-secret';
  const sfx = randomUUID().slice(0, 8);
  const T1 = TENANT_1_MOCHA_HOUSE_ID;
  const TB = TEST_TENANT_B_ID;

  type Who = 'admin' | 'viewer' | 'locationEditor' | 'storeManager' | 'bAdmin';
  const users: Record<Who, string> = {
    admin: '',
    viewer: '',
    locationEditor: '',
    storeManager: '',
    bAdmin: '',
  };
  const roleIds: string[] = [];

  // Tenant #1: a location whose menu carries the fixture products.
  let locationId: string;
  let menuId: string;
  let categoryId: string;
  // Tenant B: its own product and group, never reachable from Tenant #1.
  let bCategoryId: string;
  let bProductId: string;
  let bGroupId: string;

  const email = (who: Who) => `pmm-${who}-${sfx}@example.com`;
  const token = (who: Who) =>
    signInternalDevJwt(
      { sub: `internal-dev:${email(who)}`, email: email(who), name: null },
      secret,
      3600,
    );
  const api = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    who: Who | null = 'admin',
  ) => {
    const req = request(app.getHttpServer())[method](
      `/api/v1/admin/catalog${path}`,
    );
    return who ? req.set('Authorization', `Bearer ${token(who)}`) : req;
  };
  const name = (label: string) => `PMM ${label} ${randomUUID().slice(0, 6)}`;

  async function makeUser(
    who: Who,
    tenantId: string,
    permissions: string[] | { roleKey: string },
    scope: { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null },
  ) {
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${email(who)}`,
        email: email(who),
        displayName: `PMM ${who}`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    let roleId: string;
    if (Array.isArray(permissions)) {
      const role = await prisma.internalRole.create({
        data: {
          tenantId,
          key: `pmm-${who}-${sfx}`,
          displayName: `PMM ${who}`,
          permissions: {
            create: permissions.map((permissionKey) => ({ permissionKey })),
          },
        },
      });
      roleIds.push(role.id);
      roleId = role.id;
    } else {
      roleId = (
        await prisma.internalRole.findUniqueOrThrow({
          where: { tenantId_key: { tenantId, key: permissions.roleKey } },
        })
      ).id;
    }
    await prisma.internalUserRoleAssignment.create({
      data: { tenantId, internalUserId: user.id, roleId, ...scope },
    });
    users[who] = user.id;
  }

  async function newProduct(tenantId = T1, onMenu = true): Promise<string> {
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: name('Product'),
        slug: `pmm-product-${randomUUID().slice(0, 12)}`,
        basePrice: 400,
        categoryId: tenantId === T1 ? categoryId : bCategoryId,
      },
    });
    if (onMenu && tenantId === T1) {
      await prisma.menuProduct.create({
        data: { tenantId, menuId, productId: product.id, isActive: true },
      });
    }
    return product.id;
  }

  async function newGroup(
    body: { minSelections: number; maxSelections: number | null },
    options: { name: string; priceAdjustment: number }[] = [],
  ): Promise<AdminModifierGroupDetail> {
    let detail = (
      await api('post', '/modifier-groups')
        .send({ name: name('Group'), ...body })
        .expect(201)
    ).body as AdminModifierGroupDetail;
    for (const option of options) {
      detail = (
        await api('post', `/modifier-groups/${detail.id}/options`)
          .send(option)
          .expect(201)
      ).body as AdminModifierGroupDetail;
    }
    return detail;
  }

  const attach = (productId: string, groupId: string, who: Who = 'admin') =>
    api('post', `/products/${productId}/modifier-groups`, who).send({
      modifierGroupId: groupId,
    });

  const auditEvents = (targetId: string, action?: string) =>
    prisma.internalAuditEvent.findMany({
      where: { targetId, ...(action ? { action } : {}) },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = secret;

    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        InternalAuthModule,
        CatalogModule,
        LocationsModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);

    locationId = (
      await prisma.location.create({
        data: {
          tenantId: T1,
          name: `PMM Location ${sfx}`,
          slug: `pmm-location-${sfx}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;
    menuId = (
      await prisma.menu.create({
        data: {
          tenantId: T1,
          name: `PMM Menu ${sfx}`,
          slug: `pmm-menu-${sfx}`,
        },
      })
    ).id;
    await prisma.locationMenu.create({
      data: { tenantId: T1, locationId, menuId, isActive: true },
    });
    categoryId = (
      await prisma.category.create({
        data: { tenantId: T1, name: `PMM Cat ${sfx}`, slug: `pmm-cat-${sfx}` },
      })
    ).id;

    await createTestTenantB(prisma);
    bCategoryId = (
      await prisma.category.create({
        data: { tenantId: TB, name: 'PMM B cat', slug: `pmm-b-cat-${sfx}` },
      })
    ).id;
    bProductId = await newProduct(TB, false);

    const edit = ['catalog.view', 'catalog.products.edit'];
    const corporate = { scopeType: 'CORPORATE' as const, scopeId: null };
    await makeUser('admin', T1, edit, corporate);
    await makeUser('viewer', T1, ['catalog.view'], corporate);
    await makeUser('locationEditor', T1, edit, {
      scopeType: 'LOCATION',
      scopeId: locationId,
    });
    await makeUser(
      'storeManager',
      T1,
      { roleKey: 'store-manager' },
      { scopeType: 'LOCATION', scopeId: locationId },
    );
    await makeUser('bAdmin', TB, edit, corporate);

    bGroupId = (
      (
        await api('post', '/modifier-groups', 'bAdmin')
          .send({ name: 'PMM B Size', minSelections: 1, maxSelections: 1 })
          .expect(201)
      ).body as AdminModifierGroupDetail
    ).id;
  }, 60_000);

  afterAll(async () => {
    const actorIds = Object.values(users).filter(Boolean);
    await prisma.internalAuditEvent.deleteMany({
      where: { actorInternalUserId: { in: actorIds } },
    });
    const groups = await prisma.modifierGroup.findMany({
      where: {
        OR: [{ name: { startsWith: 'PMM ' } }, { id: bGroupId }],
        tenantId: { in: [T1, TB] },
      },
      select: { id: true },
    });
    const groupIds = groups.map((g) => g.id);
    await prisma.productModifierGroup.deleteMany({
      where: { modifierGroupId: { in: groupIds } },
    });
    await prisma.modifierOption.deleteMany({
      where: { modifierGroupId: { in: groupIds } },
    });
    await prisma.modifierGroup.deleteMany({ where: { id: { in: groupIds } } });
    const products = await prisma.product.findMany({
      where: { slug: { startsWith: 'pmm-product-' } },
      select: { id: true },
    });
    const productIds = products.map((p) => p.id);
    await prisma.locationMenu.deleteMany({ where: { locationId } });
    await prisma.menuProduct.deleteMany({ where: { menuId } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.category.deleteMany({
      where: { id: { in: [categoryId, bCategoryId] } },
    });
    await prisma.menu.deleteMany({ where: { id: menuId } });
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: actorIds } },
    });
    await prisma.internalUser.deleteMany({ where: { id: { in: actorIds } } });
    await prisma.internalRolePermission.deleteMany({
      where: { roleId: { in: roleIds } },
    });
    await prisma.internalRole.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.location.deleteMany({ where: { id: locationId } });
    await removeTestTenantB(prisma);
    await app.close();
    process.env = { ...originalEnv };
  });

  describe('access', () => {
    it('requires a signed-in staff member', async () => {
      await api('get', '/modifier-groups', null).expect(401);
      await api('post', '/modifier-groups', null)
        .send({ name: 'x', minSelections: 0, maxSelections: null })
        .expect(401);
    });

    it('view-only staff can read but never change; nothing is written', async () => {
      const group = await newGroup({ minSelections: 0, maxSelections: null });
      const productId = await newProduct();
      await api('get', '/modifier-groups', 'viewer').expect(200);
      await api('get', `/modifier-groups/${group.id}`, 'viewer').expect(200);
      await api(
        'get',
        `/products/${productId}/modifier-groups`,
        'viewer',
      ).expect(200);
      await api('post', '/modifier-groups', 'viewer')
        .send({ name: name('No'), minSelections: 0, maxSelections: null })
        .expect(403);
      await api('patch', `/modifier-groups/${group.id}`, 'viewer')
        .send({ name: 'Renamed' })
        .expect(403);
      await api('post', `/modifier-groups/${group.id}/options`, 'viewer')
        .send({ name: 'Oat', priceAdjustment: 0 })
        .expect(403);
      await attach(productId, group.id, 'viewer').expect(403);
      expect((await auditEvents(group.id)).map((e) => e.action)).toEqual([
        'catalog.modifier_group_created',
      ]);
      expect(
        await prisma.productModifierGroup.count({ where: { productId } }),
      ).toBe(0);
    });

    it('location-scoped staff and store managers can neither read nor edit', async () => {
      const group = await newGroup({ minSelections: 0, maxSelections: null });
      for (const who of ['locationEditor', 'storeManager'] as const) {
        await api('get', '/modifier-groups', who).expect(403);
        await api('get', `/modifier-groups/${group.id}`, who).expect(403);
        await api('post', '/modifier-groups', who)
          .send({ name: name('No'), minSelections: 0, maxSelections: null })
          .expect(403);
        await api('patch', `/modifier-groups/${group.id}`, who)
          .send({ isActive: false })
          .expect(403);
      }
      const after = await prisma.modifierGroup.findUniqueOrThrow({
        where: { id: group.id },
      });
      expect(after.isActive).toBe(true);
    });
  });

  describe('isolation between businesses', () => {
    it('each business sees only its own groups; another business reads as missing', async () => {
      const mine = await newGroup({ minSelections: 0, maxSelections: null }, [
        { name: 'Oat', priceAdjustment: 50 },
      ]);
      const list = (await api('get', '/modifier-groups').expect(200))
        .body as AdminModifierGroupSummary[];
      expect(list.map((g) => g.id)).toContain(mine.id);
      expect(list.map((g) => g.id)).not.toContain(bGroupId);
      const bList = (await api('get', '/modifier-groups', 'bAdmin').expect(200))
        .body as AdminModifierGroupSummary[];
      expect(bList.map((g) => g.id)).toEqual([bGroupId]);

      // Tenant #1 reaching for Tenant B's records, and the reverse.
      await api('get', `/modifier-groups/${bGroupId}`).expect(404);
      await api('patch', `/modifier-groups/${bGroupId}`)
        .send({ name: 'Taken over' })
        .expect(404);
      await api('post', `/modifier-groups/${bGroupId}/options`)
        .send({ name: 'Injected', priceAdjustment: 0 })
        .expect(404);
      await api('get', `/products/${bProductId}/modifier-groups`).expect(404);
      const myProduct = await newProduct();
      await attach(myProduct, bGroupId).expect(404);
      await attach(bProductId, mine.id).expect(404);
      await api('get', `/modifier-groups/${mine.id}`, 'bAdmin').expect(404);
      await api(
        'patch',
        `/modifier-groups/${mine.id}/options/${mine.options[0].id}`,
        'bAdmin',
      )
        .send({ isActive: false })
        .expect(404);
      await attach(bProductId, mine.id, 'bAdmin').expect(404);

      const bGroup = await prisma.modifierGroup.findUniqueOrThrow({
        where: { id: bGroupId },
        include: { options: true },
      });
      expect(bGroup.name).toBe('PMM B Size');
      expect(bGroup.options).toEqual([]);
      expect(
        await prisma.productModifierGroup.count({
          where: { productId: { in: [myProduct, bProductId] } },
        }),
      ).toBe(0);
    });
  });

  describe('groups and options', () => {
    it('validates every group field at the boundary', async () => {
      const bad: object[] = [
        { name: '', minSelections: 0, maxSelections: null },
        { name: '   ', minSelections: 0, maxSelections: null },
        { name: 'x'.repeat(121), minSelections: 0, maxSelections: null },
        { name: 'a\u0000b', minSelections: 0, maxSelections: null },
        { name: 'Size', minSelections: -1, maxSelections: null },
        { name: 'Size', minSelections: 21, maxSelections: null },
        { name: 'Size', minSelections: 1.5, maxSelections: null },
        { name: 'Size', minSelections: '1', maxSelections: null },
        { name: 'Size', minSelections: 0, maxSelections: 0 },
        { name: 'Size', minSelections: 0, maxSelections: 21 },
        { name: 'Size', minSelections: 3, maxSelections: 2 },
        { name: 'Size', minSelections: 0 },
        [],
      ];
      for (const body of bad) {
        await api('post', '/modifier-groups').send(body).expect(400);
      }
    });

    it('derives "required" from the minimum and records the creation', async () => {
      const required = await newGroup({ minSelections: 1, maxSelections: 1 });
      expect(required).toMatchObject({
        isRequired: true,
        minSelections: 1,
        maxSelections: 1,
        isActive: true,
        options: [],
        products: [],
      });
      const optional = await newGroup({
        minSelections: 0,
        maxSelections: null,
      });
      expect(optional.isRequired).toBe(false);

      const updated = (
        await api('patch', `/modifier-groups/${optional.id}`)
          .send({ minSelections: 2, maxSelections: 3 })
          .expect(200)
      ).body as AdminModifierGroupDetail;
      expect(updated).toMatchObject({ isRequired: true, minSelections: 2 });
      // Only one side of the range given: checked against the other.
      await api('patch', `/modifier-groups/${optional.id}`)
        .send({ maxSelections: 1 })
        .expect(400);

      const [created, changed] = await auditEvents(optional.id);
      expect(created).toMatchObject({
        tenantId: T1,
        actorInternalUserId: users.admin,
        action: 'catalog.modifier_group_created',
        targetType: 'modifier_group',
        beforeData: { group: null },
      });
      expect(changed).toMatchObject({
        action: 'catalog.modifier_group_updated',
        beforeData: {
          isRequired: false,
          minSelections: 0,
          maxSelections: null,
        },
        afterData: { isRequired: true, minSelections: 2, maxSelections: 3 },
      });
    });

    it('validates options; names are unique within a group; bounded count', async () => {
      const group = await newGroup({ minSelections: 0, maxSelections: null });
      const path = `/modifier-groups/${group.id}/options`;
      for (const priceAdjustment of [-1, 10_001, 1.5, '50', null]) {
        await api('post', path)
          .send({ name: 'Oat', priceAdjustment })
          .expect(400);
      }
      await api('post', path)
        .send({ name: 'Oat', priceAdjustment: 0 })
        .expect(201);
      await api('post', path)
        .send({ name: 'Whole', priceAdjustment: 10_000 })
        .expect(201);
      await api('post', path)
        .send({ name: ' oat ', priceAdjustment: 25 })
        .expect(409);

      await prisma.modifierOption.createMany({
        data: Array.from({ length: 48 }, (_, i) => ({
          tenantId: T1,
          modifierGroupId: group.id,
          name: `Filler ${i}`,
          displayOrder: 10 + i,
        })),
      });
      await api('post', path)
        .send({ name: 'One too many', priceAdjustment: 0 })
        .expect(400);
    });

    it('edits and reorders options with exact before/after history', async () => {
      const group = await newGroup({ minSelections: 0, maxSelections: 2 }, [
        { name: 'Vanilla', priceAdjustment: 50 },
        { name: 'Caramel', priceAdjustment: 50 },
        { name: 'Hazelnut', priceAdjustment: 75 },
      ]);
      const [vanilla, caramel, hazelnut] = group.options;
      const edited = (
        await api('patch', `/modifier-groups/${group.id}/options/${caramel.id}`)
          .send({
            name: 'Salted Caramel',
            priceAdjustment: 60,
            isActive: false,
          })
          .expect(200)
      ).body as AdminModifierGroupDetail;
      expect(edited.options[1]).toMatchObject({
        name: 'Salted Caramel',
        priceAdjustment: 60,
        isActive: false,
      });
      const [optionEvent] = await auditEvents(
        caramel.id,
        'catalog.modifier_option_updated',
      );
      expect(optionEvent).toMatchObject({
        targetType: 'modifier_option',
        beforeData: {
          modifierGroupId: group.id,
          name: 'Caramel',
          priceAdjustment: 50,
          isActive: true,
        },
        afterData: {
          modifierGroupId: group.id,
          name: 'Salted Caramel',
          priceAdjustment: 60,
          isActive: false,
        },
      });

      const order = `/modifier-groups/${group.id}/option-order`;
      await api('put', order)
        .send({ optionIds: [vanilla.id, caramel.id] })
        .expect(400);
      await api('put', order)
        .send({ optionIds: [vanilla.id, vanilla.id, caramel.id] })
        .expect(400);
      await api('put', order)
        .send({ optionIds: [vanilla.id, caramel.id, bGroupId] })
        .expect(400);
      const reordered = (
        await api('put', order)
          .send({ optionIds: [hazelnut.id, vanilla.id, caramel.id] })
          .expect(200)
      ).body as AdminModifierGroupDetail;
      expect(reordered.options.map((o) => o.id)).toEqual([
        hazelnut.id,
        vanilla.id,
        caramel.id,
      ]);
      // Same order again: nothing changes, nothing is recorded.
      await api('put', order)
        .send({ optionIds: [hazelnut.id, vanilla.id, caramel.id] })
        .expect(200);
      const reorders = await auditEvents(
        group.id,
        'catalog.modifier_options_reordered',
      );
      expect(reorders).toHaveLength(1);
      expect(reorders[0]).toMatchObject({
        beforeData: { optionIds: [vanilla.id, caramel.id, hazelnut.id] },
        afterData: { optionIds: [hazelnut.id, vanilla.id, caramel.id] },
      });
    });
  });

  describe('product attachments and orderability', () => {
    it('attaches, reorders and detaches groups on a product, with history', async () => {
      const productId = await newProduct();
      const size = await newGroup({ minSelections: 1, maxSelections: 1 }, [
        { name: 'Small', priceAdjustment: 0 },
        { name: 'Large', priceAdjustment: 100 },
      ]);
      const milk = await newGroup({ minSelections: 0, maxSelections: 1 }, [
        { name: 'Oat', priceAdjustment: 50 },
      ]);
      await attach(productId, size.id).expect(201);
      const both = (await attach(productId, milk.id).expect(201))
        .body as AdminProductModifiersResponse;
      expect(both.groups.map((g) => g.id)).toEqual([size.id, milk.id]);
      // Idempotent: attaching again changes and records nothing.
      await attach(productId, milk.id).expect(201);

      const order = `/products/${productId}/modifier-group-order`;
      await api('put', order)
        .send({ modifierGroupIds: [milk.id] })
        .expect(400);
      const reordered = (
        await api('put', order)
          .send({ modifierGroupIds: [milk.id, size.id] })
          .expect(200)
      ).body as AdminProductModifiersResponse;
      expect(reordered.groups.map((g) => g.id)).toEqual([milk.id, size.id]);

      const detached = (
        await api(
          'delete',
          `/products/${productId}/modifier-groups/${milk.id}`,
        ).expect(200)
      ).body as AdminProductModifiersResponse;
      expect(detached.groups.map((g) => g.id)).toEqual([size.id]);
      await api(
        'delete',
        `/products/${productId}/modifier-groups/${milk.id}`,
      ).expect(404);

      expect(
        (await auditEvents(productId)).map((e) => [e.action, e.afterData]),
      ).toEqual([
        [
          'catalog.product_modifier_group_attached',
          { modifierGroupId: size.id, modifierGroupIds: [size.id] },
        ],
        [
          'catalog.product_modifier_group_attached',
          { modifierGroupId: milk.id, modifierGroupIds: [size.id, milk.id] },
        ],
        [
          'catalog.product_modifier_groups_reordered',
          { modifierGroupIds: [milk.id, size.id] },
        ],
        [
          'catalog.product_modifier_group_detached',
          { modifierGroupId: milk.id, modifierGroupIds: [size.id] },
        ],
      ]);

      // The group's detail names every product it is attached to.
      const detail = (
        await api('get', `/modifier-groups/${size.id}`).expect(200)
      ).body as AdminModifierGroupDetail;
      expect(detail.products.map((p) => p.id)).toEqual([productId]);
    });

    it('never attaches a group a customer could not complete', async () => {
      const productId = await newProduct();
      const empty = await newGroup({ minSelections: 0, maxSelections: null });
      await attach(productId, empty.id).expect(409);
      const pickTwo = await newGroup({ minSelections: 2, maxSelections: 2 }, [
        { name: 'One', priceAdjustment: 0 },
      ]);
      await attach(productId, pickTwo.id).expect(409);
      const inactive = await newGroup({ minSelections: 0, maxSelections: 1 }, [
        { name: 'One', priceAdjustment: 0 },
      ]);
      await api('patch', `/modifier-groups/${inactive.id}`)
        .send({ isActive: false })
        .expect(200);
      await attach(productId, inactive.id).expect(409);
      expect(
        await prisma.productModifierGroup.count({ where: { productId } }),
      ).toBe(0);
      expect(await auditEvents(productId)).toEqual([]);
    });

    it('refuses edits that would leave an attached product impossible to configure', async () => {
      const productId = await newProduct();
      const size = await newGroup({ minSelections: 1, maxSelections: 1 }, [
        { name: 'Small', priceAdjustment: 0 },
        { name: 'Large', priceAdjustment: 100 },
      ]);
      const [small, large] = size.options;
      await attach(productId, size.id).expect(201);
      const optionPath = (id: string) =>
        `/modifier-groups/${size.id}/options/${id}`;

      await api('patch', optionPath(small.id))
        .send({ isActive: false })
        .expect(200);
      const refused = await api('patch', optionPath(large.id))
        .send({ isActive: false })
        .expect(409);
      expect((refused.body as { message: string }).message).toContain(
        'Product',
      );
      await api('patch', `/modifier-groups/${size.id}`)
        .send({ minSelections: 2, maxSelections: 2 })
        .expect(409);

      // An inactive group is not offered, so it never blocks a product…
      await api('patch', `/modifier-groups/${size.id}`)
        .send({ isActive: false })
        .expect(200);
      await api('patch', optionPath(large.id))
        .send({ isActive: false })
        .expect(200);
      // …but it cannot come back while it could not be completed.
      await api('patch', `/modifier-groups/${size.id}`)
        .send({ isActive: true })
        .expect(409);

      const state = await prisma.modifierGroup.findUniqueOrThrow({
        where: { id: size.id },
        include: { options: true },
      });
      expect(state).toMatchObject({ isActive: false, minSelections: 1 });
      expect(state.options.filter((o) => o.isActive)).toHaveLength(0);

      // Detached, the group may change freely.
      await api(
        'delete',
        `/products/${productId}/modifier-groups/${size.id}`,
      ).expect(200);
      await api('patch', `/modifier-groups/${size.id}`)
        .send({ isActive: true, minSelections: 2, maxSelections: 2 })
        .expect(200);
    });

    it('allows safe edits on attached groups; ids that are not ours read as missing', async () => {
      const productId = await newProduct();
      const syrups = await newGroup({ minSelections: 0, maxSelections: 3 }, [
        { name: 'Vanilla', priceAdjustment: 50 },
      ]);
      const other = await newGroup({ minSelections: 0, maxSelections: null }, [
        { name: 'Oat', priceAdjustment: 0 },
      ]);
      await attach(productId, syrups.id).expect(201);
      // Lowering the maximum, or adding options, can't break the product.
      await api('patch', `/modifier-groups/${syrups.id}`)
        .send({ maxSelections: 1 })
        .expect(200);
      await api('post', `/modifier-groups/${syrups.id}/options`)
        .send({ name: 'Caramel', priceAdjustment: 50 })
        .expect(201);
      // An option is only reachable through its own group.
      await api(
        'patch',
        `/modifier-groups/${syrups.id}/options/${other.options[0].id}`,
      )
        .send({ isActive: false })
        .expect(404);
      expect(
        await prisma.modifierOption.findUniqueOrThrow({
          where: { id: other.options[0].id },
        }),
      ).toMatchObject({ isActive: true });
      // Path ids that cannot be ours are a plain 404, never a server error.
      for (const bad of ['%00', 'x'.repeat(65)]) {
        await api('get', `/modifier-groups/${bad}`).expect(404);
        await api('patch', `/modifier-groups/${bad}`)
          .send({ name: 'Nope' })
          .expect(404);
        await api('get', `/products/${bad}/modifier-groups`).expect(404);
        await api('patch', `/modifier-groups/${syrups.id}/options/${bad}`)
          .send({ isActive: false })
          .expect(404);
      }
    });

    it('two simultaneous deactivations cannot both pass the check', async () => {
      const productId = await newProduct();
      const group = await newGroup({ minSelections: 1, maxSelections: 1 }, [
        { name: 'A', priceAdjustment: 0 },
        { name: 'B', priceAdjustment: 0 },
      ]);
      await attach(productId, group.id).expect(201);
      const results = await Promise.all(
        group.options.map((option) =>
          api('patch', `/modifier-groups/${group.id}/options/${option.id}`)
            .send({ isActive: false })
            .then((res) => res.status),
        ),
      );
      expect(results.sort()).toEqual([200, 409]);
      expect(
        await prisma.modifierOption.count({
          where: { modifierGroupId: group.id, isActive: true },
        }),
      ).toBe(1);
    });

    it('a simultaneous attach and deactivation cannot leave the product broken', async () => {
      const productId = await newProduct();
      const group = await newGroup({ minSelections: 1, maxSelections: 1 }, [
        { name: 'Only', priceAdjustment: 0 },
      ]);
      const [attachStatus, deactivateStatus] = await Promise.all([
        attach(productId, group.id).then((res) => res.status),
        api(
          'patch',
          `/modifier-groups/${group.id}/options/${group.options[0].id}`,
        )
          .send({ isActive: false })
          .then((res) => res.status),
      ]);
      const attached = await prisma.productModifierGroup.count({
        where: { productId, modifierGroupId: group.id },
      });
      const active = await prisma.modifierOption.count({
        where: { modifierGroupId: group.id, isActive: true },
      });
      // Whichever commits first wins and the other is refused; the product
      // is never left with a group that has nothing to choose.
      const attachWon = attachStatus === 201;
      expect([attachStatus, deactivateStatus]).toEqual(
        attachWon ? [201, 409] : [409, 200],
      );
      expect(attached).toBe(attachWon ? 1 : 0);
      expect(active).toBe(attachWon ? 1 : 0);
    });
  });

  describe('customer menu', () => {
    it('shows attached groups and active options in the configured order', async () => {
      const productId = await newProduct();
      const size = await newGroup({ minSelections: 1, maxSelections: 1 }, [
        { name: 'Small', priceAdjustment: 0 },
        { name: 'Large', priceAdjustment: 125 },
        { name: 'Huge', priceAdjustment: 300 },
      ]);
      const extras = await newGroup({ minSelections: 0, maxSelections: null }, [
        { name: 'Whip', priceAdjustment: 50 },
      ]);
      const [small, large, huge] = size.options;
      await api('put', `/modifier-groups/${size.id}/option-order`)
        .send({ optionIds: [large.id, small.id, huge.id] })
        .expect(200);
      await api('patch', `/modifier-groups/${size.id}/options/${huge.id}`)
        .send({ isActive: false })
        .expect(200);
      await attach(productId, size.id).expect(201);
      await attach(productId, extras.id).expect(201);
      await api('put', `/products/${productId}/modifier-group-order`)
        .send({ modifierGroupIds: [extras.id, size.id] })
        .expect(200);

      const menu = (
        await request(app.getHttpServer())
          .get(`/api/v1/locations/${locationId}/menu`)
          .expect(200)
      ).body as LocationMenuResponse;
      const item = menu.menu.products.find((p) => p.product.id === productId)!;
      expect(item.modifierGroups.map((g) => [g.name, g.isRequired])).toEqual([
        [extras.name, false],
        [size.name, true],
      ]);
      expect(
        item.modifierGroups[1].options.map((o) => [o.name, o.priceAdjustment]),
      ).toEqual([
        ['Large', 125],
        ['Small', 0],
      ]);
    });
  });
});
