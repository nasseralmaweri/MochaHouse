import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { LocationSummary } from '@mocha-house/contracts';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomerAuthModule } from '../../customer-auth/customer-auth.module';
import { signDevJwt } from '../../customer-auth/infrastructure/dev-jwt';
import { CustomersModule } from '../customers.module';

// Full HTTP integration test for the Milestone 4F preferred-locations
// surface: CustomerAuthGuard + CustomerPreferredLocationsController +
// service, wired exactly as AppModule wires CustomersModule.
describe('CustomerPreferredLocationsController (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const devSecret = 'preferred-locations-spec-secret';

  let activeLocationId: string;
  let activeNoDigitalLocationId: string;
  let inactiveLocationId: string;
  const locationIds: string[] = [];

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = devSecret;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, CustomerAuthModule, CustomersModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    await prisma.$connect();

    const tag = randomUUID().slice(0, 8);
    const active = await prisma.location.create({
      data: {
        name: `4F Active ${tag}`,
        slug: `4f-active-${tag}`,
        isActive: true,
        isDigitalOrderingEnabled: true,
      },
    });
    const activeNoDigital = await prisma.location.create({
      data: {
        name: `4F Active NoDigital ${tag}`,
        slug: `4f-active-nodigital-${tag}`,
        isActive: true,
        isDigitalOrderingEnabled: false,
      },
    });
    const inactive = await prisma.location.create({
      data: {
        name: `4F Inactive ${tag}`,
        slug: `4f-inactive-${tag}`,
        isActive: false,
        isDigitalOrderingEnabled: true,
      },
    });
    activeLocationId = active.id;
    activeNoDigitalLocationId = activeNoDigital.id;
    inactiveLocationId = inactive.id;
    locationIds.push(active.id, activeNoDigital.id, inactive.id);
  });

  afterEach(async () => {
    await prisma.customerPreferredLocation.deleteMany({
      where: { location: { id: { in: locationIds } } },
    });
  });

  afterAll(async () => {
    await prisma.customerPreferredLocation.deleteMany({
      where: { location: { id: { in: locationIds } } },
    });
    await prisma.customer.deleteMany({
      where: {
        externalProvider: 'dev',
        externalSubject: { startsWith: 'dev:test-4f-' },
      },
    });
    await prisma.location.deleteMany({ where: { id: { in: locationIds } } });
    await app.close();
    await prisma.$disconnect();
    process.env = { ...originalEnv };
  });

  function token(): string {
    const identifier = `test-4f-${randomUUID()}@example.com`;
    return signDevJwt(
      { sub: `dev:${identifier}`, email: identifier, name: null },
      devSecret,
      3600,
    );
  }

  const base = '/api/v1/customers/me/locations';

  it('rejects unauthenticated GET / POST / DELETE with 401', async () => {
    await request(app.getHttpServer()).get(base).expect(401);
    await request(app.getHttpServer())
      .post(base)
      .send({ locationId: activeLocationId })
      .expect(401);
    await request(app.getHttpServer())
      .delete(`${base}/${activeLocationId}`)
      .expect(401);
  });

  it('rejects a malformed / expired bearer token with 401', async () => {
    await request(app.getHttpServer())
      .get(base)
      .set('Authorization', 'Bearer nope')
      .expect(401);

    const expired = signDevJwt(
      { sub: 'dev:x', email: 'x@example.com', name: null },
      devSecret,
      -10,
    );
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', `Bearer ${expired}`)
      .send({ locationId: activeLocationId })
      .expect(401);
  });

  it('starts empty, adds a valid active location, and the list reflects it', async () => {
    const t = token();

    const empty = await request(app.getHttpServer())
      .get(base)
      .set('Authorization', `Bearer ${t}`)
      .expect(200);
    expect(empty.body).toEqual([]);

    const added = await request(app.getHttpServer())
      .post(base)
      .set('Authorization', `Bearer ${t}`)
      .send({ locationId: activeLocationId })
      .expect(201);
    const body = added.body as LocationSummary[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(activeLocationId);
    expect(body[0].isDigitalOrderingEnabled).toBe(true);

    const list = await request(app.getHttpServer())
      .get(base)
      .set('Authorization', `Bearer ${t}`)
      .expect(200);
    expect((list.body as LocationSummary[]).map((l) => l.id)).toEqual([
      activeLocationId,
    ]);
  });

  it('a duplicate add stays a single association', async () => {
    const t = token();
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', `Bearer ${t}`)
      .send({ locationId: activeLocationId })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post(base)
      .set('Authorization', `Bearer ${t}`)
      .send({ locationId: activeLocationId })
      .expect(201);
    expect(second.body as LocationSummary[]).toHaveLength(1);
  });

  it('can save an active location that has digital ordering disabled (orderability is decided later, at order time)', async () => {
    const t = token();
    const res = await request(app.getHttpServer())
      .post(base)
      .set('Authorization', `Bearer ${t}`)
      .send({ locationId: activeNoDigitalLocationId })
      .expect(201);
    const body = res.body as LocationSummary[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(activeNoDigitalLocationId);
    expect(body[0].isDigitalOrderingEnabled).toBe(false);
  });

  it('rejects a nonexistent location id with 404 and saves nothing', async () => {
    const t = token();
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', `Bearer ${t}`)
      .send({ locationId: `does-not-exist-${randomUUID()}` })
      .expect(404);

    const list = await request(app.getHttpServer())
      .get(base)
      .set('Authorization', `Bearer ${t}`)
      .expect(200);
    expect(list.body).toEqual([]);
  });

  it('rejects an inactive location as not available to save', async () => {
    const t = token();
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', `Bearer ${t}`)
      .send({ locationId: inactiveLocationId })
      .expect(404);
  });

  it('rejects a missing / blank locationId with 400', async () => {
    const t = token();
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', `Bearer ${t}`)
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', `Bearer ${t}`)
      .send({ locationId: '   ' })
      .expect(400);
  });

  it('removes a preferred location without deleting the Location, and is idempotent', async () => {
    const t = token();
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', `Bearer ${t}`)
      .send({ locationId: activeLocationId })
      .expect(201);

    const afterRemove = await request(app.getHttpServer())
      .delete(`${base}/${activeLocationId}`)
      .set('Authorization', `Bearer ${t}`)
      .expect(200);
    expect(afterRemove.body).toEqual([]);

    // The underlying Location still exists.
    const stillThere = await prisma.location.findUnique({
      where: { id: activeLocationId },
    });
    expect(stillThere).not.toBeNull();

    // Removing again (already absent) is a predictable no-op.
    const secondRemove = await request(app.getHttpServer())
      .delete(`${base}/${activeLocationId}`)
      .set('Authorization', `Bearer ${t}`)
      .expect(200);
    expect(secondRemove.body).toEqual([]);
  });

  it('customer A cannot read, add to, or remove from customer B', async () => {
    const a = token();
    const b = token();

    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', `Bearer ${b}`)
      .send({ locationId: activeLocationId })
      .expect(201);

    // A's list is unaffected by B's preference.
    const aList = await request(app.getHttpServer())
      .get(base)
      .set('Authorization', `Bearer ${a}`)
      .expect(200);
    expect(aList.body).toEqual([]);

    // A removing "the same location id" only touches A's (empty) set — B keeps theirs.
    await request(app.getHttpServer())
      .delete(`${base}/${activeLocationId}`)
      .set('Authorization', `Bearer ${a}`)
      .expect(200);

    const bList = await request(app.getHttpServer())
      .get(base)
      .set('Authorization', `Bearer ${b}`)
      .expect(200);
    expect((bList.body as LocationSummary[]).map((l) => l.id)).toEqual([
      activeLocationId,
    ]);
  });

  it('returns authoritative current location data (name reflects the live Location row)', async () => {
    const t = token();
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', `Bearer ${t}`)
      .send({ locationId: activeLocationId })
      .expect(201);

    await prisma.location.update({
      where: { id: activeLocationId },
      data: { name: '4F Active RENAMED' },
    });

    const list = await request(app.getHttpServer())
      .get(base)
      .set('Authorization', `Bearer ${t}`)
      .expect(200);
    expect((list.body as LocationSummary[])[0].name).toBe('4F Active RENAMED');

    await prisma.location.update({
      where: { id: activeLocationId },
      data: { name: `4F Active` },
    });
  });
});
