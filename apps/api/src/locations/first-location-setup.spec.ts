import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminAssignLocationMenuResponse,
  AdminBillingCheckoutResponse,
  AdminCategorySummary,
  AdminCreateMenuResponse,
  AdminGettingStartedResponse,
  AdminLocationDetail,
  AdminProductDetail,
  LocationLimitReachedBody,
  LocationOrderingNotReadyBody,
  OwnerBusinessCreateResponse,
} from '@mocha-house/contracts';
import {
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  type ScratchDatabase,
} from '@mocha-house/testing';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { deriveDevOwnerRegistrationCode } from '../owner-registration/infrastructure/local-dev-owner-registration.provider';
import { SAAS_BILLING_PROVIDER } from '../saas-billing/provider/saas-billing-provider';
import type {
  FakeEventBody,
  FakeSaasBillingProvider,
} from '../saas-billing/provider/fake-saas-billing-provider';

// SC4d — a self-service business sets up its first location, end to end on
// the real AppModule (fake billing provider, test mode) in a SCRATCH
// database of its own: the first location only (race-safe), its profile and
// weekly opening hours (overnight, split and overlapping periods), a menu
// that is safe to submit twice, the location's menu, the getting-started
// checklist computed from real data, online ordering that stays OFF until
// setup and billing are done, and tenant isolation for every new route
// (plus three existing location-menu routes now confined to the business).
describe('SC4d first location setup (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let fake: FakeSaasBillingProvider;
  const originalEnv = { ...process.env };
  const INTERNAL_SECRET = `sc4d-internal-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  let growth: { versionId: string; month: string };

  const emailOf = (key: string) => `sc4d-${key}-${run}@example.com`;
  const token = (email: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${email}`, email, name: null, email_verified: true },
      INTERNAL_SECRET,
      3600,
    );
  const http = () => request(app.getHttpServer());
  const api = (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    who: Owner,
    path: string,
    body?: object,
  ) => {
    const req = http()
      [method](`/api/v1/admin${path}`)
      .set('Authorization', `Bearer ${token(who.email)}`)
      .set('X-Tenant-Id', who.tenantId);
    return body ? req.send(body) : req;
  };

  interface Owner {
    email: string;
    tenantId: string;
  }

  const profile = (overrides: Record<string, unknown> = {}) => ({
    name: 'Harbor Street Cafe',
    addressLine1: '12 Harbor Street',
    addressLine2: 'Unit 4',
    city: 'Portland',
    region: 'ME',
    postalCode: '04101',
    countryCode: 'us',
    timeZone: 'America/New_York',
    phone: '+1 (207) 555-0134',
    ...overrides,
  });

  const week = {
    days: [
      // Split day: lunch and dinner.
      {
        dayOfWeek: 1,
        periods: [
          { opensAt: '11:00', closesAt: '14:00' },
          { opensAt: '17:00', closesAt: '22:00' },
        ],
      },
      { dayOfWeek: 2, periods: [{ opensAt: '07:00', closesAt: '24:00' }] },
      // Overnight into Saturday.
      { dayOfWeek: 5, periods: [{ opensAt: '18:00', closesAt: '02:00' }] },
      { dayOfWeek: 6, periods: [{ opensAt: '10:00', closesAt: '23:00' }] },
      // Sunday night into Monday morning, ending before Monday's opening.
      { dayOfWeek: 7, periods: [{ opensAt: '20:00', closesAt: '01:00' }] },
    ],
  };

  async function ownerBusiness(key: string): Promise<Owner> {
    const email = emailOf(key);
    await http()
      .post('/api/v1/internal/registration/start')
      .send({ email })
      .expect(202);
    await http()
      .post('/api/v1/internal/registration/complete')
      .send({
        email,
        code: deriveDevOwnerRegistrationCode(email, 'sign-up', INTERNAL_SECRET),
        password: 'Correct-Horse-9-Battery',
        displayName: 'Owner',
        termsVersion: 'terms-1',
        privacyVersion: 'privacy-1',
        acceptLegal: true,
      })
      .expect(200);
    const res = await http()
      .post('/api/v1/internal/onboarding/business')
      .set('Authorization', `Bearer ${token(email)}`)
      .send({
        businessName: `Cafe ${key}`,
        planVersionId: growth.versionId,
        planPriceId: growth.month,
        expectedPrice: {
          interval: 'MONTH',
          currency: 'USD',
          amountMinorUnits: 4900,
        },
      })
      .expect(201);
    return {
      email,
      tenantId: (res.body as OwnerBusinessCreateResponse).business.id,
    };
  }

  // The provider's verified trial start (SC4c): the only thing that
  // authorizes a self-service business's billing.
  let seq = 0;
  async function authorizeBilling(owner: Owner) {
    const checkout = await api('post', owner, '/billing/checkout').expect(201);
    const sessionId = (checkout.body as AdminBillingCheckoutResponse).url
      .split('/')
      .pop()!;
    const sub = await prisma.tenantSubscription.findUniqueOrThrow({
      where: { subscriberTenantId: owner.tenantId },
    });
    const snapshot = fake.completeCheckout(sessionId, {
      hasPaymentMethod: true,
    });
    const body: FakeEventBody = {
      id: `evt_${run}_${seq++}`,
      type: 'checkout.completed',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: {
        session: sessionId,
        customer: sub.externalCustomerId,
        subscription: snapshot.externalSubscriptionId,
      },
    };
    const signed = fake.signEvent(body);
    await http()
      .post('/api/v1/billing/webhooks/fake')
      .set('Content-Type', 'application/json')
      .set('x-billing-signature', signed.signatureHeader)
      .send(signed.rawBody)
      .expect(200);
  }

  async function firstLocation(owner: Owner): Promise<AdminLocationDetail> {
    const res = await api('post', owner, '/locations', profile()).expect(201);
    return res.body as AdminLocationDetail;
  }

  // A category, an active priced product, a menu with it shown, assigned to
  // the location.
  async function sellableMenu(owner: Owner, locationId: string) {
    const category = (
      await api('post', owner, '/catalog/categories', { name: 'Coffee' })
    ).body as AdminCategorySummary;
    const product = (
      await api('post', owner, '/catalog/products', {
        name: 'Latte',
        categoryId: category.id,
        basePrice: 450,
      }).expect(201)
    ).body as AdminProductDetail;
    const menu = (
      await api('post', owner, '/catalog/menus', { name: 'All day' }).expect(
        201,
      )
    ).body as AdminCreateMenuResponse;
    await api('post', owner, `/catalog/menus/${menu.menu.id}/products`, {
      productId: product.id,
      isActive: true,
    }).expect(201);
    await api('put', owner, `/catalog/locations/${locationId}/menu`, {
      menuId: menu.menu.id,
    }).expect(200);
    return {
      categoryId: category.id,
      productId: product.id,
      menuId: menu.menu.id,
    };
  }

  const checklist = async (owner: Owner) =>
    (await api('get', owner, '/getting-started').expect(200))
      .body as AdminGettingStartedResponse;
  const doneKeys = (list: AdminGettingStartedResponse) =>
    list.steps.filter((step) => step.done).map((step) => step.key);

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4d_location',
    );
    await applyMigrations(
      scratch.url,
      listMigrations(
        join(__dirname, '../../../../packages/database/prisma/migrations'),
      ),
    );
    Object.assign(process.env, {
      DATABASE_URL: scratch.url,
      INTERNAL_AUTH_PROVIDER: 'dev',
      INTERNAL_AUTH_DEV_JWT_SECRET: INTERNAL_SECRET,
      RATE_LIMIT_ENABLED: '0',
      SAAS_BILLING_PROVIDER: 'fake',
      SAAS_BILLING_TRIAL_CLAIM_SECRET: `sc4d-claims-${randomUUID()}`,
      BILLING_CHECKOUT_RETURN_URL: 'http://localhost:3000/admin/billing',
      SELF_SERVICE_REGISTRATION_ENABLED: '1',
      SELF_SERVICE_TERMS_VERSION: 'terms-1',
      SELF_SERVICE_PRIVACY_VERSION: 'privacy-1',
      SELF_SERVICE_REGISTRATION_SECRET: `sc4d-registration-${randomUUID()}`,
    });
    delete process.env.BILLING_ENFORCEMENT_ENABLED;
    delete process.env.BILLING_NOTIFICATIONS_ENABLED;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({
      rawBody: true,
    });
    await app.init();
    prisma = app.get(PrismaService);
    fake = app.get(SAAS_BILLING_PROVIDER);

    const plan = await prisma.subscriptionPlan.create({
      data: {
        key: `growth-${run}`,
        name: 'Growth',
        selfServiceAvailable: true,
        versions: {
          create: {
            version: 1,
            status: 'PUBLISHED',
            moduleKeys: ['loyalty'],
            publishedAt: new Date(),
          },
        },
        prices: {
          create: [
            { interval: 'MONTH', currency: 'USD', amountMinorUnits: 4900 },
          ],
        },
      },
      include: { versions: true, prices: true },
    });
    growth = { versionId: plan.versions[0].id, month: plan.prices[0].id };
    await prisma.billingPolicy.update({
      where: { id: 'default' },
      data: { trialDays: 14, trialRequiresPaymentMethod: true },
    });
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = { ...originalEnv };
      await scratch?.drop();
    }
  });

  it('gives the owner role locations.create and starts the checklist with only the business created', async () => {
    const owner = await ownerBusiness('start');
    const grants = await prisma.internalRolePermission.findMany({
      where: { tenantId: owner.tenantId, permissionKey: 'locations.create' },
    });
    expect(grants).toHaveLength(1);

    const list = await checklist(owner);
    expect(list).toMatchObject({
      completedCount: 1,
      totalCount: 7,
      setupComplete: false,
      locationId: null,
      menuId: null,
      // This deployment's storefront serves another business (SC4f).
      storefrontLive: false,
    });
    expect(list.steps.map((step) => step.key)).toEqual([
      'business',
      'billing',
      'location',
      'profile',
      'hours',
      'menu',
      'ordering',
    ]);
    expect(doneKeys(list)).toEqual(['business']);
  });

  it('creates the first location with its profile and online ordering OFF, audited; a second is refused', async () => {
    const owner = await ownerBusiness('create');
    const res = await api('post', owner, '/locations', {
      ...profile(),
      // Ignored: never taken from the body.
      tenantId: randomUUID(),
      slug: 'chosen-by-client',
      isDigitalOrderingEnabled: true,
    }).expect(201);
    const location = res.body as AdminLocationDetail;
    expect(location).toMatchObject({
      name: 'Harbor Street Cafe',
      slug: 'harbor-street-cafe',
      isActive: true,
      isDigitalOrderingEnabled: false,
      assignedMenu: null,
      profile: {
        addressLine1: '12 Harbor Street',
        addressLine2: 'Unit 4',
        city: 'Portland',
        region: 'ME',
        postalCode: '04101',
        countryCode: 'US',
        timeZone: 'America/New_York',
        phone: '+1 (207) 555-0134',
      },
      openingHours: { isSet: false },
    });
    expect(location.openingHours.days).toHaveLength(7);
    const row = await prisma.location.findUniqueOrThrow({
      where: { id: location.id },
    });
    expect(row.tenantId).toBe(owner.tenantId);
    expect(
      await prisma.internalAuditEvent.count({
        where: {
          tenantId: owner.tenantId,
          action: 'location.created',
          targetId: location.id,
        },
      }),
    ).toBe(1);

    const second = await api(
      'post',
      owner,
      '/locations',
      profile({ name: 'Second' }),
    ).expect(409);
    expect(second.body as LocationLimitReachedBody).toMatchObject({
      code: 'LOCATION_LIMIT_REACHED',
      locationId: location.id,
    });
    expect(
      await prisma.location.count({ where: { tenantId: owner.tenantId } }),
    ).toBe(1);

    const list = await checklist(owner);
    expect(doneKeys(list)).toEqual(['business', 'location', 'profile']);
    expect(list.locationId).toBe(location.id);
  });

  it('never creates two first locations under concurrent submissions', async () => {
    const owner = await ownerBusiness('race');
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api('post', owner, '/locations', profile()),
      ),
    );
    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    expect(
      await prisma.location.count({ where: { tenantId: owner.tenantId } }),
    ).toBe(1);
  });

  it('validates the profile: required fields, country, IANA time zone and phone', async () => {
    const owner = await ownerBusiness('validate');
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ city: '  ' }, 'city'],
      [{ addressLine1: undefined }, 'addressLine1'],
      [{ countryCode: 'XX' }, 'countryCode'],
      [{ countryCode: 'USA' }, 'countryCode'],
      [{ timeZone: 'EST' }, 'timeZone'],
      [{ timeZone: 'Mars/Olympus_Mons' }, 'timeZone'],
      [{ phone: 'call me' }, 'phone'],
      [{ phone: '123' }, 'phone'],
      [{ postalCode: '<script>' }, 'postalCode'],
      [{ name: 'x'.repeat(81) }, 'name'],
      [{ name: 'Bad\u0000name' }, 'name'],
    ];
    for (const [overrides, field] of cases) {
      const res = await api(
        'post',
        owner,
        '/locations',
        profile(overrides),
      ).expect(400);
      expect((res.body as { field?: string }).field).toBe(field);
    }
    // Region and postal code are optional.
    await api(
      'post',
      owner,
      '/locations',
      profile({ region: null, postalCode: '' }),
    ).expect(201);

    // Updating the profile uses the same rules.
    const [location] = await prisma.location.findMany({
      where: { tenantId: owner.tenantId },
    });
    await api(
      'put',
      owner,
      `/locations/${location.id}/profile`,
      profile({ timeZone: 'UTC+1' }),
    ).expect(400);
    const updated = (
      await api(
        'put',
        owner,
        `/locations/${location.id}/profile`,
        profile({
          name: 'Renamed',
          timeZone: 'Europe/Paris',
          countryCode: 'FR',
        }),
      ).expect(200)
    ).body as AdminLocationDetail;
    expect(updated).toMatchObject({
      name: 'Renamed',
      slug: location.slug,
      profile: { timeZone: 'Europe/Paris', countryCode: 'FR' },
    });
  });

  it('saves weekly opening hours with split and overnight periods, and refuses overlaps', async () => {
    const owner = await ownerBusiness('hours');
    const location = await firstLocation(owner);
    const path = `/locations/${location.id}/hours`;

    const refused: Array<[object, RegExp]> = [
      [
        {
          days: [
            {
              dayOfWeek: 1,
              periods: [
                { opensAt: '09:00', closesAt: '13:00' },
                { opensAt: '12:00', closesAt: '15:00' },
              ],
            },
          ],
        },
        /Monday: opening periods overlap/,
      ],
      [
        // Friday overnight runs into Saturday's opening.
        {
          days: [
            {
              dayOfWeek: 5,
              periods: [{ opensAt: '20:00', closesAt: '03:00' }],
            },
            {
              dayOfWeek: 6,
              periods: [{ opensAt: '02:00', closesAt: '10:00' }],
            },
          ],
        },
        /Friday and Saturday: opening periods overlap/,
      ],
      [
        // Sunday overnight wraps into Monday morning.
        {
          days: [
            {
              dayOfWeek: 7,
              periods: [{ opensAt: '22:00', closesAt: '06:00' }],
            },
            {
              dayOfWeek: 1,
              periods: [{ opensAt: '05:00', closesAt: '09:00' }],
            },
          ],
        },
        /opening periods overlap/,
      ],
      [
        {
          days: [
            {
              dayOfWeek: 1,
              periods: [{ opensAt: '10:00', closesAt: '10:00' }],
            },
          ],
        },
        /same time/,
      ],
      [
        {
          days: [
            {
              dayOfWeek: 1,
              periods: [{ opensAt: '25:00', closesAt: '26:00' }],
            },
          ],
        },
        /HH:MM/,
      ],
      [
        {
          days: [
            {
              dayOfWeek: 1,
              periods: [{ opensAt: '24:00', closesAt: '02:00' }],
            },
          ],
        },
        /HH:MM/,
      ],
      [{ days: [{ dayOfWeek: 8, periods: [] }] }, /only once/],
      [
        {
          days: [
            { dayOfWeek: 2, periods: [] },
            { dayOfWeek: 2, periods: [] },
          ],
        },
        /only once/,
      ],
      [
        {
          days: [
            {
              dayOfWeek: 3,
              periods: [
                { opensAt: '01:00', closesAt: '02:00' },
                { opensAt: '03:00', closesAt: '04:00' },
                { opensAt: '05:00', closesAt: '06:00' },
                { opensAt: '07:00', closesAt: '08:00' },
                { opensAt: '09:00', closesAt: '10:00' },
              ],
            },
          ],
        },
        /at most 4/,
      ],
      [{ days: 'always' }, /malformed/],
    ];
    for (const [body, message] of refused) {
      const res = await api('put', owner, path, body).expect(400);
      expect((res.body as { message: string }).message).toMatch(message);
    }
    expect(
      await prisma.locationOpeningPeriod.count({
        where: { locationId: location.id },
      }),
    ).toBe(0);

    const saved = (await api('put', owner, path, week).expect(200))
      .body as AdminLocationDetail;
    expect(saved.openingHours.isSet).toBe(true);
    expect(saved.openingHours.days.map((day) => day.periods)).toEqual([
      [
        { opensAt: '11:00', closesAt: '14:00' },
        { opensAt: '17:00', closesAt: '22:00' },
      ],
      [{ opensAt: '07:00', closesAt: '24:00' }],
      [],
      [],
      [{ opensAt: '18:00', closesAt: '02:00' }],
      [{ opensAt: '10:00', closesAt: '23:00' }],
      [{ opensAt: '20:00', closesAt: '01:00' }],
    ]);

    // Saving again replaces the week (no duplicates); concurrent saves leave
    // exactly one week.
    await Promise.all([
      api('put', owner, path, week),
      api('put', owner, path, week),
    ]);
    expect(
      await prisma.locationOpeningPeriod.count({
        where: { locationId: location.id },
      }),
    ).toBe(6);
    expect(
      await prisma.internalAuditEvent.count({
        where: {
          tenantId: owner.tenantId,
          action: 'location.opening_hours_updated',
          targetId: location.id,
        },
      }),
    ).toBe(3);
    expect(doneKeys(await checklist(owner))).toContain('hours');

    // Closed every day is a valid choice, but not "hours configured".
    const closed = (await api('put', owner, path, { days: [] }).expect(200))
      .body as AdminLocationDetail;
    expect(closed.openingHours.isSet).toBe(true);
    expect(doneKeys(await checklist(owner))).not.toContain('hours');
  });

  it('creates a menu once even when submitted twice, and assigns it as the location menu idempotently', async () => {
    const owner = await ownerBusiness('menu');
    const location = await firstLocation(owner);

    const created = await api('post', owner, '/catalog/menus', {
      name: 'Breakfast',
    }).expect(201);
    const menu = (created.body as AdminCreateMenuResponse).menu;
    const repeat = await api('post', owner, '/catalog/menus', {
      name: 'breakfast',
    }).expect(200);
    expect(repeat.body as AdminCreateMenuResponse).toEqual({
      menu,
      created: false,
    });
    const racing = await Promise.all(
      Array.from({ length: 4 }, () =>
        api('post', owner, '/catalog/menus', { name: 'Dinner' }),
      ),
    );
    expect(racing.every((res) => [200, 201].includes(res.status))).toBe(true);
    expect(
      await prisma.menu.count({
        where: { tenantId: owner.tenantId, name: 'Dinner' },
      }),
    ).toBe(1);
    expect(
      await prisma.internalAuditEvent.count({
        where: { tenantId: owner.tenantId, action: 'catalog.menu_created' },
      }),
    ).toBe(2);

    const assign = (menuId: string) =>
      api('put', owner, `/catalog/locations/${location.id}/menu`, { menuId });
    expect((await assign(menu.id).expect(200)).body).toEqual({
      locationId: location.id,
      menuId: menu.id,
      changed: true,
    } satisfies AdminAssignLocationMenuResponse);
    expect(
      (
        (await assign(menu.id).expect(200))
          .body as AdminAssignLocationMenuResponse
      ).changed,
    ).toBe(false);

    // Switching menus leaves exactly one active menu on the location.
    const dinner = await prisma.menu.findFirstOrThrow({
      where: { tenantId: owner.tenantId, name: 'Dinner' },
    });
    await assign(dinner.id).expect(200);
    expect(
      await prisma.locationMenu.findMany({
        where: { locationId: location.id, isActive: true },
        select: { menuId: true },
      }),
    ).toEqual([{ menuId: dinner.id }]);
    await assign(randomUUID()).expect(400);
  });

  it('counts the menu step only for an active, available product priced above zero', async () => {
    const owner = await ownerBusiness('priced');
    const location = await firstLocation(owner);
    const { productId, menuId } = await sellableMenu(owner, location.id);
    expect(doneKeys(await checklist(owner))).toContain('menu');

    // No standard price and no location price: not sellable.
    await prisma.product.update({
      where: { id: productId },
      data: { basePrice: null },
    });
    expect(doneKeys(await checklist(owner))).not.toContain('menu');
    // A location price makes it sellable here.
    await api(
      'put',
      owner,
      `/catalog/locations/${location.id}/menus/${menuId}/products/${productId}/price-override`,
      { price: 500 },
    ).expect(200);
    expect(doneKeys(await checklist(owner))).toContain('menu');
    // Unavailable at this location: not sellable.
    await api(
      'put',
      owner,
      `/catalog/locations/${location.id}/menus/${menuId}/products/${productId}/availability-override`,
      { isAvailable: false },
    ).expect(200);
    expect(doneKeys(await checklist(owner))).not.toContain('menu');
    await api(
      'delete',
      owner,
      `/catalog/locations/${location.id}/menus/${menuId}/products/${productId}/availability-override`,
    ).expect(200);
    // Free is not "appropriately priced".
    await api(
      'put',
      owner,
      `/catalog/locations/${location.id}/menus/${menuId}/products/${productId}/price-override`,
      { price: 0 },
    ).expect(200);
    expect(doneKeys(await checklist(owner))).not.toContain('menu');
  });

  it('keeps online ordering OFF until setup and billing are done, then completes setup without publishing anything', async () => {
    const owner = await ownerBusiness('ordering');
    const location = await firstLocation(owner);
    const toggle = (on: boolean) =>
      api('patch', owner, `/locations/${location.id}/digital-ordering`, {
        isDigitalOrderingEnabled: on,
      });

    // No body at all: a clean 400, never a 500.
    await api(
      'patch',
      owner,
      `/locations/${location.id}/digital-ordering`,
    ).expect(400);

    let refused = (await toggle(true).expect(409))
      .body as LocationOrderingNotReadyBody;
    expect(refused).toMatchObject({
      code: 'LOCATION_ORDERING_NOT_READY',
      missing: ['billing', 'hours', 'menu'],
    });

    await api('put', owner, `/locations/${location.id}/hours`, week).expect(
      200,
    );
    await sellableMenu(owner, location.id);
    refused = (await toggle(true).expect(409))
      .body as LocationOrderingNotReadyBody;
    // Setup done, but payment setup is still pending: no setup action
    // bypasses billing.
    expect(refused.missing).toEqual(['billing']);
    expect(
      (await prisma.location.findUniqueOrThrow({ where: { id: location.id } }))
        .isDigitalOrderingEnabled,
    ).toBe(false);
    // Turning it off is always allowed.
    await toggle(false).expect(200);

    await authorizeBilling(owner);
    expect(doneKeys(await checklist(owner))).toEqual([
      'business',
      'billing',
      'location',
      'profile',
      'hours',
      'menu',
    ]);
    await toggle(true).expect(200);
    const done = await checklist(owner);
    expect(done).toMatchObject({
      completedCount: 7,
      setupComplete: true,
      locationId: location.id,
    });
    // Nothing else changed: the business's storefront routing is SC4f.
    expect(
      await prisma.tenant.findUniqueOrThrow({
        where: { id: owner.tenantId },
        select: { status: true },
      }),
    ).toEqual({ status: 'ACTIVE' });
  });

  it('leaves an operator-provisioned business free to turn ordering on as before', async () => {
    const tenant = await prisma.tenant.create({
      data: {
        slug: `sc4d-operator-${run}`,
        name: 'Operator Cafe',
        status: 'ACTIVE',
      },
    });
    const location = await prisma.location.create({
      data: {
        tenantId: tenant.id,
        name: 'Legacy',
        slug: 'legacy',
        isDigitalOrderingEnabled: false,
      },
    });
    const staff = await staffMember(tenant.id, 'operator-staff', [
      'locations.view',
      'locations.manage_digital_ordering',
      'locations.edit',
    ]);
    await api('patch', staff, `/locations/${location.id}/digital-ordering`, {
      isDigitalOrderingEnabled: true,
    }).expect(200);
    // A location without a time zone cannot take opening hours yet.
    const res = await api(
      'put',
      staff,
      `/locations/${location.id}/hours`,
      week,
    ).expect(400);
    expect((res.body as { message: string }).message).toMatch(/time zone/);
  });

  it('confines every location, hours and menu route to the business, and to corporate staff', async () => {
    const a = await ownerBusiness('iso-a');
    const b = await ownerBusiness('iso-b');
    const aLocation = await firstLocation(a);
    const bLocation = await firstLocation(b);
    const aMenu = await sellableMenu(a, aLocation.id);
    const bMenu = await sellableMenu(b, bLocation.id);
    const bOverride = `/catalog/locations/${bLocation.id}/menus/${bMenu.menuId}/products/${bMenu.productId}`;
    await api('put', b, `${bOverride}/price-override`, { price: 700 }).expect(
      200,
    );
    await api('put', b, `${bOverride}/availability-override`, {
      isAvailable: false,
    }).expect(200);

    // Owner A with B's ids: never reaches B's rows. Location-scoped checks
    // refuse a location outside the active business up front (403); the
    // corporate-only SC4d writes find no such location in it (404).
    await api('get', a, `/locations/${bLocation.id}`).expect(403);
    await api('patch', a, `/locations/${bLocation.id}/digital-ordering`, {
      isDigitalOrderingEnabled: false,
    }).expect(403);
    await api('put', a, `/locations/${bLocation.id}/profile`, profile()).expect(
      404,
    );
    await api('put', a, `/locations/${bLocation.id}/hours`, week).expect(404);
    await api('put', a, `/catalog/locations/${bLocation.id}/menu`, {
      menuId: aMenu.menuId,
    }).expect(404);
    await api('put', a, `/catalog/locations/${aLocation.id}/menu`, {
      menuId: bMenu.menuId,
    }).expect(400);
    // B's location menu and overrides (now also filtered by business in the
    // service, behind the same up-front refusal).
    await api('get', a, `/catalog/locations/${bLocation.id}/menu`).expect(403);
    await api('delete', a, `${bOverride}/price-override`).expect(403);
    await api('delete', a, `${bOverride}/availability-override`).expect(403);
    expect(
      (await prisma.location.findUniqueOrThrow({ where: { id: bLocation.id } }))
        .name,
    ).toBe('Harbor Street Cafe');
    expect(
      await prisma.locationProductPriceOverride.count({
        where: { locationId: bLocation.id },
      }),
    ).toBe(1);
    expect(
      await prisma.locationProductAvailabilityOverride.count({
        where: { locationId: bLocation.id },
      }),
    ).toBe(1);
    // A's own still work.
    await api('get', a, `/catalog/locations/${aLocation.id}/menu`).expect(200);

    // Owner A pointed at business B (X-Tenant-Id) is not admitted at all.
    await http()
      .get('/api/v1/admin/getting-started')
      .set('Authorization', `Bearer ${token(a.email)}`)
      .set('X-Tenant-Id', b.tenantId)
      .expect((res) => expect([401, 403]).toContain(res.status));

    // Each checklist is the business's own.
    expect((await checklist(a)).locationId).toBe(aLocation.id);
    expect((await checklist(b)).locationId).toBe(bLocation.id);
    expect(
      await prisma.locationOpeningPeriod.count({
        where: { tenantId: b.tenantId },
      }),
    ).toBe(0);

    // Location-scoped staff of A: no business-wide setup.
    const manager = await staffMember(
      a.tenantId,
      'iso-manager',
      [
        'locations.view',
        'locations.edit',
        'locations.create',
        'catalog.menu.manage',
      ],
      aLocation.id,
    );
    await api('get', manager, '/getting-started').expect(403);
    await api('post', manager, '/locations', profile()).expect(403);
    await api('put', manager, `/locations/${aLocation.id}/hours`, week).expect(
      403,
    );
    await api('post', manager, '/catalog/menus', { name: 'Sneaky' }).expect(
      403,
    );
    // Corporate staff without locations.create cannot create one.
    const editor = await staffMember(a.tenantId, 'iso-editor', [
      'locations.view',
      'locations.edit',
    ]);
    await api('post', editor, '/locations', profile()).expect(403);
  });

  // A staff member of `tenantId` holding `permissions` (corporate, or at one
  // location).
  async function staffMember(
    tenantId: string,
    key: string,
    permissions: string[],
    locationId?: string,
  ): Promise<Owner> {
    const email = emailOf(key);
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${email}`,
        email,
        displayName: key,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    const role = await prisma.internalRole.create({
      data: {
        tenantId,
        key: `sc4d-${key}-${run}`,
        displayName: key,
        permissions: {
          create: permissions.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId,
        internalUserId: user.id,
        roleId: role.id,
        scopeType: locationId ? 'LOCATION' : 'CORPORATE',
        scopeId: locationId ?? null,
      },
    });
    return { email, tenantId };
  }
});
