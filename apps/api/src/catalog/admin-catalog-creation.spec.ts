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
  AdminAddMenuProductResponse,
  AdminCategorySummary,
  AdminProductDetail,
  LocationMenuResponse,
  OrderConfirmation,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { CatalogModule } from './catalog.module';
import { LocationsModule } from '../locations/locations.module';
import { CustomersModule } from '../customers/customers.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { GiftCardsModule } from '../gift-cards/gift-cards.module';
import { PaymentModule } from '../payment/payment.module';
import { OrdersController } from '../orders/api/orders.controller';
import { CheckoutService } from '../orders/application/checkout.service';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { firstFreeSlug } from './application/catalog-creation.service';

// S1 — Admin creation of categories and products, and menu placement, over
// real HTTP: validation at the boundary, corporate-only authorization,
// tenant ownership of every referenced record, idempotent and race-safe
// placement, audit events in the same transaction, and the end-to-end path
// to a customer menu and a development-mode checkout.
describe('S1 Admin catalog creation (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const secret = 's1-catalog-creation-internal-secret';
  const sfx = randomUUID().slice(0, 8);
  const T1 = TENANT_1_MOCHA_HOUSE_ID;

  // Tenant #1 fixture: an orderable location with its own menu.
  let locationId: string;
  let menuId: string;
  let existingCategoryId: string;
  // Tenant B records the Tenant #1 admin must never be able to reference.
  let bCategoryId: string;
  let bProductId: string;
  let bMenuId: string;

  const users: Record<'admin' | 'viewer' | 'locationManager', string> = {
    admin: '',
    viewer: '',
    locationManager: '',
  };
  const roleIds: string[] = [];

  const email = (who: string) => `s1-${who}-${sfx}@example.com`;
  const token = (who: keyof typeof users) =>
    signInternalDevJwt(
      { sub: `internal-dev:${email(who)}`, email: email(who), name: null },
      secret,
      3600,
    );
  const post = (path: string, who: keyof typeof users = 'admin') =>
    request(app.getHttpServer())
      .post(`/api/v1/admin/catalog${path}`)
      .set('Authorization', `Bearer ${token(who)}`);
  const unique = (label: string) => `S1 ${label} ${randomUUID().slice(0, 6)}`;

  async function makeUser(
    who: keyof typeof users,
    permissions: string[],
    scope: { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null },
  ) {
    const user = await prisma.internalUser.create({
      data: {
        tenantId: T1,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${email(who)}`,
        email: email(who),
        displayName: `S1 ${who}`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    const role = await prisma.internalRole.create({
      data: {
        tenantId: T1,
        key: `s1-${who}-${sfx}`,
        displayName: `S1 ${who}`,
        permissions: {
          create: permissions.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    roleIds.push(role.id);
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: T1,
        internalUserId: user.id,
        roleId: role.id,
        ...scope,
      },
    });
    users[who] = user.id;
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = secret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 's1-catalog-creation-customer-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        CatalogModule,
        LocationsModule,
        CustomersModule,
        LoyaltyModule,
        PromotionsModule,
        GiftCardsModule,
        PaymentModule,
      ],
      controllers: [OrdersController],
      providers: [CheckoutService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);

    locationId = (
      await prisma.location.create({
        data: {
          tenantId: T1,
          name: `S1 Location ${sfx}`,
          slug: `s1-location-${sfx}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;
    menuId = (
      await prisma.menu.create({
        data: { tenantId: T1, name: `S1 Menu ${sfx}`, slug: `s1-menu-${sfx}` },
      })
    ).id;
    await prisma.locationMenu.create({
      data: { tenantId: T1, locationId, menuId, isActive: true },
    });
    existingCategoryId = (
      await prisma.category.create({
        data: {
          tenantId: T1,
          name: `S1 Existing ${sfx}`,
          slug: `s1-existing-${sfx}`,
          isActive: false,
        },
      })
    ).id;

    await createTestTenantB(prisma);
    bCategoryId = (
      await prisma.category.create({
        data: {
          tenantId: TEST_TENANT_B_ID,
          name: 'B cat',
          slug: `s1-b-cat-${sfx}`,
        },
      })
    ).id;
    bProductId = (
      await prisma.product.create({
        data: {
          tenantId: TEST_TENANT_B_ID,
          name: 'B product',
          slug: `s1-b-prod-${sfx}`,
          basePrice: 100,
          categoryId: bCategoryId,
        },
      })
    ).id;
    bMenuId = (
      await prisma.menu.create({
        data: {
          tenantId: TEST_TENANT_B_ID,
          name: 'B menu',
          slug: `s1-b-menu-${sfx}`,
        },
      })
    ).id;

    const full = [
      'catalog.view',
      'catalog.products.edit',
      'catalog.menu.manage',
    ];
    await makeUser('admin', [...full, 'catalog.overrides.manage'], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await makeUser('viewer', ['catalog.view'], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    // CORPORATE-only permissions held at LOCATION scope grant nothing.
    await makeUser('locationManager', full, {
      scopeType: 'LOCATION',
      scopeId: locationId,
    });
  }, 60_000);

  afterAll(async () => {
    const actorIds = Object.values(users).filter(Boolean);
    const orders = await prisma.order.findMany({
      where: { locationId },
      select: { id: true, paymentAttemptId: true },
    });
    const orderIds = orders.map((o) => o.id);
    await prisma.orderLine.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderStatusHistory.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.outboxEvent.deleteMany({
      where: { aggregateType: 'Order', aggregateId: { in: orderIds } },
    });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.paymentAttempt.deleteMany({ where: { locationId } });
    await prisma.locationProductPriceOverride.deleteMany({
      where: { locationId },
    });
    await prisma.locationProductAvailabilityOverride.deleteMany({
      where: { locationId },
    });
    await prisma.internalAuditEvent.deleteMany({
      where: { actorInternalUserId: { in: actorIds } },
    });
    const created = await prisma.product.findMany({
      where: { tenantId: T1, slug: { startsWith: 's1-' } },
      select: { id: true },
    });
    const productIds = created.map((p) => p.id);
    await prisma.locationMenu.deleteMany({ where: { locationId } });
    await prisma.menuProduct.deleteMany({
      where: { OR: [{ menuId }, { productId: { in: productIds } }] },
    });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.category.deleteMany({
      where: { tenantId: T1, slug: { startsWith: 's1-' } },
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
    await prisma.product.deleteMany({ where: { id: bProductId } });
    await prisma.category.deleteMany({ where: { id: bCategoryId } });
    await prisma.menu.deleteMany({ where: { id: bMenuId } });
    await removeTestTenantB(prisma);
    await app.close();
    process.env = { ...originalEnv };
  });

  async function newCategory(): Promise<AdminCategorySummary> {
    const res = await post('/categories')
      .send({
        name: unique('Category'),
        slug: `s1-cat-${randomUUID().slice(0, 8)}`,
      })
      .expect(201);
    return res.body as AdminCategorySummary;
  }

  async function newProduct(
    overrides: Record<string, unknown> = {},
  ): Promise<AdminProductDetail> {
    const category = await newCategory();
    const res = await post('/products')
      .send({
        name: unique('Product'),
        categoryId: category.id,
        basePrice: 450,
        slug: `s1-prod-${randomUUID().slice(0, 8)}`,
        ...overrides,
      })
      .expect(201);
    return res.body as AdminProductDetail;
  }

  function auditEvents(action: string, targetId: string) {
    return prisma.internalAuditEvent.findMany({
      where: { action, targetId },
    });
  }

  describe('categories', () => {
    it('creates a category with a generated slug, after existing categories, and audits it', async () => {
      const name = `S1 Iced Drinks ${sfx}`;
      const res = await post('/categories').send({ name }).expect(201);
      const category = res.body as AdminCategorySummary;
      expect(category).toMatchObject({
        name,
        slug: `s1-iced-drinks-${sfx}`,
        isActive: true,
        productCount: 0,
      });
      const max = await prisma.category.aggregate({
        where: { tenantId: T1, id: { not: category.id } },
        _max: { displayOrder: true },
      });
      expect(category.displayOrder).toBeGreaterThan(max._max.displayOrder ?? 0);

      const row = await prisma.category.findUniqueOrThrow({
        where: { id: category.id },
      });
      expect(row.tenantId).toBe(T1);
      const events = await auditEvents('catalog.category_created', category.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        tenantId: T1,
        actorInternalUserId: users.admin,
        targetType: 'category',
      });
    });

    it('generates -2 for a repeated name, and 409s an explicit slug that is taken', async () => {
      const name = `S1 Repeat ${sfx}`;
      const first = (await post('/categories').send({ name }).expect(201))
        .body as AdminCategorySummary;
      const second = (await post('/categories').send({ name }).expect(201))
        .body as AdminCategorySummary;
      expect(second.slug).toBe(`${first.slug}-2`);

      await post('/categories')
        .send({ name: 'Anything', slug: first.slug })
        .expect(409);
    });

    it('lists categories (inactive included, with product counts) for catalog.view', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/catalog/categories')
        .set('Authorization', `Bearer ${token('viewer')}`)
        .expect(200);
      const listed = (res.body as AdminCategorySummary[]).find(
        (c) => c.id === existingCategoryId,
      );
      expect(listed).toMatchObject({ isActive: false, productCount: 0 });
      expect(
        (res.body as AdminCategorySummary[]).some((c) => c.id === bCategoryId),
      ).toBe(false);
    });

    it.each<[string, unknown]>([
      ['missing name', { slug: 's1-x' }],
      ['blank name', { name: '   ' }],
      ['name too long', { name: 'x'.repeat(121) }],
      ['name not text', { name: 12 }],
      ['slug with spaces', { name: 'Ok', slug: 'Bad Slug' }],
      ['slug upper-case', { name: 'Ok', slug: 'Bad' }],
      ['slug double hyphen', { name: 'Ok', slug: 'a--b' }],
      ['slug too long', { name: 'Ok', slug: 'a'.repeat(81) }],
      ['slug not text', { name: 'Ok', slug: 5 }],
      ['isActive not boolean', { name: 'Ok', isActive: 'yes' }],
      ['array body', [{ name: 'Ok' }]],
    ])('rejects %s with 400 and creates nothing', async (_label, body) => {
      const before = await prisma.category.count({ where: { tenantId: T1 } });
      await post('/categories')
        .send(body as object)
        .expect(400);
      expect(await prisma.category.count({ where: { tenantId: T1 } })).toBe(
        before,
      );
    });
  });

  describe('products', () => {
    it('creates a product in a category, never placing it on a menu, and audits it', async () => {
      const category = await newCategory();
      const name = `S1 Honey Latte ${sfx}`;
      const res = await post('/products')
        .send({
          name,
          categoryId: category.id,
          description: '  Oat milk and honey.  ',
          basePrice: 525,
          tenantId: TEST_TENANT_B_ID,
        })
        .expect(201);
      const product = res.body as AdminProductDetail;
      expect(product).toMatchObject({
        name,
        slug: `s1-honey-latte-${sfx}`,
        description: 'Oat milk and honey.',
        basePrice: 525,
        currency: 'USD',
        isActive: true,
        category: { id: category.id, name: category.name },
      });
      const row = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(row.tenantId).toBe(T1);
      expect(
        await prisma.menuProduct.count({ where: { productId: product.id } }),
      ).toBe(0);

      const events = await auditEvents('catalog.product_created', product.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        tenantId: T1,
        actorInternalUserId: users.admin,
        targetType: 'product',
      });
      expect(events[0].afterData).toMatchObject({
        basePrice: 525,
        categoryId: category.id,
      });
    });

    it('accepts an inactive category, a null price and an inactive product', async () => {
      const product = (
        await post('/products')
          .send({
            name: unique('No price'),
            categoryId: existingCategoryId,
            basePrice: null,
            isActive: false,
          })
          .expect(201)
      ).body as AdminProductDetail;
      expect(product).toMatchObject({ basePrice: null, isActive: false });
    });

    it('refuses another business’s category, or a missing one, with 400 and nothing written', async () => {
      const before = await prisma.product.count();
      for (const categoryId of [bCategoryId, randomUUID(), 'not-an-id']) {
        await post('/products')
          .send({ name: unique('Cross'), categoryId, basePrice: 100 })
          .expect(400);
      }
      expect(await prisma.product.count()).toBe(before);
    });

    it('409s a taken explicit slug', async () => {
      const existing = await newProduct();
      await post('/products')
        .send({
          name: unique('Dupe'),
          categoryId: existingCategoryId,
          basePrice: 100,
          slug: existing.slug,
        })
        .expect(409);
    });

    it.each<[string, Record<string, unknown>]>([
      ['missing price', {}],
      ['fractional price', { basePrice: 4.5 }],
      ['negative price', { basePrice: -1 }],
      ['price over the maximum', { basePrice: 100_001 }],
      ['price as text', { basePrice: '450' }],
      ['description too long', { basePrice: 1, description: 'x'.repeat(1001) }],
      ['description not text', { basePrice: 1, description: 3 }],
      ['missing category', { basePrice: 1, categoryId: undefined }],
      ['category not text', { basePrice: 1, categoryId: 7 }],
    ])('rejects %s with 400', async (_label, overrides) => {
      await post('/products')
        .send({
          name: unique('Invalid'),
          categoryId: existingCategoryId,
          ...overrides,
        })
        .expect(400);
    });
  });

  describe('authorization', () => {
    it('requires corporate catalog.products.edit / catalog.menu.manage', async () => {
      const product = await newProduct();
      const categoriesBefore = await prisma.category.count({
        where: { tenantId: T1 },
      });
      const productsBefore = await prisma.product.count({
        where: { tenantId: T1 },
      });
      for (const who of ['viewer', 'locationManager'] as const) {
        await post('/categories', who)
          .send({ name: unique('Denied') })
          .expect(403);
        await post('/products', who)
          .send({
            name: unique('Denied'),
            categoryId: existingCategoryId,
            basePrice: 1,
          })
          .expect(403);
        await post(`/menus/${menuId}/products`, who)
          .send({ productId: product.id })
          .expect(403);
      }
      await request(app.getHttpServer())
        .post('/api/v1/admin/catalog/categories')
        .send({ name: unique('Anonymous') })
        .expect(401);
      expect(await prisma.category.count({ where: { tenantId: T1 } })).toBe(
        categoriesBefore,
      );
      expect(await prisma.product.count({ where: { tenantId: T1 } })).toBe(
        productsBefore,
      );
      expect(
        await prisma.menuProduct.count({ where: { productId: product.id } }),
      ).toBe(0);
    });

    it('refuses a Tenant B business selection before writing anything', async () => {
      const before = await prisma.category.count();
      await post('/categories')
        .set('x-tenant-id', TEST_TENANT_B_ID)
        .send({ name: unique('Spoof') })
        .expect(403);
      expect(await prisma.category.count()).toBe(before);
    });
  });

  describe('menu placement', () => {
    it('adds hidden at the end of the menu, is idempotent, and audits only the creation', async () => {
      const product = await newProduct();
      const first = await post(`/menus/${menuId}/products`)
        .send({ productId: product.id })
        .expect(201);
      const added = first.body as AdminAddMenuProductResponse;
      expect(added.created).toBe(true);
      expect(added.placement).toMatchObject({
        menuId,
        productId: product.id,
        isActive: false,
      });

      const again = await post(`/menus/${menuId}/products`)
        .send({ productId: product.id, isActive: true })
        .expect(200);
      expect(again.body).toEqual({
        placement: added.placement,
        created: false,
      });

      const events = await auditEvents('catalog.menu_product_added', menuId);
      expect(
        events.filter(
          (e) =>
            (e.afterData as { productId: string }).productId === product.id,
        ),
      ).toHaveLength(1);
      expect(events[0]).toMatchObject({ tenantId: T1, targetType: 'menu' });

      const next = await newProduct();
      const placed = (
        await post(`/menus/${menuId}/products`)
          .send({ productId: next.id, isActive: true })
          .expect(201)
      ).body as AdminAddMenuProductResponse;
      expect(placed.placement.isActive).toBe(true);
      expect(placed.placement.displayOrder).toBe(
        added.placement.displayOrder + 1,
      );
    });

    it('refuses another business’s menu (404) or product (400)', async () => {
      const product = await newProduct();
      await post(`/menus/${bMenuId}/products`)
        .send({ productId: product.id })
        .expect(404);
      await post(`/menus/${randomUUID()}/products`)
        .send({ productId: product.id })
        .expect(404);
      await post(`/menus/${menuId}/products`)
        .send({ productId: bProductId })
        .expect(400);
      expect(
        await prisma.menuProduct.count({ where: { menuId: bMenuId } }),
      ).toBe(0);
      expect(
        await prisma.menuProduct.count({ where: { productId: bProductId } }),
      ).toBe(0);
    });

    it.each<[string, unknown]>([
      ['missing productId', {}],
      ['productId not text', { productId: 5 }],
      ['isActive not boolean', { productId: 'x', isActive: 'true' }],
      ['null body', null],
    ])('rejects %s with 400', async (_label, body) => {
      await post(`/menus/${menuId}/products`)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(body))
        .expect(400);
    });
  });

  describe('concurrency', () => {
    it('parallel adds of the same placement create exactly one row and one audit event', async () => {
      const product = await newProduct();
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          post(`/menus/${menuId}/products`).send({ productId: product.id }),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 200, 200, 200, 200, 201]);
      expect(
        await prisma.menuProduct.count({
          where: { menuId, productId: product.id },
        }),
      ).toBe(1);
      const events = await auditEvents('catalog.menu_product_added', menuId);
      expect(
        events.filter(
          (e) =>
            (e.afterData as { productId: string }).productId === product.id,
        ),
      ).toHaveLength(1);
    });

    it('parallel creates with the same name all succeed with distinct generated slugs', async () => {
      const name = `S1 Rush ${sfx}`;
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          post('/products').send({
            name,
            categoryId: existingCategoryId,
            basePrice: 100,
          }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      const slugs = new Set(
        results.map((r) => (r.body as AdminProductDetail).slug),
      );
      expect(slugs.size).toBe(4);
    });

    it('parallel creates with the same explicit slug: one 201, the rest 409', async () => {
      const slug = `s1-race-${randomUUID().slice(0, 8)}`;
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          post('/categories').send({ name: unique('Race'), slug }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    });
  });

  describe('end to end: category → product → menu → customer menu → checkout', () => {
    it('a created product reaches the customer menu once shown and can be ordered; overrides still apply', async () => {
      const category = (
        await post('/categories')
          .send({ name: `S1 E2E ${sfx}` })
          .expect(201)
      ).body as AdminCategorySummary;
      const product = (
        await post('/products')
          .send({
            name: `S1 E2E Cold Brew ${sfx}`,
            categoryId: category.id,
            basePrice: 475,
          })
          .expect(201)
      ).body as AdminProductDetail;

      const customerMenu = async () =>
        (
          (
            await request(app.getHttpServer())
              .get(`/api/v1/locations/${locationId}/menu`)
              .expect(200)
          ).body as LocationMenuResponse
        ).menu.products.find((p) => p.product.id === product.id);

      // Created but not placed: not on the customer menu.
      expect(await customerMenu()).toBeUndefined();

      await post(`/menus/${menuId}/products`)
        .send({ productId: product.id })
        .expect(201);
      // Placed but hidden: still not on the customer menu.
      expect(await customerMenu()).toBeUndefined();

      // Shown with the existing assignment control.
      await request(app.getHttpServer())
        .patch(
          `/api/v1/admin/catalog/menus/${menuId}/products/${product.id}/assignment`,
        )
        .set('Authorization', `Bearer ${token('admin')}`)
        .send({ isActive: true })
        .expect(200);
      expect(await customerMenu()).toMatchObject({
        effectivePrice: 475,
        isAvailable: true,
      });

      const checkout = (extra: Record<string, unknown> = {}) =>
        request(app.getHttpServer())
          .post('/api/v1/orders')
          .send({
            idempotencyKey: `s1_${randomUUID()}`,
            locationId,
            guest: { name: 'S1 Guest', phone: '5551234567' },
            lines: [{ productId: product.id, quantity: 2, selections: [] }],
            ...extra,
          });
      const placed = (await checkout().expect(201)).body as OrderConfirmation;
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: placed.orderId },
        include: { lines: true },
      });
      expect(order.tenantId).toBe(T1);
      expect(order.lines).toHaveLength(1);
      expect(order.lines[0]).toMatchObject({
        productId: product.id,
        quantity: 2,
      });
      expect(order.subtotal).toBe(950);

      // Existing per-location price and availability overrides still apply.
      const base = `/api/v1/admin/catalog/locations/${locationId}/menus/${menuId}/products/${product.id}`;
      await request(app.getHttpServer())
        .put(`${base}/price-override`)
        .set('Authorization', `Bearer ${token('admin')}`)
        .send({ price: 500 })
        .expect(200);
      expect(await customerMenu()).toMatchObject({ effectivePrice: 500 });
      await request(app.getHttpServer())
        .put(`${base}/availability-override`)
        .set('Authorization', `Bearer ${token('admin')}`)
        .send({ isAvailable: false })
        .expect(200);
      await checkout().expect(400);
    });
  });

  describe('firstFreeSlug', () => {
    it('suffixes, and shortens a long base so the suffix fits', () => {
      expect(firstFreeSlug('latte', new Set())).toBe('latte');
      expect(firstFreeSlug('latte', new Set(['latte', 'latte-2']))).toBe(
        'latte-3',
      );
      const long = 'a'.repeat(80);
      const slug = firstFreeSlug(long, new Set([long]));
      expect(slug).toBe(`${'a'.repeat(78)}-2`);
      expect(slug.length).toBeLessThanOrEqual(80);
    });
  });
});
