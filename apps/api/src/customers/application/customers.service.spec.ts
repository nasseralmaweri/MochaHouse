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

  it('resyncs profile fields from the latest identity claims without blanking them out', async () => {
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
    expect(updated.displayName).toBe('New Name');

    // A later sign-in with no email/name claim (e.g. the dev boundary for a
    // non-email identifier) must not blank out what's already known.
    const resyncedWithoutClaims =
      await customersService.resolveOrCreateFromIdentity({
        ...identity,
        email: null,
        name: null,
      });
    expect(resyncedWithoutClaims.id).toBe(created.id);
    expect(resyncedWithoutClaims.email).toBe('new@example.com');
    expect(resyncedWithoutClaims.displayName).toBe('New Name');
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
    const identity = testIdentity();
    const customer =
      await customersService.resolveOrCreateFromIdentity(identity);
    createdIds.push(customer.id);

    const profile = customersService.toProfile(customer);

    expect(profile).toEqual({
      id: customer.id,
      email: customer.email,
      displayName: customer.displayName,
      status: customer.status,
      createdAt: customer.createdAt.toISOString(),
    });
  });
});
