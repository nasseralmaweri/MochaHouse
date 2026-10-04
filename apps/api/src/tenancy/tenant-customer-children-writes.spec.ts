import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { LocationSummary } from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
  tenantContextFor,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { CustomersModule } from '../customers/customers.module';
import { CrmModule } from '../crm/crm.module';
import { CustomersService } from '../customers/application/customers.service';
import { CustomerPreferredLocationsService } from '../customers/application/customer-preferred-locations.service';
import { CustomerNotesService } from '../crm/application/customer-notes.service';
import { AuthorizationContext } from '../internal-auth/authorization/authorization-context';
import type { CustomerIdentity } from '../customer-auth/infrastructure/customer-identity';
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';

// Milestone S0D-2B-2 — CustomerPreferredLocation and CustomerNote take their
// tenant ONLY from the tenant-validated parent Customer (never from client
// input), a preferred location can never join a Customer and a Location of
// different tenants, and another tenant's Location / Customer is reported
// exactly like a missing one.
describe('S0D-2B-2 customer child tenant ownership (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let customers: CustomersService;
  let preferred: CustomerPreferredLocationsService;
  let notes: CustomerNotesService;
  const originalEnv = { ...process.env };
  const customerSecret = 's0d2b2-customer-secret';
  const internalSecret = 's0d2b2-internal-secret';
  const suffix = randomUUID().slice(0, 8);

  const tenantOne = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);
  const tenantB = tenantContextFor(TEST_TENANT_B_ID);
  const corporate = [{ scopeType: 'CORPORATE' as const, scopeId: null }];
  const notesAuthorization = AuthorizationContext.of({
    'customers.view': corporate,
    'customers.notes.manage': corporate,
  });

  const createdSubjects: string[] = [];
  const customerIds: string[] = [];
  const locationIds: string[] = [];
  const userIds: string[] = [];
  const roleIds: string[] = [];

  // Tenant #1 fixtures
  let t1Location: string;
  let t1InactiveLocation: string;
  // Tenant B fixtures (test-only tenant)
  let bLocation: string;
  let bCustomer: { id: string; tenantId: string };
  let notesUser: string;

  const identity = (label: string): CustomerIdentity => {
    const subject = `dev:s0d2b2-${label}-${suffix}`;
    createdSubjects.push(subject);
    return {
      provider: 'dev',
      subject,
      email: `s0d2b2-${label}-${suffix}@example.com`,
      name: `S0D2B2 ${label}`,
      emailVerified: true,
    };
  };
  const customerToken = (id: CustomerIdentity) =>
    signDevJwt(
      { sub: id.subject, email: id.email!, name: id.name },
      customerSecret,
      3600,
    );
  const internalToken = (key: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${key}`, email: `${key}@example.com`, name: null },
      internalSecret,
      3600,
    );

  async function makeLocation(
    tenantId: string,
    label: string,
    isActive = true,
  ): Promise<string> {
    const location = await prisma.location.create({
      data: {
        tenantId,
        name: `S0D2B2 ${label} ${suffix}`,
        slug: `s0d2b2-${label}-${suffix}`,
        isActive,
      },
    });
    locationIds.push(location.id);
    return location.id;
  }

  async function makeCustomer(tenantId: string, label: string) {
    const customer = await prisma.customer.create({
      data: {
        tenantId,
        externalProvider: 's0d2b2-spec',
        externalSubject: `s0d2b2-${label}-${suffix}`,
      },
    });
    customerIds.push(customer.id);
    return customer;
  }

  async function makeInternalUser(
    key: string,
    permissionKeys: string[],
  ): Promise<string> {
    const user = await prisma.internalUser.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${key}`,
        email: `${key}@example.com`,
        displayName: key,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(user.id);
    const role = await prisma.internalRole.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        key: `s0d2b2-${key}`,
        displayName: key,
        permissions: {
          create: permissionKeys.map((permissionKey) => ({ permissionKey, tenantId: TENANT_1_MOCHA_HOUSE_ID })),
        },
      },
    });
    roleIds.push(role.id);
    await prisma.internalUserRoleAssignment.create({
      data: {
        internalUserId: user.id,
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        roleId: role.id,
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });
    return user.id;
  }

  const addLocationReq = (id: CustomerIdentity, body: object) =>
    request(app.getHttpServer())
      .post('/api/v1/customers/me/locations')
      .set('Authorization', `Bearer ${customerToken(id)}`)
      .send(body);

  const addNoteReq = (key: string, customerId: string, body: object) =>
    request(app.getHttpServer())
      .post(`/api/v1/admin/customers/${customerId}/notes`)
      .set('Authorization', `Bearer ${internalToken(key)}`)
      .send(body);

  const byIdentity = (id: CustomerIdentity) =>
    prisma.customer.findUniqueOrThrow({
      where: {
        externalProvider_externalSubject: {
          externalProvider: id.provider,
          externalSubject: id.subject,
        },
      },
    });

  const auditCountFor = (customerId: string) =>
    prisma.internalAuditEvent.count({
      where: { targetType: 'customer', targetId: customerId },
    });

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = customerSecret;
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.GIFT_CARD_CODE_SECRET = 's0d2b2-gift-card-code-secret';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        CustomersModule,
        CrmModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    customers = moduleRef.get(CustomersService);
    preferred = moduleRef.get(CustomerPreferredLocationsService);
    notes = moduleRef.get(CustomerNotesService);

    await createTestTenantB(prisma);
    t1Location = await makeLocation(TENANT_1_MOCHA_HOUSE_ID, 't1');
    t1InactiveLocation = await makeLocation(
      TENANT_1_MOCHA_HOUSE_ID,
      't1-inactive',
      false,
    );
    bLocation = await makeLocation(TEST_TENANT_B_ID, 'b');
    bCustomer = await makeCustomer(TEST_TENANT_B_ID, 'b-customer');
    notesUser = await makeInternalUser(`notes-${suffix}`, [
      'customers.view',
      'customers.notes.manage',
    ]);
    await makeInternalUser(`viewer-${suffix}`, ['customers.view']);
  });

  afterAll(async () => {
    const jitCustomers = await prisma.customer.findMany({
      where: { externalSubject: { in: createdSubjects } },
      select: { id: true },
    });
    const allCustomerIds = [...customerIds, ...jitCustomers.map((c) => c.id)];
    await prisma.internalAuditEvent.deleteMany({
      where: { targetType: 'customer', targetId: { in: allCustomerIds } },
    });
    await prisma.customerNote.deleteMany({
      where: { customerId: { in: allCustomerIds } },
    });
    await prisma.customerPreferredLocation.deleteMany({
      where: {
        OR: [
          { customerId: { in: allCustomerIds } },
          { locationId: { in: locationIds } },
        ],
      },
    });
    await prisma.customer.deleteMany({ where: { id: { in: allCustomerIds } } });
    await prisma.location.deleteMany({ where: { id: { in: locationIds } } });
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIds } },
    });
    await prisma.internalRolePermission.deleteMany({
      where: { roleId: { in: roleIds } },
    });
    await prisma.internalRole.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    await removeTestTenantB(prisma);
    await app.close();
    process.env = { ...originalEnv };
  });

  describe('CustomerPreferredLocation', () => {
    it('a Tenant #1 Customer saving a Tenant #1 Location persists Tenant #1, whatever tenant the client claims', async () => {
      const id = identity('pl-owner');

      const response = await addLocationReq(id, {
        locationId: t1Location,
        tenantId: TEST_TENANT_B_ID,
      })
        .query({ tenantId: TEST_TENANT_B_ID })
        .set('x-tenant-id', TEST_TENANT_B_ID)
        .expect(201);

      const customer = await byIdentity(id);
      const row = await prisma.customerPreferredLocation.findUniqueOrThrow({
        where: {
          customerId_locationId: {
            customerId: customer.id,
            locationId: t1Location,
          },
        },
      });
      expect(row.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
      expect(customer.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
      // Ownership is not exposed through the customer-facing contract.
      expect(JSON.stringify(response.body)).not.toContain('tenantId');

      // A repeat add stays idempotent and keeps the same owner.
      await addLocationReq(id, { locationId: t1Location }).expect(201);
      expect(
        await prisma.customerPreferredLocation.count({
          where: { customerId: customer.id },
        }),
      ).toBe(1);
    });

    it('a Tenant #1 Customer cannot attach a Tenant B Location: same 404 as a missing or inactive one, and no row', async () => {
      const id = identity('pl-foreign');

      const foreign = await addLocationReq(id, {
        locationId: bLocation,
      }).expect(404);
      const missing = await addLocationReq(id, {
        locationId: randomUUID(),
      }).expect(404);
      const inactive = await addLocationReq(id, {
        locationId: t1InactiveLocation,
      }).expect(404);

      expect(foreign.body).toEqual(missing.body);
      expect(foreign.body).toEqual(inactive.body);
      expect(JSON.stringify(foreign.body)).not.toContain(bLocation);
      expect(JSON.stringify(foreign.body)).not.toContain(TEST_TENANT_B_ID);

      const customer = await byIdentity(id);
      expect(
        await prisma.customerPreferredLocation.count({
          where: { customerId: customer.id },
        }),
      ).toBe(0);
      expect(
        await prisma.customerPreferredLocation.count({
          where: { locationId: bLocation, customerId: customer.id },
        }),
      ).toBe(0);
    });

    it('Tenant B structural equivalent: a Tenant B Customer + Tenant B Location persists Tenant B', async () => {
      const bJit = await customers.resolveOrCreateFromIdentity(
        identity('pl-b-owner'),
        tenantB,
      );
      await preferred.addForCustomer(bJit, bLocation, tenantB);

      const row = await prisma.customerPreferredLocation.findUniqueOrThrow({
        where: {
          customerId_locationId: {
            customerId: bJit.id,
            locationId: bLocation,
          },
        },
      });
      expect(row.tenantId).toBe(TEST_TENANT_B_ID);
    });

    it('a Tenant B Customer cannot attach a Tenant #1 Location under its own context', async () => {
      await expect(
        preferred.addForCustomer(bCustomer, t1Location, tenantB),
      ).rejects.toThrow(
        new NotFoundException('That location is not available to save.'),
      );
      expect(
        await prisma.customerPreferredLocation.count({
          where: { customerId: bCustomer.id },
        }),
      ).toBe(0);
    });

    it('re-asserts Customer ownership: a Customer from another tenant is refused before any lookup or write', async () => {
      await expect(
        preferred.addForCustomer(bCustomer, bLocation, tenantOne),
      ).rejects.toThrow(NotFoundException);
      expect(
        await prisma.customerPreferredLocation.count({
          where: { customerId: bCustomer.id },
        }),
      ).toBe(0);
    });

    it("remove stays limited to the caller's own rows and never exposes another tenant's", async () => {
      // A Tenant B customer's saved Tenant B location.
      const bOwner = await customers.resolveOrCreateFromIdentity(
        identity('pl-b-remove'),
        tenantB,
      );
      await preferred.addForCustomer(bOwner, bLocation, tenantB);

      const id = identity('pl-remover');
      await addLocationReq(id, { locationId: t1Location }).expect(201);

      const response = await request(app.getHttpServer())
        .delete(`/api/v1/customers/me/locations/${bLocation}`)
        .set('Authorization', `Bearer ${customerToken(id)}`)
        .set('x-tenant-id', TEST_TENANT_B_ID)
        .expect(200);

      const remaining = response.body as LocationSummary[];
      expect(remaining.map((l) => l.id)).toEqual([t1Location]);
      expect(JSON.stringify(response.body)).not.toContain(bLocation);
      // Tenant B's row is untouched.
      expect(
        await prisma.customerPreferredLocation.count({
          where: { customerId: bOwner.id, locationId: bLocation },
        }),
      ).toBe(1);
    });
  });

  describe('CustomerNote', () => {
    it('a note on a Tenant #1 Customer persists Tenant #1, whatever tenant the client claims', async () => {
      const customer = await makeCustomer(TENANT_1_MOCHA_HOUSE_ID, 'note-t1');

      // Milestone S0F — on this Admin route X-Tenant-Id is the validated
      // business selection: a Tenant #1-only admin naming Tenant B is
      // refused and nothing is written.
      await addNoteReq(`notes-${suffix}`, customer.id, {
        body: 'Header spoof note',
      })
        .set('x-tenant-id', TEST_TENANT_B_ID)
        .expect(403);

      await addNoteReq(`notes-${suffix}`, customer.id, {
        body: 'Tenant one note',
        tenantId: TEST_TENANT_B_ID,
      })
        .query({ tenantId: TEST_TENANT_B_ID })
        .expect(201);

      const note = await prisma.customerNote.findFirstOrThrow({
        where: { customerId: customer.id },
      });
      expect(note.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
      expect(note.authorInternalUserId).toBe(notesUser);
      expect(await auditCountFor(customer.id)).toBe(1);
    });

    it('Tenant B structural equivalent: a note on a Tenant B Customer under a Tenant B context persists Tenant B', async () => {
      await notes.addNote(
        bCustomer.id,
        'Tenant B note',
        notesUser,
        notesAuthorization,
        tenantB,
      );
      const note = await prisma.customerNote.findFirstOrThrow({
        where: { customerId: bCustomer.id },
      });
      expect(note.tenantId).toBe(TEST_TENANT_B_ID);
    });

    it('Tenant #1 cannot add a note to a Tenant B Customer: same 404 as a missing Customer, and neither a note nor an audit event is written', async () => {
      const target = await makeCustomer(TEST_TENANT_B_ID, 'note-foreign');

      const foreign = await addNoteReq(`notes-${suffix}`, target.id, {
        body: 'cross-tenant',
      }).expect(404);
      const missing = await addNoteReq(`notes-${suffix}`, randomUUID(), {
        body: 'cross-tenant',
      }).expect(404);

      expect(foreign.body).toEqual(missing.body);
      expect(JSON.stringify(foreign.body)).not.toContain(target.id);
      expect(JSON.stringify(foreign.body)).not.toContain(TEST_TENANT_B_ID);

      // The same refusal at the service boundary.
      await expect(
        notes.addNote(
          target.id,
          'cross-tenant',
          notesUser,
          notesAuthorization,
          tenantOne,
        ),
      ).rejects.toThrow(new NotFoundException('Customer not found.'));

      expect(
        await prisma.customerNote.count({ where: { customerId: target.id } }),
      ).toBe(0);
      expect(await auditCountFor(target.id)).toBe(0);
    });

    it('keeps authorization first: a caller without customers.notes.manage gets 403 (not 404) for a foreign Customer, and nothing is written', async () => {
      const target = await makeCustomer(TEST_TENANT_B_ID, 'note-noperm');

      await addNoteReq(`viewer-${suffix}`, target.id, {
        body: 'no permission',
      }).expect(403);

      const locationScoped = AuthorizationContext.of({
        'customers.notes.manage': [
          { scopeType: 'LOCATION' as const, scopeId: t1Location },
        ],
      });
      const t1Target = await makeCustomer(
        TENANT_1_MOCHA_HOUSE_ID,
        'note-locscoped',
      );
      await expect(
        notes.addNote(
          t1Target.id,
          'location scoped',
          notesUser,
          locationScoped,
          tenantOne,
        ),
      ).rejects.toThrow();

      expect(
        await prisma.customerNote.count({
          where: { customerId: { in: [target.id, t1Target.id] } },
        }),
      ).toBe(0);
      expect(await auditCountFor(target.id)).toBe(0);
      expect(await auditCountFor(t1Target.id)).toBe(0);
    });
  });
});
