import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  TAX_CATEGORIES_UNREVIEWED,
  TAX_CLASS_NAME_TAKEN,
  TAX_DRAFT_CHANGED,
  TAX_ZERO_ACKNOWLEDGEMENT_REQUIRED,
  TAX_SETTINGS_OWNER_ONLY,
  type AdminGettingStartedResponse,
  type AdminLocationTaxResponse,
  type AdminTaxClass,
  type AdminTaxSettingsResponse,
  type InternalPermissionKey,
  type TaxComponentInput,
} from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTaxSettingsForTest,
  removeTestTenantB,
} from '@mocha-house/testing';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';

// V1 Sales Tax PR 1 — sales tax settings, through the real HTTP stack
// (guards, tenant middleware) against a disposable database. Covers: the
// business's authorized administrator only (a Store Manager, a custom role
// holding tax.manage and staff without it are refused); isolation between
// businesses; exact rate parsing (no floats); versioning (drafts, confirmed
// versions kept and superseded, the database refusing edits to a confirmed
// version); the category review required before confirmation; and that
// nothing about orders or checkout readiness changes.

jest.setTimeout(120_000);

const T1 = TENANT_1_MOCHA_HOUSE_ID;
const TB = TEST_TENANT_B_ID;
const INTERNAL_SECRET = 'tax1-internal-secret';

describe('V1 Sales Tax PR 1 — tax settings (integration)', () => {
  const run = randomUUID().slice(0, 8);
  const originalEnv = { ...process.env };
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const created = { users: [] as string[], roles: [] as string[] };
  let t1Location: { id: string };
  const b = { locationId: '', categoryId: '', productId: '' };

  const token = (key: string) =>
    signInternalDevJwt(
      {
        sub: `internal-dev:tax1-${key}-${run}`,
        email: `tax1-${key}-${run}@example.test`,
        name: null,
      },
      INTERNAL_SECRET,
      3600,
    );

  async function staff(
    tenantId: string,
    key: string,
    roleId: string,
    scope: { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null } = {
      scopeType: 'CORPORATE',
      scopeId: null,
    },
  ) {
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:tax1-${key}-${run}`,
        email: `tax1-${key}-${run}@example.test`,
        displayName: `Tax ${key}`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    created.users.push(user.id);
    await prisma.internalUserRoleAssignment.create({
      data: { tenantId, internalUserId: user.id, roleId, ...scope },
    });
    return user;
  }

  async function role(
    tenantId: string,
    key: string,
    permissions: InternalPermissionKey[],
    isSystem = false,
  ) {
    const row = await prisma.internalRole.create({
      data: {
        tenantId,
        key,
        displayName: `Tax ${key}`,
        isSystem,
        permissions: {
          create: permissions.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    created.roles.push(row.id);
    return row;
  }

  const as = (key: string, tenantId = T1) => {
    const auth = <T extends request.Test>(test: T) =>
      test
        .set('Authorization', `Bearer ${token(key)}`)
        .set('X-Tenant-Id', tenantId);
    const server = () => request(app.getHttpServer());
    return {
      get: (path: string) => auth(server().get(path)),
      post: (path: string) => auth(server().post(path)),
      put: (path: string) => auth(server().put(path)),
      patch: (path: string) => auth(server().patch(path)),
      delete: (path: string) => auth(server().delete(path)),
    };
  };

  const SETTINGS = '/api/v1/admin/tax/settings';
  const CLASSES = '/api/v1/admin/tax/classes';
  const location = (id: string) => `/api/v1/admin/tax/locations/${id}`;
  const draft = (id: string) => `${location(id)}/draft`;
  const confirm = (id: string) => `${draft(id)}/confirm`;

  const settingsOf = async (key = 'owner', tenantId = T1) =>
    (await as(key, tenantId).get(SETTINGS).expect(200))
      .body as AdminTaxSettingsResponse;

  async function reviewAllCategories(key = 'owner', tenantId = T1) {
    const settings = await settingsOf(key, tenantId);
    for (const category of settings.categories) {
      await as(key, tenantId)
        .put(`/api/v1/admin/tax/categories/${category.id}`)
        .send({ taxClassId: category.taxClassId })
        .expect(200);
    }
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = INTERNAL_SECRET;
    process.env.RATE_LIMIT_ENABLED = '0';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.init();
    prisma = app.get(PrismaService);
    await removeTaxSettingsForTest([T1, TB]);

    t1Location = await prisma.location.findFirstOrThrow({
      where: { tenantId: T1 },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    // Mocha House: its built-in administrator (owner), a Store Manager (at a
    // location, and one at corporate scope), a custom role that ALSO holds
    // tax.manage (not the owner) and staff without it.
    const adminRole = await prisma.internalRole.findFirstOrThrow({
      where: { tenantId: T1, key: 'platform-administrator', isSystem: true },
    });
    expect(
      await prisma.internalRolePermission.count({
        where: { roleId: adminRole.id, permissionKey: 'tax.manage' },
      }),
    ).toBe(1);
    const managerRole = await prisma.internalRole.findFirstOrThrow({
      where: { tenantId: T1, key: 'store-manager', isSystem: true },
      include: { permissions: true },
    });
    expect(managerRole.permissions.map((p) => p.permissionKey)).not.toContain(
      'tax.manage',
    );
    await staff(T1, 'owner', adminRole.id);
    await staff(T1, 'manager', managerRole.id, {
      scopeType: 'LOCATION',
      scopeId: t1Location.id,
    });
    await staff(T1, 'manager-hq', managerRole.id);
    await staff(
      T1,
      'custom',
      (await role(T1, `tax1-custom-${run}`, ['tax.manage'])).id,
    );
    await staff(
      T1,
      'plain',
      (await role(T1, `tax1-plain-${run}`, ['reports.view'])).id,
    );

    // Business B with its own owner, location, category and product.
    await createTestTenantB(prisma);
    await staff(
      TB,
      'owner-b',
      (await role(TB, 'platform-administrator', ['tax.manage'], true)).id,
    );
    b.locationId = (
      await prisma.location.create({
        data: { tenantId: TB, name: 'B Store', slug: `tax1-b-${run}` },
      })
    ).id;
    b.categoryId = (
      await prisma.category.create({
        data: { tenantId: TB, name: 'B Drinks', slug: `tax1-b-${run}` },
      })
    ).id;
    b.productId = (
      await prisma.product.create({
        data: {
          tenantId: TB,
          name: 'B Latte',
          slug: `tax1-b-${run}`,
          categoryId: b.categoryId,
          basePrice: 450,
        },
      })
    ).id;
  });

  afterAll(async () => {
    try {
      await removeTaxSettingsForTest([T1, TB]);
      // This suite's staff, their audit history and roles (test-only
      // removal on the disposable database), then business B.
      const client = new Client({
        connectionString: process.env.DATABASE_URL!.split('?')[0],
      });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL session_replication_role = replica');
        await client.query(
          'DELETE FROM "InternalAuditEvent" WHERE "actorInternalUserId" = ANY($1::text[]) OR "tenantId" = $2',
          [created.users, TB],
        );
        await client.query('COMMIT');
      } finally {
        await client.end();
      }
      await prisma.internalUserRoleAssignment.deleteMany({
        where: { internalUserId: { in: created.users } },
      });
      await prisma.internalUser.deleteMany({
        where: { id: { in: created.users } },
      });
      await prisma.internalRolePermission.deleteMany({
        where: { roleId: { in: created.roles } },
      });
      await prisma.internalRole.deleteMany({
        where: { id: { in: created.roles } },
      });
      await prisma.product.deleteMany({ where: { tenantId: TB } });
      await prisma.category.deleteMany({ where: { tenantId: TB } });
      await prisma.location.deleteMany({ where: { tenantId: TB } });
      await removeTestTenantB(prisma);
    } finally {
      await app?.close();
      process.env = originalEnv;
    }
  });

  // --- authorization ------------------------------------------------------------

  it('only the authorized administrator may read or change tax settings', async () => {
    const routes = [
      ['get', SETTINGS],
      ['post', CLASSES],
      ['get', location(t1Location.id)],
      ['put', draft(t1Location.id)],
      ['delete', draft(t1Location.id)],
      ['post', confirm(t1Location.id)],
    ] as const;
    for (const [method, path] of routes) {
      // Store Managers (location or corporate) and staff without the
      // permission: refused by the permission guard.
      for (const key of ['manager', 'manager-hq', 'plain']) {
        await as(key)[method](path).send({}).expect(403);
      }
      // Holding tax.manage is not enough: the owner role is required too.
      const custom = await as('custom')[method](path).send({}).expect(403);
      expect((custom.body as { code?: string }).code).toBe(
        TAX_SETTINGS_OWNER_ONLY,
      );
    }
    // Nothing was created by the refused requests.
    expect(
      await prisma.locationTaxVersion.count({ where: { tenantId: T1 } }),
    ).toBe(0);
    // Unauthenticated.
    await request(app.getHttpServer())
      .get(SETTINGS)
      .set('X-Tenant-Id', T1)
      .expect(401);
  });

  it('creates the default Prepared Food class and lists every existing category as unreviewed', async () => {
    const settings = await settingsOf();
    const defaults = settings.classes.filter((c) => c.isDefault);
    expect(defaults).toEqual([
      expect.objectContaining({ name: 'Prepared Food', isDefault: true }),
    ]);
    expect(settings.categories.length).toBeGreaterThan(0);
    for (const category of settings.categories) {
      expect(category.taxClassId).toBe(defaults[0].id);
      expect(category.reviewed).toBe(false);
    }
    expect(settings.unreviewedActiveCategories).toBe(
      settings.categories.filter((c) => c.isActive).length,
    );
    expect(settings.pricesIncludeTax).toBe(false);
    expect(settings.taxCollectionEnabled).toBe(false);
    expect(settings.locations.find((l) => l.id === t1Location.id)).toEqual(
      expect.objectContaining({ state: 'NOT_SET', hasDraft: false }),
    );
    // A second read creates nothing more (one default per business).
    await settingsOf();
    expect(
      await prisma.taxClass.count({
        where: { tenantId: T1, systemKey: 'PREPARED_FOOD' },
      }),
    ).toBe(1);
  });

  it('manages tax classes: unique names ignoring case, renames audited', async () => {
    const created = (
      await as('owner').post(CLASSES).send({ name: '  Packaged   Food ' })
    ).body as AdminTaxClass;
    expect(created).toEqual(
      expect.objectContaining({ name: 'Packaged Food', isDefault: false }),
    );
    const taken = await as('owner')
      .post(CLASSES)
      .send({ name: 'PACKAGED FOOD' })
      .expect(409);
    expect((taken.body as { code?: string }).code).toBe(TAX_CLASS_NAME_TAKEN);
    await as('owner').post(CLASSES).send({ name: '' }).expect(400);
    await as('owner')
      .post(CLASSES)
      .send({ name: 'x'.repeat(61) })
      .expect(400);

    const renamed = (
      await as('owner')
        .patch(`${CLASSES}/${created.id}`)
        .send({ name: 'Grocery' })
        .expect(200)
    ).body as AdminTaxClass;
    expect(renamed.name).toBe('Grocery');
    expect(
      await prisma.internalAuditEvent.count({
        where: {
          tenantId: T1,
          action: { in: ['tax.class_created', 'tax.class_renamed'] },
          targetId: created.id,
        },
      }),
    ).toBe(2);
  });

  it('parses rates exactly and rejects anything that is not a plain percentage', async () => {
    const settings = await settingsOf();
    const food = settings.classes.find((c) => c.isDefault)!.id;
    const component = (ratePercent: unknown): unknown => ({
      name: 'Michigan sales tax',
      jurisdiction: 'STATE',
      ratePercent,
      taxClassIds: [food],
    });
    for (const bad of [
      6.25, // a number, not a string: never parsed through a float
      '6.12345', // more than 4 decimal places
      'abc',
      '-1',
      '0',
      '0.0000',
      '25.0001',
      '1e2',
      '',
    ]) {
      await as('owner')
        .put(draft(t1Location.id))
        .send({ components: [component(bad)] })
        .expect(400);
    }
    // Missing classes, jurisdiction or name.
    for (const bad of [
      { ...(component('6') as object), taxClassIds: [] },
      { ...(component('6') as object), jurisdiction: 'PLANET' },
      { ...(component('6') as object), name: ' ' },
    ]) {
      await as('owner')
        .put(draft(t1Location.id))
        .send({ components: [bad] })
        .expect(400);
    }
    // Too many taxes.
    await as('owner')
      .put(draft(t1Location.id))
      .send({ components: Array.from({ length: 11 }, () => component('1')) })
      .expect(400);
    expect(
      await prisma.locationTaxVersion.count({ where: { tenantId: T1 } }),
    ).toBe(0);

    const saved = (
      await as('owner')
        .put(draft(t1Location.id))
        .send({
          components: [
            component('6'),
            {
              name: 'City special',
              jurisdiction: 'SPECIAL',
              ratePercent: '0.0125%',
              taxClassIds: [food],
            },
            {
              name: 'Downtown district',
              jurisdiction: 'CITY',
              ratePercent: '25',
              taxClassIds: [food],
            },
          ],
        })
        .expect(200)
    ).body as AdminLocationTaxResponse;
    expect(
      saved.draft!.components.map((c) => [c.ratePpm, c.ratePercent]),
    ).toEqual([
      [60000, '6'],
      [125, '0.0125'],
      [250000, '25'],
    ]);
    expect(saved.draft).toEqual(
      expect.objectContaining({
        version: 1,
        status: 'DRAFT',
        source: 'BUILT_IN',
        pricesIncludeTax: false,
      }),
    );
    expect(saved.confirmed).toBeNull();
  });

  it('refuses confirmation until every active category is reviewed, and only for the draft reviewed', async () => {
    const before = (await as('owner').get(location(t1Location.id)).expect(200))
      .body as AdminLocationTaxResponse;
    expect(before.unreviewedActiveCategories).toBeGreaterThan(0);
    const unreviewed = await as('owner')
      .post(confirm(t1Location.id))
      .send({
        draftId: before.draft!.id,
        draftUpdatedAt: before.draft!.updatedAt,
      })
      .expect(409);
    expect((unreviewed.body as { code?: string }).code).toBe(
      TAX_CATEGORIES_UNREVIEWED,
    );

    await reviewAllCategories();
    expect((await settingsOf()).unreviewedActiveCategories).toBe(0);

    // A draft changed since it was reviewed is never confirmed unseen.
    const stale = await as('owner')
      .post(confirm(t1Location.id))
      .send({
        draftId: before.draft!.id,
        draftUpdatedAt: new Date(0).toISOString(),
      })
      .expect(409);
    expect((stale.body as { code?: string }).code).toBe(TAX_DRAFT_CHANGED);
    await as('owner').post(confirm(t1Location.id)).send({}).expect(400);

    const confirmed = (
      await as('owner')
        .post(confirm(t1Location.id))
        .send({
          draftId: before.draft!.id,
          draftUpdatedAt: before.draft!.updatedAt,
        })
        .expect(200)
    ).body as AdminLocationTaxResponse;
    expect(confirmed.draft).toBeNull();
    expect(confirmed.confirmed).toEqual(
      expect.objectContaining({
        id: before.draft!.id,
        version: 1,
        status: 'CONFIRMED',
        confirmedByName: 'Tax owner',
      }),
    );
    const summary = (await settingsOf()).locations.find(
      (l) => l.id === t1Location.id,
    )!;
    expect(summary).toEqual(
      expect.objectContaining({
        state: 'CONFIRMED',
        confirmedVersion: 1,
        confirmedDefaultRatePpm: 60000 + 125 + 250000,
      }),
    );
    expect(
      await prisma.internalAuditEvent.count({
        where: {
          tenantId: T1,
          action: 'tax.location_confirmed',
          targetId: t1Location.id,
        },
      }),
    ).toBe(1);
  });

  it('a change is a new version; confirming it supersedes and keeps the previous one', async () => {
    const food = (await settingsOf()).classes.find((c) => c.isDefault)!.id;
    const next: TaxComponentInput[] = [
      {
        name: 'Michigan sales tax',
        jurisdiction: 'STATE',
        ratePercent: '6',
        taxClassIds: [food],
      },
    ];
    const drafted = (
      await as('owner')
        .put(draft(t1Location.id))
        .send({ components: next })
        .expect(200)
    ).body as AdminLocationTaxResponse;
    expect(drafted.draft!.version).toBe(2);
    // The confirmed version is untouched while the draft exists.
    expect(drafted.confirmed!.version).toBe(1);
    expect(drafted.confirmed!.components).toHaveLength(3);

    const done = (
      await as('owner')
        .post(confirm(t1Location.id))
        .send({
          draftId: drafted.draft!.id,
          draftUpdatedAt: drafted.draft!.updatedAt,
        })
        .expect(200)
    ).body as AdminLocationTaxResponse;
    expect(done.confirmed!.version).toBe(2);
    expect(done.history).toHaveLength(1);
    expect(done.history[0]).toEqual(
      expect.objectContaining({ version: 1, status: 'SUPERSEDED' }),
    );
    expect(done.history[0].supersededAt).not.toBeNull();
    // The superseded version's rates are exactly as confirmed.
    expect(done.history[0].components.map((c) => c.ratePpm)).toEqual([
      60000, 125, 250000,
    ]);
  });

  it('the database refuses any change to a confirmed or superseded version', async () => {
    const versions = await prisma.locationTaxVersion.findMany({
      where: { tenantId: T1, locationId: t1Location.id },
      include: { components: { include: { classes: true } } },
      orderBy: { version: 'asc' },
    });
    const [superseded, confirmed] = versions;
    expect(superseded.status).toBe('SUPERSEDED');
    expect(confirmed.status).toBe('CONFIRMED');
    const component = confirmed.components[0];

    await expect(
      prisma.locationTaxComponent.update({
        where: { id: component.id },
        data: { ratePpm: 1 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.locationTaxComponent.create({
        data: {
          tenantId: T1,
          versionId: confirmed.id,
          name: 'Sneaky',
          jurisdiction: 'CITY',
          ratePpm: 1,
          displayOrder: 9,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.locationTaxComponentClass.deleteMany({
        where: { componentId: component.id },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.locationTaxComponent.deleteMany({
        where: { versionId: superseded.id },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.locationTaxVersion.update({
        where: { id: confirmed.id },
        data: {
          status: 'DRAFT',
          confirmedAt: null,
          confirmedByInternalUserId: null,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.locationTaxVersion.update({
        where: { id: superseded.id },
        data: { status: 'CONFIRMED', supersededAt: null },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.locationTaxVersion.delete({ where: { id: confirmed.id } }),
    ).rejects.toThrow();
    // Tax-inclusive prices and other sources are refused in V1.
    await expect(
      prisma.locationTaxVersion.create({
        data: {
          tenantId: T1,
          locationId: t1Location.id,
          version: 99,
          status: 'DRAFT',
          pricesIncludeTax: true,
        },
      }),
    ).rejects.toThrow();
    // A second draft for the same location is refused.
    await prisma.locationTaxVersion.create({
      data: {
        tenantId: T1,
        locationId: t1Location.id,
        version: 3,
        status: 'DRAFT',
      },
    });
    await expect(
      prisma.locationTaxVersion.create({
        data: {
          tenantId: T1,
          locationId: t1Location.id,
          version: 4,
          status: 'DRAFT',
        },
      }),
    ).rejects.toThrow();

    // Unchanged.
    const after = await prisma.locationTaxComponent.findUniqueOrThrow({
      where: { id: component.id },
    });
    expect(after.ratePpm).toBe(component.ratePpm);
  });

  it('discards a draft without touching confirmed settings', async () => {
    const discarded = (
      await as('owner').delete(draft(t1Location.id)).expect(200)
    ).body as AdminLocationTaxResponse;
    expect(discarded.draft).toBeNull();
    expect(discarded.confirmed!.version).toBe(2);
    await as('owner').delete(draft(t1Location.id)).expect(404);
  });

  it('sets and clears a product override', async () => {
    const settings = await settingsOf();
    const grocery = settings.classes.find((c) => c.name === 'Grocery')!;
    const product = settings.products[0];
    const path = `/api/v1/admin/tax/products/${product.id}`;
    await as('owner').put(path).send({ taxClassId: grocery.id }).expect(200);
    expect(
      (await settingsOf()).products.find((p) => p.id === product.id)!
        .overrideTaxClassId,
    ).toBe(grocery.id);
    await as('owner').put(path).send({ taxClassId: null }).expect(200);
    expect(
      (await settingsOf()).products.find((p) => p.id === product.id)!
        .overrideTaxClassId,
    ).toBeNull();
    await as('owner').put(path).send({}).expect(400);
    await as('owner').put(path).send({ taxClassId: 'missing' }).expect(400);
  });

  it('keeps every business isolated from the others', async () => {
    const t1 = await settingsOf();
    const t1Class = t1.classes[0].id;
    const t1Category = t1.categories[0].id;
    const t1Product = t1.products[0].id;

    // Business B sees only its own records, with its own default class.
    const own = await settingsOf('owner-b', TB);
    expect(own.categories.map((c) => c.id)).toEqual([b.categoryId]);
    expect(own.products.map((p) => p.id)).toEqual([b.productId]);
    expect(own.locations.map((l) => l.id)).toEqual([b.locationId]);
    expect(own.classes.map((c) => c.id)).not.toContain(t1Class);
    const bClass = own.classes[0].id;

    // B's owner can never reach Mocha House's records by id...
    const asB = as('owner-b', TB);
    await asB.get(location(t1Location.id)).expect(404);
    await asB.put(draft(t1Location.id)).send({ components: [] }).expect(404);
    await asB.delete(draft(t1Location.id)).expect(404);
    await asB
      .post(confirm(t1Location.id))
      .send({ draftId: 'x', draftUpdatedAt: 'x' })
      .expect(404);
    await asB
      .patch(`${CLASSES}/${t1Class}`)
      .send({ name: 'Hijacked' })
      .expect(404);
    await asB
      .put(`/api/v1/admin/tax/categories/${t1Category}`)
      .send({ taxClassId: bClass })
      .expect(404);
    await asB
      .put(`/api/v1/admin/tax/products/${t1Product}`)
      .send({ taxClassId: bClass })
      .expect(404);
    // ...or use Mocha House's classes for its own records.
    await asB
      .put(`/api/v1/admin/tax/categories/${b.categoryId}`)
      .send({ taxClassId: t1Class })
      .expect(400);
    await asB
      .put(draft(b.locationId))
      .send({
        components: [
          {
            name: 'State',
            jurisdiction: 'STATE',
            ratePercent: '6',
            taxClassIds: [t1Class],
          },
        ],
      })
      .expect(400);
    // And Mocha House's owner, naming business B, is refused.
    await as('owner', TB).get(SETTINGS).expect(403);

    // Nothing of Mocha House's changed.
    const unchanged = await settingsOf();
    expect(unchanged.classes).toEqual(t1.classes);
    expect(unchanged.categories).toEqual(t1.categories);
    expect(unchanged.products).toEqual(t1.products);

    // B confirms its own settings independently (no Mocha House rows).
    const saved = (
      await asB
        .put(draft(b.locationId))
        .send({
          components: [
            {
              name: 'State',
              jurisdiction: 'STATE',
              ratePercent: '7',
              taxClassIds: [bClass],
            },
          ],
        })
        .expect(200)
    ).body as AdminLocationTaxResponse;
    expect(saved.draft!.version).toBe(1);
    await reviewAllCategories('owner-b', TB);
    await asB
      .post(confirm(b.locationId))
      .send({
        draftId: saved.draft!.id,
        draftUpdatedAt: saved.draft!.updatedAt,
      })
      .expect(200);
    expect(
      (
        (await as('owner').get(location(t1Location.id)).expect(200))
          .body as AdminLocationTaxResponse
      ).confirmed!.version,
    ).toBe(2);
  });

  it('reports tax readiness on the setup checklist without blocking anything', async () => {
    const checklist = (await as('owner')
      .get('/api/v1/admin/getting-started')
      .expect(200)) as { body: AdminGettingStartedResponse };
    expect(checklist.body.salesTax).toEqual({
      totalLocations: await prisma.location.count({ where: { tenantId: T1 } }),
      confirmedLocations: 1,
    });
    // Not a step: the checklist's steps are unchanged.
    expect(
      (checklist.body.steps as { key: string }[]).map((step) => step.key),
    ).not.toContain('tax');
  });

  // V1 Sales Tax PR 2 — confirming settings with no taxes needs the
  // administrator's explicit acknowledgement, recorded in the history.
  it('requires and records an explicit acknowledgement to confirm zero tax', async () => {
    const second = await prisma.location.findFirstOrThrow({
      where: { tenantId: T1, id: { not: t1Location.id } },
      select: { id: true },
    });
    const saved = (
      await as('owner')
        .put(draft(second.id))
        .send({ components: [] })
        .expect(200)
    ).body as AdminLocationTaxResponse;
    const review = {
      draftId: saved.draft!.id,
      draftUpdatedAt: saved.draft!.updatedAt,
    };
    for (const acknowledgeNoTax of [undefined, false, 'yes']) {
      const refused = await as('owner')
        .post(confirm(second.id))
        .send({ ...review, acknowledgeNoTax })
        .expect(409);
      expect((refused.body as { code?: string }).code).toBe(
        TAX_ZERO_ACKNOWLEDGEMENT_REQUIRED,
      );
    }
    const confirmed = (
      await as('owner')
        .post(confirm(second.id))
        .send({ ...review, acknowledgeNoTax: true })
        .expect(200)
    ).body as AdminLocationTaxResponse;
    expect(confirmed.confirmed).toMatchObject({ components: [] });
    const event = await prisma.internalAuditEvent.findFirstOrThrow({
      where: {
        tenantId: T1,
        action: 'tax.location_confirmed',
        targetId: second.id,
      },
    });
    expect(event.afterData).toMatchObject({ noTaxAcknowledged: true });
  });
});
