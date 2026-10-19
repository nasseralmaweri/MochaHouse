import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  STOREFRONT_HOST_HEADER,
  STOREFRONT_HOST_SIGNATURE_HEADER,
  STOREFRONT_HOST_TIMESTAMP_HEADER,
} from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  TEST_TENANT_B_NAME,
  createTestTenantB,
  removeTestTenantB,
  removeFinancialHoldsForTest,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { RedisModule } from '../redis/redis.module';
import { TenancyModule } from './tenancy.module';
import { LocationsModule } from '../locations/locations.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { CustomersModule } from '../customers/customers.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { OrdersModule } from '../orders/orders.module';
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';
import { signStorefrontContext } from './storefront-context';

// SC4f-2 — one CENTERIVO login, a separate profile per restaurant, end to
// end over HTTP through one API serving two restaurants by their signed
// storefront hostname (SC4f-1 host routing on). Covers: one login at two
// restaurants; separate balances, consent and saved locations; no linking
// by email; cross-restaurant token use; restricted and deactivated profiles
// (no bypass through joining again or a guest fallback); and the
// single-business deployment (routing off) unchanged for existing Mocha
// House customers.
describe('SC4f-2 customer profiles per restaurant (integration)', () => {
  let hostsApp: INestApplication<App>;
  let legacyApp: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const suffix = randomUUID().slice(0, 8);
  const storefrontSecret = `sc4f2-storefront-secret-${'x'.repeat(24)}`;
  const customerSecret = 'sc4f2-customer-secret';
  const HOST_A = `mocha-${suffix}.shop.test`;
  const HOST_B = `bravo-${suffix}.shop.test`;
  const createdSubjects: string[] = [];
  const createdLocationIds: string[] = [];
  let locationA: string;

  async function buildApi(hostRouting: boolean) {
    process.env.STOREFRONT_HOST_ROUTING_ENABLED = hostRouting ? '1' : '0';
    const moduleFixture = await Test.createTestingModule({
      imports: [
        PrismaModule,
        RedisModule,
        TenancyModule,
        LocationsModule,
        CatalogModule,
        CustomerAuthModule,
        InternalAuthModule,
        CustomersModule,
        LoyaltyModule,
        OrdersModule,
      ],
    }).compile();
    const app = moduleFixture.createNestApplication<INestApplication<App>>();
    await app.init();
    return app;
  }

  type Login = { subject: string; email: string; token: string };
  // The response fields these tests read.
  type Body = {
    id: string;
    status: string;
    balance: number;
    created: boolean;
    profile: { id: string; status: string };
  };
  const bodyOf = (res: { body: unknown }) => res.body as Body;
  const login = (label: string, email?: string): Login => {
    const subject = `dev:sc4f2-${label}-${suffix}`;
    createdSubjects.push(subject);
    const address = email ?? `sc4f2-${label}-${suffix}@example.com`;
    return {
      subject,
      email: address,
      token: signDevJwt(
        {
          sub: subject,
          email: address,
          name: `SC4f2 ${label}`,
          emailVerified: true,
        },
        customerSecret,
        3600,
      ),
    };
  };
  const at = (hostname: string) => {
    const seconds = Math.floor(Date.now() / 1000);
    return {
      [STOREFRONT_HOST_HEADER]: hostname,
      [STOREFRONT_HOST_TIMESTAMP_HEADER]: String(seconds),
      [STOREFRONT_HOST_SIGNATURE_HEADER]: signStorefrontContext(
        storefrontSecret,
        hostname,
        seconds,
      ),
    };
  };
  const call = (
    method: 'get' | 'post' | 'patch' | 'delete',
    host: string,
    path: string,
    who: Login,
  ) =>
    request(hostsApp.getHttpServer())
      [method](`/api/v1${path}`)
      .set(at(host))
      .set('Authorization', `Bearer ${who.token}`);
  const join = (host: string, who: Login) =>
    call('post', host, '/customers/me/enrollment', who).send({});
  const profileAt = (tenantId: string, who: Login) =>
    prisma.customer.findUnique({
      where: {
        tenantId_externalProvider_externalSubject: {
          tenantId,
          externalProvider: 'dev',
          externalSubject: who.subject,
        },
      },
    });
  const setStatus = async (
    tenantId: string,
    who: Login,
    status: 'ACTIVE' | 'RESTRICTED' | 'DEACTIVATED',
  ) => {
    const profile = await profileAt(tenantId, who);
    await prisma.customer.update({
      where: { id: profile!.id },
      data: { status },
    });
  };
  // A shape-valid checkout: the profile is checked before anything is
  // priced or charged (the location does not exist, so an allowed customer
  // — or a guest — gets 404 instead).
  const checkout = (host: string, who: Login | null) => {
    const req = request(hostsApp.getHttpServer())
      .post('/api/v1/orders')
      .set(at(host));
    if (who) req.set('Authorization', `Bearer ${who.token}`);
    // ESP-03 PR 6 — no payment key: the profile and location are checked
    // before the checkout session (the location does not exist).
    return req.send({
      locationId: randomUUID(),
      guest: { name: 'Guest', phone: '5550000000', email: null },
      lines: [{ productId: randomUUID(), quantity: 1, selections: [] }],
    });
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.SINGLE_TENANT_ID = TENANT_1_MOCHA_HOUSE_ID;
    process.env.STOREFRONT_CONTEXT_SECRET = storefrontSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = customerSecret;
    legacyApp = await buildApi(false);
    prisma = legacyApp.get(PrismaService);
    await createTestTenantB(prisma);
    hostsApp = await buildApi(true);

    const now = new Date();
    await prisma.storefrontHost.createMany({
      data: [
        {
          hostname: HOST_A,
          storefrontTenantId: TENANT_1_MOCHA_HOUSE_ID,
          kind: 'LEGACY',
          published: true,
          publishedAt: now,
        },
        {
          hostname: HOST_B,
          storefrontTenantId: TEST_TENANT_B_ID,
          kind: 'PLATFORM_SUBDOMAIN',
          published: true,
          publishedAt: now,
        },
      ],
    });
    const location = await prisma.location.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        name: `SC4f2 Store ${suffix}`,
        slug: `sc4f2-store-${suffix}`,
      },
      select: { id: true },
    });
    locationA = location.id;
    createdLocationIds.push(location.id);
  });

  afterAll(async () => {
    try {
      // ESP-03 PR 8 — financial holds reference the promotions, gift cards
      // and customers removed below (test-only removal).
      await removeFinancialHoldsForTest({
        tenantIds: [TENANT_1_MOCHA_HOUSE_ID],
      });
      await prisma.customer.deleteMany({
        where: { externalSubject: { in: createdSubjects } },
      });
      await prisma.location.deleteMany({
        where: { id: { in: createdLocationIds } },
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'SET LOCAL session_replication_role = replica',
        );
        await tx.storefrontHost.deleteMany({
          where: { hostname: { in: [HOST_A, HOST_B] } },
        });
      });
      await removeTestTenantB(prisma);
    } finally {
      await hostsApp?.close();
      await legacyApp?.close();
      process.env = { ...originalEnv };
    }
  });

  it('one login joins two restaurants and gets a separate profile at each', async () => {
    const ana = login('two');
    const a = await join(HOST_A, ana).expect(201);
    const b = await join(HOST_B, ana).expect(201);
    expect(bodyOf(a).profile.id).not.toBe(bodyOf(b).profile.id);

    const meA = await call('get', HOST_A, '/customers/me', ana).expect(200);
    const meB = await call('get', HOST_B, '/customers/me', ana).expect(200);
    expect(bodyOf(meA).id).toBe(bodyOf(a).profile.id);
    expect(bodyOf(meB).id).toBe(bodyOf(b).profile.id);
    expect((await profileAt(TENANT_1_MOCHA_HOUSE_ID, ana))!.id).toBe(
      bodyOf(a).profile.id,
    );
    expect((await profileAt(TEST_TENANT_B_ID, ana))!.id).toBe(
      bodyOf(b).profile.id,
    );
  });

  it('keeps balances, consent and saved locations separate per restaurant', async () => {
    const ben = login('separate');
    await join(HOST_A, ben).expect(201);
    await join(HOST_B, ben).expect(201);
    const pA = (await profileAt(TENANT_1_MOCHA_HOUSE_ID, ben))!;
    const pB = (await profileAt(TEST_TENANT_B_ID, ben))!;
    await prisma.customerLoyaltyAccount.createMany({
      data: [
        { tenantId: TENANT_1_MOCHA_HOUSE_ID, customerId: pA.id, balance: 120 },
        { tenantId: TEST_TENANT_B_ID, customerId: pB.id, balance: 7 },
      ],
    });

    const loyaltyA = await call('get', HOST_A, '/customers/me/loyalty', ben);
    const loyaltyB = await call('get', HOST_B, '/customers/me/loyalty', ben);
    expect(loyaltyA.status).toBe(200);
    expect(loyaltyB.status).toBe(200);
    expect(bodyOf(loyaltyA).balance).toBe(120);
    expect(bodyOf(loyaltyB).balance).toBe(7);

    await call('patch', HOST_A, '/customers/me/preferences', ben)
      .send({ marketingEmailOptIn: true })
      .expect(200);
    const prefsB = await call('get', HOST_B, '/customers/me/preferences', ben);
    expect(prefsB.body).toEqual({ marketingEmailOptIn: false });

    await call('post', HOST_A, '/customers/me/locations', ben)
      .send({ locationId: locationA })
      .expect(201);
    const savedB = await call('get', HOST_B, '/customers/me/locations', ben);
    expect(savedB.status).toBe(200);
    expect(JSON.stringify(savedB.body)).not.toContain(locationA);
    // B cannot save A's location either.
    await call('post', HOST_B, '/customers/me/locations', ben)
      .send({ locationId: locationA })
      .expect(404);
  });

  it('a token for a login that only joined one restaurant gets nothing of it at another', async () => {
    const cleo = login('crossed');
    await join(HOST_A, cleo).expect(201);
    const pA = (await profileAt(TENANT_1_MOCHA_HOUSE_ID, cleo))!;

    for (const path of [
      '/customers/me',
      '/customers/me/loyalty',
      '/customers/me/orders',
      '/customers/me/preferences',
      '/customers/me/locations',
    ]) {
      const res = await call('get', HOST_B, path, cleo);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: 'CUSTOMER_NOT_ENROLLED',
        businessName: TEST_TENANT_B_NAME,
      });
      expect(JSON.stringify(res.body)).not.toContain(pA.id);
    }
    const order = await checkout(HOST_B, cleo);
    expect(order.status).toBe(403);
    expect(order.body).toMatchObject({ code: 'CUSTOMER_NOT_ENROLLED' });
    expect(await profileAt(TEST_TENANT_B_ID, cleo)).toBeNull();
  });

  it('never links two logins that share an email address', async () => {
    const shared = `sc4f2-shared-${suffix}@example.com`;
    const first = login('email-1', shared);
    const second = login('email-2', shared);
    await join(HOST_A, first).expect(201);

    // The second login, same email, is not the first one's profile.
    const res = await call('get', HOST_A, '/customers/me', second);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'CUSTOMER_NOT_ENROLLED' });

    const joined = await join(HOST_A, second).expect(201);
    const firstProfile = (await profileAt(TENANT_1_MOCHA_HOUSE_ID, first))!;
    expect(bodyOf(joined).profile.id).not.toBe(firstProfile.id);
  });

  it('a RESTRICTED profile can read and manage consent, but cannot order or change anything — at that restaurant only', async () => {
    const dana = login('restricted');
    await join(HOST_A, dana).expect(201);
    await join(HOST_B, dana).expect(201);
    await setStatus(TENANT_1_MOCHA_HOUSE_ID, dana, 'RESTRICTED');

    const me = await call('get', HOST_A, '/customers/me', dana).expect(200);
    expect(bodyOf(me).status).toBe('RESTRICTED');
    await call('get', HOST_A, '/customers/me/loyalty', dana).expect(200);
    await call('get', HOST_A, '/customers/me/orders', dana).expect(200);
    await call('patch', HOST_A, '/customers/me/preferences', dana)
      .send({ marketingEmailOptIn: false })
      .expect(200);
    // Opting in is a change like any other: refused.
    const optIn = await call(
      'patch',
      HOST_A,
      '/customers/me/preferences',
      dana,
    ).send({
      marketingEmailOptIn: true,
    });
    expect(optIn.status).toBe(403);
    expect(optIn.body).toMatchObject({ code: 'CUSTOMER_ACCOUNT_RESTRICTED' });

    for (const res of [
      await call('patch', HOST_A, '/customers/me', dana).send({
        displayName: 'x',
      }),
      await call('post', HOST_A, '/customers/me/locations', dana).send({
        locationId: locationA,
      }),
      await checkout(HOST_A, dana),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'CUSTOMER_ACCOUNT_RESTRICTED' });
    }

    // Joining again changes nothing: the restriction stays.
    const again = await join(HOST_A, dana).expect(200);
    expect(again.body).toMatchObject({
      created: false,
      profile: { status: 'RESTRICTED' },
    });

    // The same login is unaffected at the other restaurant.
    await call('patch', HOST_B, '/customers/me', dana)
      .send({ displayName: 'Fine at B' })
      .expect(200);
    expect((await checkout(HOST_B, dana)).status).toBe(404);
  });

  it('a DEACTIVATED profile sees only its own profile and can withdraw consent — at that restaurant only', async () => {
    const eli = login('deactivated');
    await join(HOST_A, eli).expect(201);
    await join(HOST_B, eli).expect(201);
    await setStatus(TENANT_1_MOCHA_HOUSE_ID, eli, 'DEACTIVATED');

    const me = await call('get', HOST_A, '/customers/me', eli).expect(200);
    expect(bodyOf(me).status).toBe('DEACTIVATED');
    await call('patch', HOST_A, '/customers/me/preferences', eli)
      .send({ marketingEmailOptIn: false })
      .expect(200);

    for (const res of [
      await call('get', HOST_A, '/customers/me/loyalty', eli),
      await call('get', HOST_A, '/customers/me/orders', eli),
      await call('get', HOST_A, '/customers/me/locations', eli),
      await call('patch', HOST_A, '/customers/me/preferences', eli).send({
        marketingEmailOptIn: true,
      }),
      await checkout(HOST_A, eli),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'CUSTOMER_ACCOUNT_UNAVAILABLE' });
    }
    const again = await join(HOST_A, eli).expect(200);
    expect(bodyOf(again).profile.status).toBe('DEACTIVATED');

    await call('get', HOST_B, '/customers/me/loyalty', eli).expect(200);
  });

  it('a signed-in checkout never falls back to a guest order; a guest is unaffected', async () => {
    const fay = login('no-fallback');
    await join(HOST_A, fay).expect(201);
    await setStatus(TENANT_1_MOCHA_HOUSE_ID, fay, 'RESTRICTED');
    const signedIn = await checkout(HOST_A, fay);
    expect(signedIn.status).toBe(403);
    // A guest (no token) reaches pricing — and finds no such location.
    expect((await checkout(HOST_A, null)).status).toBe(404);
    // An expired session for the same restricted login is refused, never
    // turned into a guest order.
    const expired: Login = {
      ...fay,
      token: signDevJwt(
        { sub: fay.subject, email: fay.email, name: null, emailVerified: true },
        customerSecret,
        -60,
      ),
    };
    const stale = await checkout(HOST_A, expired);
    expect(stale.status).toBe(401);
    expect(
      await prisma.order.count({
        where: {
          customerId: (await profileAt(TENANT_1_MOCHA_HOUSE_ID, fay))!.id,
        },
      }),
    ).toBe(0);
  });

  it('with routing off, an existing Mocha House customer signs in exactly as before', async () => {
    const gus = login('legacy');
    await join(HOST_A, gus).expect(201);
    const existing = (await profileAt(TENANT_1_MOCHA_HOUSE_ID, gus))!;

    const me = await request(legacyApp.getHttpServer())
      .get('/api/v1/customers/me')
      .set('Authorization', `Bearer ${gus.token}`)
      .expect(200);
    expect(bodyOf(me).id).toBe(existing.id);
    // Storefront headers for another restaurant change nothing there.
    const ignored = await request(legacyApp.getHttpServer())
      .get('/api/v1/customers/me')
      .set(at(HOST_B))
      .set('Authorization', `Bearer ${gus.token}`)
      .expect(200);
    expect(bodyOf(ignored).id).toBe(existing.id);
  });
});
