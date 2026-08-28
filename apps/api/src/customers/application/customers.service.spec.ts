import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomersService } from './customers.service';
import type { CustomerIdentity } from '../../customer-auth/infrastructure/customer-identity';

// Integration test against the real local Postgres instance (see
// infrastructure/local/compose.yml + apps/api/.env), mirroring
// orders/application/checkout.service.spec.ts's pattern.
describe('CustomersService (integration)', () => {
  let prisma: PrismaService;
  let customersService: CustomersService;
  const createdIds: string[] = [];

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

  it('creates a new Customer on first resolution for an identity', async () => {
    const identity = testIdentity();

    const customer =
      await customersService.resolveOrCreateFromIdentity(identity);
    createdIds.push(customer.id);

    expect(customer.externalProvider).toBe(identity.provider);
    expect(customer.externalSubject).toBe(identity.subject);
    expect(customer.email).toBe(identity.email);
    expect(customer.displayName).toBe(identity.name);
    expect(customer.status).toBe('ACTIVE');
  });

  it('resolves the same Customer record for a repeat sign-in by the same identity', async () => {
    const identity = testIdentity();

    const first = await customersService.resolveOrCreateFromIdentity(identity);
    createdIds.push(first.id);
    const second = await customersService.resolveOrCreateFromIdentity(identity);

    expect(second.id).toBe(first.id);
  });

  it('resyncs email from the latest identity claims without blanking it out', async () => {
    const identity = testIdentity({
      email: 'old@example.com',
      name: 'Old Name',
    });
    const created =
      await customersService.resolveOrCreateFromIdentity(identity);
    createdIds.push(created.id);

    const updated = await customersService.resolveOrCreateFromIdentity({
      ...identity,
      email: 'new@example.com',
      name: 'New Name',
    });
    expect(updated.id).toBe(created.id);
    expect(updated.email).toBe('new@example.com');

    // A later sign-in with no email claim (e.g. the dev boundary for a
    // non-email identifier) must not blank out what's already known.
    const resyncedWithoutClaims =
      await customersService.resolveOrCreateFromIdentity({
        ...identity,
        email: null,
        name: null,
      });
    expect(resyncedWithoutClaims.id).toBe(created.id);
    expect(resyncedWithoutClaims.email).toBe('new@example.com');
  });

  it('seeds displayName from the identity at creation, then never overwrites it from later claims (Milestone 4E ownership rule)', async () => {
    const identity = testIdentity({ name: 'Seeded Name' });
    const created =
      await customersService.resolveOrCreateFromIdentity(identity);
    createdIds.push(created.id);
    expect(created.displayName).toBe('Seeded Name');

    // Customer edits their Mocha House profile.
    await customersService.updateProfile(created.id, {
      displayName: 'Customer Chosen Name',
    });

    // A later sign-in whose token still carries the old provider name must
    // NOT clobber the customer-owned value.
    const afterResync = await customersService.resolveOrCreateFromIdentity({
      ...identity,
      name: 'Seeded Name',
    });
    expect(afterResync.id).toBe(created.id);
    expect(afterResync.displayName).toBe('Customer Chosen Name');
  });

  it('stamps emailVerifiedAt at creation when the identity asserts emailVerified: true', async () => {
    const identity = testIdentity({ emailVerified: true });

    const customer =
      await customersService.resolveOrCreateFromIdentity(identity);
    createdIds.push(customer.id);

    expect(customer.emailVerifiedAt).not.toBeNull();
  });

  it('leaves emailVerifiedAt null at creation when the identity does not assert verification', async () => {
    const identity = testIdentity({ emailVerified: false });
    const customerA =
      await customersService.resolveOrCreateFromIdentity(identity);
    createdIds.push(customerA.id);
    expect(customerA.emailVerifiedAt).toBeNull();

    const identityB = testIdentity({ emailVerified: null });
    const customerB =
      await customersService.resolveOrCreateFromIdentity(identityB);
    createdIds.push(customerB.id);
    expect(customerB.emailVerifiedAt).toBeNull();
  });

  it('never retroactively sets emailVerifiedAt on an existing row via a later resolve, even if the identity now asserts verification', async () => {
    const identity = testIdentity({ emailVerified: false });
    const created =
      await customersService.resolveOrCreateFromIdentity(identity);
    createdIds.push(created.id);
    expect(created.emailVerifiedAt).toBeNull();

    // A later sign-in for the same (already-existing) identity now
    // claiming emailVerified: true must not be treated as a fresh
    // verification event by this path — only AuthController.verify's
    // explicit markEmailVerified call may do that.
    const resolvedAgain = await customersService.resolveOrCreateFromIdentity({
      ...identity,
      emailVerified: true,
    });
    expect(resolvedAgain.id).toBe(created.id);
    expect(resolvedAgain.emailVerifiedAt).toBeNull();
  });

  describe('findByEmailAndProvider', () => {
    it('returns null when no Customer matches', async () => {
      const result = await customersService.findByEmailAndProvider(
        'test',
        `nobody-${randomUUID()}@example.com`,
      );
      expect(result).toBeNull();
    });

    it('returns the single matching Customer scoped to the given provider', async () => {
      const email = `unique-${randomUUID()}@example.com`;
      const identity = testIdentity({ email });
      const created =
        await customersService.resolveOrCreateFromIdentity(identity);
      createdIds.push(created.id);

      const result = await customersService.findByEmailAndProvider(
        'test',
        email,
      );
      expect(result?.id).toBe(created.id);

      // A different provider must never match this row, even with the
      // identical email — provider scoping is what keeps this lookup from
      // crossing identity providers.
      const crossProvider = await customersService.findByEmailAndProvider(
        'some-other-provider',
        email,
      );
      expect(crossProvider).toBeNull();
    });

    it('refuses to guess when more than one Customer under the same provider shares an email, rather than silently binding to one', async () => {
      const email = `ambiguous-${randomUUID()}@example.com`;
      const first = await customersService.resolveOrCreateFromIdentity(
        testIdentity({ email }),
      );
      const second = await customersService.resolveOrCreateFromIdentity(
        testIdentity({ email }),
      );
      createdIds.push(first.id, second.id);

      await expect(
        customersService.findByEmailAndProvider('test', email),
      ).rejects.toThrow('Ambiguous Customer lookup');
    });
  });

  it('maps a Customer row to the shared CustomerProfile contract shape', async () => {
    const identity = testIdentity({ emailVerified: false });
    const customer =
      await customersService.resolveOrCreateFromIdentity(identity);
    createdIds.push(customer.id);

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
    const identity = testIdentity({ emailVerified: true });
    const customer =
      await customersService.resolveOrCreateFromIdentity(identity);
    createdIds.push(customer.id);

    expect(customersService.toProfile(customer).emailVerified).toBe(true);
  });

  describe('updateProfile', () => {
    async function freshCustomer() {
      const customer = await customersService.resolveOrCreateFromIdentity(
        testIdentity({ name: 'Original', emailVerified: true }),
      );
      createdIds.push(customer.id);
      return customer;
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
      const bReloaded = await customersService.resolveOrCreateFromIdentity({
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
