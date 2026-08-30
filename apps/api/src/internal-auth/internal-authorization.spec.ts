import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  INTERNAL_PERMISSION_KEYS,
  type InternalPermissionKey,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { CustomersModule } from '../customers/customers.module';
import { OrdersModule } from '../orders/orders.module';
import { CatalogModule } from '../catalog/catalog.module';
import { LocationsModule } from '../locations/locations.module';
import { InternalAuthModule } from './internal-auth.module';
import { signInternalDevJwt } from './infrastructure/internal-dev-jwt';
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';

// End-to-end HTTP proof of the Milestone 5B authorization matrix over the
// real local Postgres: ACTIVE + required permission + authorized scope, on
// every current admin route, including master-vs-override, cross-location
// denial, lying about locationId, lifecycle interaction, customer isolation
// and the seeded bootstrap.
describe('Internal admin authorization matrix (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'authz-matrix-internal-secret';
  const customerSecret = 'authz-matrix-customer-secret';
  const suffix = randomUUID();

  let locA: string;
  let locB: string;
  // An INACTIVE location, for asserting an authorized Admin read still sees
  // it (Milestone 5D-1) — the public endpoints filter inactive rows out.
  let locCInactive: string;
  // A throwaway location the 5D-2 edit tests mutate (rename / deactivate),
  // so locA/locB stay stable for every other test in this file.
  let locEdit: string;
  let menuId: string;
  let productId: string;
  let orderIdA: string;
  let paymentAttemptIdA: string;

  const users: Record<string, string> = {};
  const roleIds: string[] = [];

  const token = (key: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${key}`, email: `${key}@example.com`, name: null },
      internalSecret,
      3600,
    );

  async function createUser(key: string, status: 'ACTIVE' | 'SUSPENDED') {
    const email = `${key}@example.com`;
    const user = await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${key}`,
        email,
        status,
        activatedAt: new Date(),
      },
    });
    users[key] = user.id;
    return user.id;
  }

  async function grant(
    userId: string,
    permissions: InternalPermissionKey[],
    scope: { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null },
  ) {
    const role = await prisma.internalRole.create({
      data: {
        key: `authz-matrix-${suffix}-${randomUUID()}`,
        displayName: 'authz matrix spec role',
        permissions: {
          create: permissions.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    roleIds.push(role.id);
    await prisma.internalUserRoleAssignment.create({
      data: {
        internalUserId: userId,
        roleId: role.id,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
      },
    });
  }

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
        CustomersModule,
        InternalAuthModule,
        OrdersModule,
        CatalogModule,
        LocationsModule,
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    // Two throwaway locations. locA gets the seeded main-menu wired to it so
    // override routes reach their business validation; locB has no menu.
    const menu = await prisma.menu.findUniqueOrThrow({
      where: { slug: 'main-menu' },
    });
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'drip-coffee' },
    });
    menuId = menu.id;
    productId = product.id;

    locA = (
      await prisma.location.create({
        data: {
          name: `Authz A ${suffix}`,
          slug: `authz-a-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;
    locB = (
      await prisma.location.create({
        data: {
          name: `Authz B ${suffix}`,
          slug: `authz-b-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;
    locCInactive = (
      await prisma.location.create({
        data: {
          name: `Authz C ${suffix}`,
          slug: `authz-c-${suffix}`,
          isActive: false,
          isDigitalOrderingEnabled: false,
        },
      })
    ).id;
    locEdit = (
      await prisma.location.create({
        data: {
          name: `Authz Edit ${suffix}`,
          slug: `authz-edit-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;
    await prisma.locationMenu.create({
      data: { locationId: locA, menuId, isActive: true },
    });

    // A published, active order in locA.
    const pa = await prisma.paymentAttempt.create({
      data: {
        idempotencyKey: `authz-matrix-${suffix}`,
        provider: 'fake',
        status: 'SUCCEEDED',
        locationId: locA,
        amount: 500,
        currency: 'USD',
      },
    });
    paymentAttemptIdA = pa.id;
    const order = await prisma.order.create({
      data: {
        orderNumber: `AZ-${suffix.slice(0, 8)}`,
        accessToken: `azt-${suffix}`,
        locationId: locA,
        paymentAttemptId: pa.id,
        guestName: 'Authz Guest',
        guestPhone: '5555550000',
        currency: 'USD',
        subtotal: 500,
        status: 'RECEIVED',
        statusHistory: { create: { status: 'RECEIVED' } },
      },
    });
    orderIdA = order.id;
    await prisma.outboxEvent.create({
      data: {
        aggregateType: 'Order',
        aggregateId: order.id,
        eventType: 'order.created',
        payload: {},
        status: 'PROCESSED',
        processedAt: new Date(),
      },
    });

    await createUser(`norole-${suffix}`, 'ACTIVE');
    const corp = await createUser(`corp-${suffix}`, 'ACTIVE');
    await grant(corp, [...INTERNAL_PERMISSION_KEYS], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    const suspended = await createUser(`suspended-${suffix}`, 'SUSPENDED');
    await grant(suspended, [...INTERNAL_PERMISSION_KEYS], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    const ordersA = await createUser(`ordersA-${suffix}`, 'ACTIVE');
    await grant(ordersA, ['orders.view'], {
      scopeType: 'LOCATION',
      scopeId: locA,
    });
    const statusA = await createUser(`statusA-${suffix}`, 'ACTIVE');
    await grant(statusA, ['orders.manage_status'], {
      scopeType: 'LOCATION',
      scopeId: locA,
    });
    const overridesA = await createUser(`overridesA-${suffix}`, 'ACTIVE');
    await grant(overridesA, ['catalog.overrides.manage'], {
      scopeType: 'LOCATION',
      scopeId: locA,
    });
    const digitalA = await createUser(`digitalA-${suffix}`, 'ACTIVE');
    await grant(digitalA, ['locations.manage_digital_ordering'], {
      scopeType: 'LOCATION',
      scopeId: locA,
    });
    // locations.view @ locA only (Milestone 5D-1).
    const viewA = await createUser(`viewA-${suffix}`, 'ACTIVE');
    await grant(viewA, ['locations.view'], {
      scopeType: 'LOCATION',
      scopeId: locA,
    });
    // locations.edit granted at LOCATION scope — must NOT authorize the
    // edit (the permission is CORPORATE-only). Also holds locations.view so
    // it can read but not edit (Milestone 5D-2).
    const editLocScoped = await createUser(`editLocScoped-${suffix}`, 'ACTIVE');
    await grant(editLocScoped, ['locations.view', 'locations.edit'], {
      scopeType: 'LOCATION',
      scopeId: locEdit,
    });
    // catalog.products.edit granted at LOCATION scope — must NOT authorize a
    // master edit (the permission is CORPORATE-only).
    const productsLocA = await createUser(`productsLocA-${suffix}`, 'ACTIVE');
    await grant(
      productsLocA,
      ['catalog.products.edit', 'catalog.menu.manage'],
      {
        scopeType: 'LOCATION',
        scopeId: locA,
      },
    );
  }, 30_000);

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({
      where: { aggregateType: 'Order', aggregateId: orderIdA },
    });
    await prisma.orderStatusHistory.deleteMany({
      where: { orderId: orderIdA },
    });
    await prisma.order.deleteMany({ where: { id: orderIdA } });
    await prisma.paymentAttempt.deleteMany({
      where: { id: paymentAttemptIdA },
    });
    await prisma.locationProductPriceOverride.deleteMany({
      where: { locationId: { in: [locA, locB] } },
    });
    await prisma.locationProductAvailabilityOverride.deleteMany({
      where: { locationId: { in: [locA, locB] } },
    });
    await prisma.locationMenu.deleteMany({
      where: { locationId: { in: [locA, locB] } },
    });
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: Object.values(users) } },
    });
    for (const id of roleIds) {
      await prisma.internalRolePermission.deleteMany({ where: { roleId: id } });
      await prisma.internalRole.deleteMany({ where: { id } });
    }
    await prisma.internalUser.deleteMany({
      where: { id: { in: Object.values(users) } },
    });
    await prisma.location.deleteMany({
      where: { id: { in: [locA, locB, locCInactive, locEdit] } },
    });
    await app.close();
    process.env = { ...originalEnv };
  });

  const http = () => request(app.getHttpServer());
  const customerToken = () =>
    signDevJwt(
      { sub: 'dev:x@example.com', email: 'x@example.com', name: null },
      customerSecret,
      3600,
    );

  // ---- Orders ------------------------------------------------------------

  describe('orders', () => {
    it('ACTIVE user with no role assignment => 403 on every orders route', async () => {
      const t = token(`norole-${suffix}`);
      await http()
        .get(`/api/v1/admin/orders?locationId=${locA}`)
        .set('Authorization', `Bearer ${t}`)
        .expect(403);
      await http()
        .get(`/api/v1/admin/orders/${orderIdA}?locationId=${locA}`)
        .set('Authorization', `Bearer ${t}`)
        .expect(403);
      await http()
        .post(`/api/v1/admin/orders/${orderIdA}/advance`)
        .set('Authorization', `Bearer ${t}`)
        .send({ locationId: locA, expectedStatus: 'RECEIVED' })
        .expect(403);
    });

    it('orders.view @ locA can read locA but not locB', async () => {
      const t = token(`ordersA-${suffix}`);
      const list = await http()
        .get(`/api/v1/admin/orders?locationId=${locA}`)
        .set('Authorization', `Bearer ${t}`)
        .expect(200);
      expect(
        (list.body as Array<{ orderId: string }>).some(
          (o) => o.orderId === orderIdA,
        ),
      ).toBe(true);

      await http()
        .get(`/api/v1/admin/orders?locationId=${locB}`)
        .set('Authorization', `Bearer ${t}`)
        .expect(403);
      await http()
        .get(`/api/v1/admin/orders/${orderIdA}?locationId=${locB}`)
        .set('Authorization', `Bearer ${t}`)
        .expect(403);
    });

    it('corporate orders.view can read any location', async () => {
      const t = token(`corp-${suffix}`);
      await http()
        .get(`/api/v1/admin/orders?locationId=${locA}`)
        .set('Authorization', `Bearer ${t}`)
        .expect(200);
      await http()
        .get(`/api/v1/admin/orders?locationId=${locB}`)
        .set('Authorization', `Bearer ${t}`)
        .expect(200);
    });

    it('orders.view does NOT grant orders.manage_status', async () => {
      await http()
        .post(`/api/v1/admin/orders/${orderIdA}/advance`)
        .set('Authorization', `Bearer ${token(`ordersA-${suffix}`)}`)
        .send({ locationId: locA, expectedStatus: 'RECEIVED' })
        .expect(403);
    });

    it('orders.manage_status @ locA cannot advance an order in locB, and cannot be tricked by a lying locationId', async () => {
      const t = token(`statusA-${suffix}`);
      // Claiming locB (not authorized) => 403.
      await http()
        .post(`/api/v1/admin/orders/${orderIdA}/advance`)
        .set('Authorization', `Bearer ${t}`)
        .send({ locationId: locB, expectedStatus: 'RECEIVED' })
        .expect(403);
      // The order really is in locA; a caller scoped to locA advancing it
      // with the correct locationId succeeds.
      const ok = await http()
        .post(`/api/v1/admin/orders/${orderIdA}/advance`)
        .set('Authorization', `Bearer ${t}`)
        .send({ locationId: locA, expectedStatus: 'RECEIVED' })
        .expect(201);
      expect((ok.body as { status: string }).status).toBe('ACCEPTED');
    });

    it('a customer token is rejected (401) on admin orders', async () => {
      await http()
        .get(`/api/v1/admin/orders?locationId=${locA}`)
        .set('Authorization', `Bearer ${customerToken()}`)
        .expect(401);
    });
  });

  // ---- Locations -------------------------------------------------------

  describe('locations', () => {
    it('locations.manage_digital_ordering @ locA toggles locA, not locB', async () => {
      const t = token(`digitalA-${suffix}`);
      await http()
        .patch(`/api/v1/admin/locations/${locA}/digital-ordering`)
        .set('Authorization', `Bearer ${t}`)
        .send({ isDigitalOrderingEnabled: false })
        .expect(200);
      await http()
        .patch(`/api/v1/admin/locations/${locB}/digital-ordering`)
        .set('Authorization', `Bearer ${t}`)
        .send({ isDigitalOrderingEnabled: false })
        .expect(403);
    });

    it('corporate grant can toggle either location', async () => {
      const t = token(`corp-${suffix}`);
      await http()
        .patch(`/api/v1/admin/locations/${locA}/digital-ordering`)
        .set('Authorization', `Bearer ${t}`)
        .send({ isDigitalOrderingEnabled: true })
        .expect(200);
      await http()
        .patch(`/api/v1/admin/locations/${locB}/digital-ordering`)
        .set('Authorization', `Bearer ${t}`)
        .send({ isDigitalOrderingEnabled: true })
        .expect(200);
    });

    it('a user without the permission is denied (403)', async () => {
      await http()
        .patch(`/api/v1/admin/locations/${locA}/digital-ordering`)
        .set('Authorization', `Bearer ${token(`ordersA-${suffix}`)}`)
        .send({ isDigitalOrderingEnabled: true })
        .expect(403);
    });
  });

  // ---- Locations: Admin read experience (Milestone 5D-1) --------------

  describe('locations read', () => {
    it('a user without locations.view is denied on both read routes (403)', async () => {
      const t = token(`digitalA-${suffix}`); // has manage_digital_ordering, not view
      await http()
        .get('/api/v1/admin/locations')
        .set('Authorization', `Bearer ${t}`)
        .expect(403);
      await http()
        .get(`/api/v1/admin/locations/${locA}`)
        .set('Authorization', `Bearer ${t}`)
        .expect(403);
    });

    it('corporate locations.view lists every location including inactive ones', async () => {
      const t = token(`corp-${suffix}`);
      const res = await http()
        .get('/api/v1/admin/locations')
        .set('Authorization', `Bearer ${t}`)
        .expect(200);
      const body = res.body as Array<{ id: string; isActive: boolean }>;
      const ids = body.map((l) => l.id);
      expect(ids).toEqual(expect.arrayContaining([locA, locB, locCInactive]));
      expect(body.find((l) => l.id === locCInactive)?.isActive).toBe(false);
      // Deterministic ordering: sorted by name then id.
      const sorted = [...body].sort(
        (a, b) =>
          (a as { name: string }).name.localeCompare(
            (b as { name: string }).name,
          ) || a.id.localeCompare(b.id),
      );
      expect(body).toEqual(sorted);
    });

    it('LOCATION-scoped locations.view lists only the authorized location', async () => {
      const res = await http()
        .get('/api/v1/admin/locations')
        .set('Authorization', `Bearer ${token(`viewA-${suffix}`)}`)
        .expect(200);
      const ids = (res.body as Array<{ id: string }>).map((l) => l.id);
      expect(ids).toEqual([locA]);
    });

    it('LOCATION-scoped locations.view can open its own location detail with assigned menu', async () => {
      const res = await http()
        .get(`/api/v1/admin/locations/${locA}`)
        .set('Authorization', `Bearer ${token(`viewA-${suffix}`)}`)
        .expect(200);
      const body = res.body as {
        id: string;
        assignedMenu: { id: string; productCount: number } | null;
      };
      expect(body.id).toBe(locA);
      expect(body.assignedMenu?.id).toBe(menuId);
      expect(typeof body.assignedMenu?.productCount).toBe('number');
    });

    it('LOCATION-scoped locations.view is 403 (not 404) on another location detail', async () => {
      await http()
        .get(`/api/v1/admin/locations/${locB}`)
        .set('Authorization', `Bearer ${token(`viewA-${suffix}`)}`)
        .expect(403);
    });

    it('corporate locations.view can open an inactive location detail', async () => {
      const res = await http()
        .get(`/api/v1/admin/locations/${locCInactive}`)
        .set('Authorization', `Bearer ${token(`corp-${suffix}`)}`)
        .expect(200);
      const body = res.body as { isActive: boolean; assignedMenu: unknown };
      expect(body.isActive).toBe(false);
      expect(body.assignedMenu).toBeNull();
    });

    it('corporate locations.view gets 404 for a well-formed but unknown location id', async () => {
      await http()
        .get(`/api/v1/admin/locations/${randomUUID()}`)
        .set('Authorization', `Bearer ${token(`corp-${suffix}`)}`)
        .expect(404);
    });

    it('a customer token is rejected (401) on the Admin locations read', async () => {
      await http()
        .get('/api/v1/admin/locations')
        .set('Authorization', `Bearer ${customerToken()}`)
        .expect(401);
    });

    it('a SUSPENDED user with a full corporate role is still denied the read (403)', async () => {
      await http()
        .get('/api/v1/admin/locations')
        .set('Authorization', `Bearer ${token(`suspended-${suffix}`)}`)
        .expect(403);
    });
  });

  // ---- Locations: minimal edit (Milestone 5D-2) ----------------------

  describe('locations edit', () => {
    it('corporate locations.edit can rename a location', async () => {
      const newName = `Renamed ${suffix}`;
      const res = await http()
        .patch(`/api/v1/admin/locations/${locEdit}`)
        .set('Authorization', `Bearer ${token(`corp-${suffix}`)}`)
        .send({ name: `  ${newName}  ` })
        .expect(200);
      expect((res.body as { name: string }).name).toBe(newName);

      const check = await prisma.location.findUniqueOrThrow({
        where: { id: locEdit },
      });
      expect(check.name).toBe(newName);
    });

    it('corporate locations.edit can deactivate then reactivate a location', async () => {
      await http()
        .patch(`/api/v1/admin/locations/${locEdit}`)
        .set('Authorization', `Bearer ${token(`corp-${suffix}`)}`)
        .send({ isActive: false })
        .expect(200);
      expect(
        (await prisma.location.findUniqueOrThrow({ where: { id: locEdit } }))
          .isActive,
      ).toBe(false);

      const res = await http()
        .patch(`/api/v1/admin/locations/${locEdit}`)
        .set('Authorization', `Bearer ${token(`corp-${suffix}`)}`)
        .send({ isActive: true })
        .expect(200);
      expect((res.body as { isActive: boolean }).isActive).toBe(true);
    });

    it('a LOCATION-scoped locations.edit grant CANNOT edit (permission is corporate-only) => 403', async () => {
      await http()
        .patch(`/api/v1/admin/locations/${locEdit}`)
        .set('Authorization', `Bearer ${token(`editLocScoped-${suffix}`)}`)
        .send({ name: 'Should Not Apply' })
        .expect(403);
    });

    it('locations.view without locations.edit cannot edit (403)', async () => {
      await http()
        .patch(`/api/v1/admin/locations/${locA}`)
        .set('Authorization', `Bearer ${token(`viewA-${suffix}`)}`)
        .send({ name: 'Nope' })
        .expect(403);
    });

    it('slug is ignored — it cannot be changed through this endpoint', async () => {
      const before = await prisma.location.findUniqueOrThrow({
        where: { id: locEdit },
      });
      await http()
        .patch(`/api/v1/admin/locations/${locEdit}`)
        .set('Authorization', `Bearer ${token(`corp-${suffix}`)}`)
        .send({ slug: `hacked-${suffix}`, name: `Slug Guard ${suffix}` })
        .expect(200);
      const after = await prisma.location.findUniqueOrThrow({
        where: { id: locEdit },
      });
      expect(after.slug).toBe(before.slug);
      expect(after.name).toBe(`Slug Guard ${suffix}`);
    });

    it('isDigitalOrderingEnabled is ignored — online ordering has its own endpoint', async () => {
      const before = await prisma.location.findUniqueOrThrow({
        where: { id: locEdit },
      });
      await http()
        .patch(`/api/v1/admin/locations/${locEdit}`)
        .set('Authorization', `Bearer ${token(`corp-${suffix}`)}`)
        .send({ isDigitalOrderingEnabled: !before.isDigitalOrderingEnabled })
        .expect(200);
      const after = await prisma.location.findUniqueOrThrow({
        where: { id: locEdit },
      });
      expect(after.isDigitalOrderingEnabled).toBe(
        before.isDigitalOrderingEnabled,
      );
    });

    it('an empty / whitespace-only name is rejected (400)', async () => {
      await http()
        .patch(`/api/v1/admin/locations/${locEdit}`)
        .set('Authorization', `Bearer ${token(`corp-${suffix}`)}`)
        .send({ name: '   ' })
        .expect(400);
    });

    it('a nonexistent location => 404', async () => {
      await http()
        .patch(`/api/v1/admin/locations/${randomUUID()}`)
        .set('Authorization', `Bearer ${token(`corp-${suffix}`)}`)
        .send({ name: 'Ghost' })
        .expect(404);
    });

    it('a customer token is rejected (401) on the edit endpoint', async () => {
      await http()
        .patch(`/api/v1/admin/locations/${locEdit}`)
        .set('Authorization', `Bearer ${customerToken()}`)
        .send({ name: 'Nope' })
        .expect(401);
    });

    it('a SUSPENDED user with a full corporate role is still denied the edit (403)', async () => {
      await http()
        .patch(`/api/v1/admin/locations/${locEdit}`)
        .set('Authorization', `Bearer ${token(`suspended-${suffix}`)}`)
        .send({ name: 'Nope' })
        .expect(403);
    });
  });

  // ---- Catalog: master vs override ------------------------------------

  describe('catalog master vs override', () => {
    it('a LOCATION-scoped catalog.products.edit CANNOT edit a master product (403)', async () => {
      await http()
        .patch(`/api/v1/admin/catalog/products/${productId}`)
        .set('Authorization', `Bearer ${token(`productsLocA-${suffix}`)}`)
        .send({ isActive: true })
        .expect(403);
    });

    it('a LOCATION-scoped catalog.menu.manage CANNOT change a global menu assignment (403)', async () => {
      await http()
        .patch(
          `/api/v1/admin/catalog/menus/${menuId}/products/${productId}/assignment`,
        )
        .set('Authorization', `Bearer ${token(`productsLocA-${suffix}`)}`)
        .send({ isActive: true })
        .expect(403);
    });

    it('a corporate user CAN edit a master product and a menu assignment', async () => {
      const t = token(`corp-${suffix}`);
      await http()
        .patch(`/api/v1/admin/catalog/products/${productId}`)
        .set('Authorization', `Bearer ${t}`)
        .send({ isActive: true })
        .expect(200);
      await http()
        .patch(
          `/api/v1/admin/catalog/menus/${menuId}/products/${productId}/assignment`,
        )
        .set('Authorization', `Bearer ${t}`)
        .send({ isActive: true })
        .expect(200);
    });

    it('catalog.overrides.manage @ locA can modify a locA override but not locB', async () => {
      const t = token(`overridesA-${suffix}`);
      await http()
        .put(
          `/api/v1/admin/catalog/locations/${locA}/menus/${menuId}/products/${productId}/price-override`,
        )
        .set('Authorization', `Bearer ${t}`)
        .send({ price: 450 })
        .expect(200);

      // locB: unauthorized location -> 403 (before the missing-menu 404).
      await http()
        .put(
          `/api/v1/admin/catalog/locations/${locB}/menus/${menuId}/products/${productId}/price-override`,
        )
        .set('Authorization', `Bearer ${t}`)
        .send({ price: 450 })
        .expect(403);
    });

    it('a corporate user performing an override on a location with no menu gets the business 404, not 403', async () => {
      await http()
        .put(
          `/api/v1/admin/catalog/locations/${locB}/menus/${menuId}/products/${productId}/price-override`,
        )
        .set('Authorization', `Bearer ${token(`corp-${suffix}`)}`)
        .send({ price: 450 })
        .expect(404);
    });

    it('a user lacking catalog.overrides.manage is denied (403)', async () => {
      await http()
        .put(
          `/api/v1/admin/catalog/locations/${locA}/menus/${menuId}/products/${productId}/availability-override`,
        )
        .set('Authorization', `Bearer ${token(`digitalA-${suffix}`)}`)
        .send({ isAvailable: true })
        .expect(403);
    });
  });

  // ---- Lifecycle x permission ----------------------------------------

  describe('lifecycle interaction', () => {
    it('a SUSPENDED user with a full corporate role is still denied (InternalAuthGuard runs first)', async () => {
      const t = token(`suspended-${suffix}`);
      await http()
        .get('/api/v1/internal/me')
        .set('Authorization', `Bearer ${t}`)
        .expect(403);
      await http()
        .get(`/api/v1/admin/orders?locationId=${locA}`)
        .set('Authorization', `Bearer ${t}`)
        .expect(403);
      await http()
        .patch(`/api/v1/admin/catalog/products/${productId}`)
        .set('Authorization', `Bearer ${t}`)
        .send({ isActive: true })
        .expect(403);
    });
  });

  // ---- Bootstrap -----------------------------------------------------

  describe('seeded bootstrap', () => {
    it('the platform-administrator role holds every current permission', async () => {
      const role = await prisma.internalRole.findUniqueOrThrow({
        where: { key: 'platform-administrator' },
        include: { permissions: true },
      });
      expect(role.isSystem).toBe(true);
      expect(role.permissions.map((p) => p.permissionKey).sort()).toEqual(
        [...INTERNAL_PERMISSION_KEYS].sort(),
      );
    });

    it('the seeded dev admin has a CORPORATE platform-administrator assignment', async () => {
      const admin = await prisma.internalUser.findUniqueOrThrow({
        where: { email: 'admin@mochahouse.test' },
        include: { roleAssignments: { include: { role: true } } },
      });
      const corp = admin.roleAssignments.find(
        (a) =>
          a.role.key === 'platform-administrator' &&
          a.scopeType === 'CORPORATE' &&
          a.scopeId === null,
      );
      expect(corp).toBeDefined();
    });
  });
});
