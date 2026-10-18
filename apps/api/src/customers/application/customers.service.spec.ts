import 'dotenv/config';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import { tenantContextFor } from '@mocha-house/testing';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomersService } from './customers.service';
import type { CustomerIdentity } from '../../customer-auth/infrastructure/customer-identity';

// Integration test against the real local Postgres instance (see
// infrastructure/local/compose.yml + apps/api/.env), mirroring
// orders/application/checkout.service.spec.ts's pattern.
//
// SC4f-2 — a profile is created only by registering at the business
// (createAtRegistration) or joining it (enroll); requireCustomer only ever
// resolves an existing one. Cross-business behaviour is covered by
// tenancy/tenant-customer-jit.spec.ts and
// tenancy/customer-profiles-per-business.spec.ts.
describe('CustomersService (integration)', () => {
  let prisma: PrismaService;
  let customersService: CustomersService;
  const createdIds: string[] = [];
  const T1 = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [CustomersService],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    customersService = moduleRef.get(CustomersService);
    await prisma.$connect();
  });

  afterAll(async () => {
    if (createdIds.length > 0) {
      await prisma.customer.deleteMany({ where: { id: { in: createdIds } } });
    }
    await prisma.$disconnect();
  });

  function testIdentity(
    overrides: Partial<CustomerIdentity> = {},
  ): CustomerIdentity {
    return {
      provider: 'test',
      subject: `test-${randomUUID()}`,
      email: 'test@example.com',
      name: 'Test Customer',
      emailVerified: false,
      ...overrides,
    };
  }

  const register = async (identity: CustomerIdentity) => {
    const customer = await customersService.createAtRegistration(identity, T1);
    createdIds.push(customer.id);
    return customer;
  };
  const resolve = (identity: CustomerIdentity) =>
    customersService.requireCustomer(identity, T1, 'profile');

  it('creates a profile at registration, which later sign-ins resolve', async () => {
    const identity = testIdentity();

    const customer = await register(identity);

    expect(customer.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
    expect(customer.externalProvider).toBe(identity.provider);
    expect(customer.externalSubject).toBe(identity.subject);
    expect(customer.email).toBe(identity.email);
    expect(customer.displayName).toBe(identity.name);
    expect(customer.status).toBe('ACTIVE');
    expect(customer.marketingEmailOptIn).toBe(false);
    expect((await resolve(identity)).id).toBe(customer.id);
  });

  it('never creates a profile just because a signed-in login has none here', async () => {
    const identity = testIdentity();
    await expect(resolve(identity)).rejects.toMatchObject({
      response: { code: 'CUSTOMER_NOT_ENROLLED' },
    });
    expect(
      await prisma.customer.count({
        where: { externalSubject: identity.subject },
      }),
    ).toBe(0);
  });

  it('a repeated registration for the same login resolves the same profile', async () => {
    const identity = testIdentity();
    const first = await register(identity);
    const second = await register(identity);
    expect(second.id).toBe(first.id);
  });

  it('resyncs email from the latest identity claims without blanking it out', async () => {
    const identity = testIdentity({
      email: 'old@example.com',
      name: 'Old Name',
    });
    const created = await register(identity);

    const updated = await resolve({
      ...identity,
      email: 'new@example.com',
      name: 'New Name',
      emailVerified: true,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.email).toBe('new@example.com');

    // A later sign-in with no email claim (e.g. the dev boundary for a
    // non-email identifier) must not blank out what's already known.
    const resyncedWithoutClaims = await resolve({
      ...identity,
      email: null,
      name: null,
    });
    expect(resyncedWithoutClaims.id).toBe(created.id);
    expect(resyncedWithoutClaims.email).toBe('new@example.com');
  });

  it('follows only a VERIFIED new email from the identity provider', async () => {
    const identity = testIdentity({ email: 'kept@example.com' });
    const created = await register(identity);
    const unverified = await resolve({
      ...identity,
      email: 'unverified@example.com',
      emailVerified: false,
    });
    expect(unverified.email).toBe('kept@example.com');
    const verified = await resolve({
      ...identity,
      email: 'verified@example.com',
      emailVerified: true,
    });
    expect(verified.id).toBe(created.id);
    expect(verified.email).toBe('verified@example.com');
  });

  it('never writes a deactivated profile when it is read', async () => {
    const identity = testIdentity({ email: 'before@example.com' });
    const created = await register(identity);
    await prisma.customer.update({
      where: { id: created.id },
      data: { status: 'DEACTIVATED' },
    });
    const read = await resolve({
      ...identity,
      email: 'after@example.com',
      emailVerified: true,
    });
    expect(read.email).toBe('before@example.com');
  });

  it('seeds a new profile name from the claim with the same trimming and limit as an edit', async () => {
    const long = await register(
      testIdentity({ name: `  ${'n'.repeat(100)}  ` }),
    );
    expect(long.displayName).toBe('n'.repeat(80));
    const blank = await register(testIdentity({ name: '   ' }));
    expect(blank.displayName).toBeNull();
  });

  it('seeds displayName from the identity at creation, then never overwrites it from later claims (Milestone 4E ownership rule)', async () => {
    const identity = testIdentity({ name: 'Seeded Name' });
    const created = await register(identity);
    expect(created.displayName).toBe('Seeded Name');

    // Customer edits their profile.
    await customersService.updateProfile(created.id, {
      displayName: 'Customer Chosen Name',
    });

    // A later sign-in whose token still carries the old provider name must
    // NOT clobber the customer-owned value.
    const afterResync = await resolve({ ...identity, name: 'Seeded Name' });
    expect(afterResync.id).toBe(created.id);
    expect(afterResync.displayName).toBe('Customer Chosen Name');
  });

  it('never stamps emailVerifiedAt at registration, even when a claim asserts it', async () => {
    const customer = await register(testIdentity({ emailVerified: true }));
    expect(customer.emailVerifiedAt).toBeNull();
  });

  it('stamps emailVerifiedAt when a verified login joins', async () => {
    const identity = testIdentity({ emailVerified: true });
    const { customer, created } = await customersService.enroll(
      identity,
      T1,
      undefined,
    );
    createdIds.push(customer.id);
    expect(created).toBe(true);
    expect(customer.emailVerifiedAt).not.toBeNull();
  });

  it('never retroactively sets emailVerifiedAt on an existing row via a later resolve, even if the identity now asserts verification', async () => {
    const identity = testIdentity({ emailVerified: false });
    const created = await register(identity);
    expect(created.emailVerifiedAt).toBeNull();

    // Only AuthController.verify's explicit markEmailVerified may do that.
    const resolvedAgain = await resolve({ ...identity, emailVerified: true });
    expect(resolvedAgain.id).toBe(created.id);
    expect(resolvedAgain.emailVerifiedAt).toBeNull();
  });

  describe('findByEmailAndProvider', () => {
    it('returns null when no Customer matches', async () => {
      const result = await customersService.findByEmailAndProvider(
        'test',
        `nobody-${randomUUID()}@example.com`,
        T1,
      );
      expect(result).toBeNull();
    });

    it('returns the single matching Customer scoped to the given provider', async () => {
      const email = `unique-${randomUUID()}@example.com`;
      const created = await register(testIdentity({ email }));

      const result = await customersService.findByEmailAndProvider(
        'test',
        email,
        T1,
      );
      expect(result?.id).toBe(created.id);

      // A different provider must never match this row, even with the
      // identical email — provider scoping is what keeps this lookup from
      // crossing identity providers.
      const crossProvider = await customersService.findByEmailAndProvider(
        'some-other-provider',
        email,
        T1,
      );
      expect(crossProvider).toBeNull();
    });

    it('refuses to guess when more than one Customer under the same provider shares an email, rather than silently binding to one', async () => {
      const email = `ambiguous-${randomUUID()}@example.com`;
      await register(testIdentity({ email }));
      await register(testIdentity({ email }));

      await expect(
        customersService.findByEmailAndProvider('test', email, T1),
      ).rejects.toThrow('Ambiguous Customer lookup');
    });
  });

  it('maps a Customer row to the shared CustomerProfile contract shape', async () => {
    const customer = await register(testIdentity({ emailVerified: false }));

    const profile = customersService.toProfile(customer);

    expect(profile).toEqual({
      id: customer.id,
      email: customer.email,
      displayName: customer.displayName,
      status: customer.status,
      emailVerified: false,
      createdAt: customer.createdAt.toISOString(),
    });
  });

  it('reports emailVerified: true once emailVerifiedAt is set', async () => {
    const customer = await register(testIdentity());
    const verified = await customersService.markEmailVerified(customer.id);
    expect(customersService.toProfile(verified).emailVerified).toBe(true);
  });

  describe('updateProfile', () => {
    async function freshCustomer() {
      return register(testIdentity({ name: 'Original', emailVerified: true }));
    }

    it('updates the display name and returns the updated row', async () => {
      const customer = await freshCustomer();
      const updated = await customersService.updateProfile(customer.id, {
        displayName: 'New Display Name',
      });
      expect(updated.id).toBe(customer.id);
      expect(updated.displayName).toBe('New Display Name');
    });

    it('trims and collapses internal whitespace', async () => {
      const customer = await freshCustomer();
      const updated = await customersService.updateProfile(customer.id, {
        displayName: '  Ada   Lovelace  ',
      });
      expect(updated.displayName).toBe('Ada Lovelace');
    });

    it('stores a blank / whitespace-only name as null rather than an empty string', async () => {
      const customer = await freshCustomer();
      const updated = await customersService.updateProfile(customer.id, {
        displayName: '   ',
      });
      expect(updated.displayName).toBeNull();

      const explicitNull = await customersService.updateProfile(customer.id, {
        displayName: null,
      });
      expect(explicitNull.displayName).toBeNull();
    });

    it('rejects a name longer than the limit', async () => {
      const customer = await freshCustomer();
      await expect(
        customersService.updateProfile(customer.id, {
          displayName: 'x'.repeat(81),
        }),
      ).rejects.toThrow('characters or fewer');
    });

    it('rejects a non-string, non-null displayName', async () => {
      const customer = await freshCustomer();
      await expect(
        customersService.updateProfile(customer.id, {
          displayName: 42 as unknown as string,
        }),
      ).rejects.toThrow('must be a string or null');
    });

    it('never mutates identity, status, or verification state', async () => {
      const customer = await freshCustomer();
      const updated = await customersService.updateProfile(customer.id, {
        displayName: 'Only This Changes',
      });
      expect(updated.externalProvider).toBe(customer.externalProvider);
      expect(updated.externalSubject).toBe(customer.externalSubject);
      expect(updated.status).toBe(customer.status);
      expect(updated.email).toBe(customer.email);
      expect(updated.emailVerifiedAt?.toISOString()).toBe(
        customer.emailVerifiedAt?.toISOString(),
      );
    });

    it('updating one customer never affects another', async () => {
      const a = await freshCustomer();
      const b = await freshCustomer();
      await customersService.updateProfile(a.id, { displayName: 'A Only' });
      const bReloaded = await resolve({
        provider: b.externalProvider,
        subject: b.externalSubject,
        email: b.email,
        name: null,
        emailVerified: null,
      });
      expect(bReloaded.displayName).toBe('Original');
    });
  });
});
