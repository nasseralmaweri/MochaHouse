import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
} from '@mocha-house/testing';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalUsersService } from './internal-users.service';
import type { InternalIdentity } from '../infrastructure/internal-identity';

// Integration test against the real local Postgres instance. Proves the
// lifecycle gate and — critically — that authentication never provisions or
// activates an internal user.
describe('InternalUsersService (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let service: InternalUsersService;

  const createdEmails: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [InternalUsersService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(InternalUsersService);
    await prisma.$connect();
    await createTestTenantB(prisma);
  });

  afterAll(async () => {
    if (createdEmails.length > 0) {
      await prisma.internalUser.deleteMany({
        where: { email: { in: createdEmails } },
      });
    }
    await removeTestTenantB(prisma);
    await moduleRef.close();
    await prisma.$disconnect();
  });

  function uniqueEmail(): string {
    const email = `internal-users-spec-${randomUUID()}@example.com`;
    createdEmails.push(email);
    return email;
  }

  function identityFor(
    email: string,
    overrides: Partial<InternalIdentity> = {},
  ): InternalIdentity {
    return {
      provider: 'internal-dev',
      subject: `internal-dev:${email}`,
      email,
      name: null,
      ...overrides,
    };
  }

  async function createInternalUser(
    email: string,
    status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED',
    opts: { withSubject?: boolean; tenantId?: string } = { withSubject: true },
  ) {
    return prisma.internalUser.create({
      data: {
        tenantId: opts.tenantId ?? TENANT_1_MOCHA_HOUSE_ID,
        externalProvider: 'internal-dev',
        externalSubject:
          opts.withSubject === false ? null : `internal-dev:${email}`,
        email,
        displayName: 'Spec User',
        status,
        activatedAt: status === 'ACTIVE' ? new Date() : null,
      },
    });
  }

  it('resolves an existing ACTIVE identity and stamps lastAuthenticatedAt', async () => {
    const email = uniqueEmail();
    await createInternalUser(email, 'ACTIVE');

    const result = await service.resolveForAuthentication(
      identityFor(email),
      TENANT_1_MOCHA_HOUSE_ID,
    );

    expect(result.outcome).toBe('active');
    if (result.outcome === 'active') {
      expect(result.user.email).toBe(email);
      expect(result.user.lastAuthenticatedAt).not.toBeNull();
    }
  });

  it('does NOT create an InternalUser for an unknown identity', async () => {
    const email = uniqueEmail();
    const before = await prisma.internalUser.count();

    const result = await service.resolveForAuthentication(
      identityFor(email),
      TENANT_1_MOCHA_HOUSE_ID,
    );

    expect(result.outcome).toBe('not-found');
    expect(await prisma.internalUser.count()).toBe(before);
    expect(
      await prisma.internalUser.findUnique({
        where: {
          tenantId_email: { tenantId: TENANT_1_MOCHA_HOUSE_ID, email },
        },
      }),
    ).toBeNull();
  });

  it('does NOT activate an INVITED user on authentication', async () => {
    const email = uniqueEmail();
    await createInternalUser(email, 'INVITED');

    const result = await service.resolveForAuthentication(
      identityFor(email),
      TENANT_1_MOCHA_HOUSE_ID,
    );

    expect(result).toEqual({ outcome: 'inactive', status: 'INVITED' });

    const stored = await prisma.internalUser.findUniqueOrThrow({
      where: {
        tenantId_email: { tenantId: TENANT_1_MOCHA_HOUSE_ID, email },
      },
    });
    expect(stored.status).toBe('INVITED');
    expect(stored.activatedAt).toBeNull();
    // No observational write either — a denied auth attempt leaves the row
    // untouched.
    expect(stored.lastAuthenticatedAt).toBeNull();
  });

  it.each(['SUSPENDED', 'DISABLED'] as const)(
    'keeps a %s user blocked and unmutated',
    async (status) => {
      const email = uniqueEmail();
      await createInternalUser(email, status);

      const result = await service.resolveForAuthentication(
        identityFor(email),
        TENANT_1_MOCHA_HOUSE_ID,
      );

      expect(result).toEqual({ outcome: 'inactive', status });
      const stored = await prisma.internalUser.findUniqueOrThrow({
        where: {
          tenantId_email: { tenantId: TENANT_1_MOCHA_HOUSE_ID, email },
        },
      });
      expect(stored.status).toBe(status);
      expect(stored.lastAuthenticatedAt).toBeNull();
    },
  );

  it('binds the external subject on first authentication of an email-provisioned ACTIVE user', async () => {
    const email = uniqueEmail();
    await createInternalUser(email, 'ACTIVE', { withSubject: false });

    const result = await service.resolveForAuthentication(
      identityFor(email, {
        subject: 'internal-dev:bound-subject-123',
        emailVerified: true,
      }),
      TENANT_1_MOCHA_HOUSE_ID,
    );

    expect(result.outcome).toBe('active');
    const stored = await prisma.internalUser.findUniqueOrThrow({
      where: {
        tenantId_email: { tenantId: TENANT_1_MOCHA_HOUSE_ID, email },
      },
    });
    expect(stored.externalSubject).toBe('internal-dev:bound-subject-123');
  });

  it('never binds an email-provisioned user to an unverified email claim', async () => {
    const email = uniqueEmail();
    await createInternalUser(email, 'ACTIVE', { withSubject: false });

    for (const emailVerified of [undefined, false]) {
      const result = await service.resolveForAuthentication(
        identityFor(email, {
          subject: `internal-dev:unverified-${randomUUID()}`,
          emailVerified,
        }),
        TENANT_1_MOCHA_HOUSE_ID,
      );
      expect(result.outcome).toBe('not-found');
    }
    const stored = await prisma.internalUser.findUniqueOrThrow({
      where: {
        tenantId_email: { tenantId: TENANT_1_MOCHA_HOUSE_ID, email },
      },
    });
    expect(stored.externalSubject).toBeNull();
  });

  it('does not bind a subject to a non-ACTIVE email-provisioned user', async () => {
    const email = uniqueEmail();
    await createInternalUser(email, 'INVITED', { withSubject: false });

    await service.resolveForAuthentication(
      identityFor(email, { subject: 'internal-dev:should-not-bind' }),
      TENANT_1_MOCHA_HOUSE_ID,
    );

    const stored = await prisma.internalUser.findUniqueOrThrow({
      where: {
        tenantId_email: { tenantId: TENANT_1_MOCHA_HOUSE_ID, email },
      },
    });
    expect(stored.externalSubject).toBeNull();
  });

  it("does not match another provider's user with the same email", async () => {
    const email = uniqueEmail();
    await createInternalUser(email, 'ACTIVE');

    const result = await service.resolveForAuthentication(
      identityFor(email, {
        provider: 'cognito-internal',
        subject: 'cognito-internal:abc',
      }),
      TENANT_1_MOCHA_HOUSE_ID,
    );

    expect(result.outcome).toBe('not-found');
  });

  // --- Milestone S0D-2E: tenant-scoped resolution -----------------------

  it('does not resolve an ACTIVE identity whose InternalUser belongs to a different tenant (by subject)', async () => {
    const email = uniqueEmail();
    await createInternalUser(email, 'ACTIVE', { tenantId: TEST_TENANT_B_ID });

    const result = await service.resolveForAuthentication(
      identityFor(email),
      TENANT_1_MOCHA_HOUSE_ID,
    );

    expect(result.outcome).toBe('not-found');
  });

  it('does not resolve an ACTIVE, not-yet-bound identity whose InternalUser belongs to a different tenant (by email fallback)', async () => {
    const email = uniqueEmail();
    await createInternalUser(email, 'ACTIVE', {
      withSubject: false,
      tenantId: TEST_TENANT_B_ID,
    });

    const result = await service.resolveForAuthentication(
      identityFor(email),
      TENANT_1_MOCHA_HOUSE_ID,
    );

    expect(result.outcome).toBe('not-found');
  });

  it('the SAME email can be independently provisioned in two different tenants, and each resolves only its own', async () => {
    // Milestone S0D-2E — email is now unique per (tenantId, email), not
    // globally; this is the scenario that fix exists for. externalSubject
    // stays GLOBALLY unique (an S0F question, not this one), so the two
    // rows below use genuinely different subjects — exactly as two
    // distinct real external identities would — never the same one bound
    // to two tenants at once.
    const email = uniqueEmail();
    await prisma.internalUser.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:tenant-a-${email}`,
        email,
        displayName: 'Spec User (Tenant A)',
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    await prisma.internalUser.create({
      data: {
        tenantId: TEST_TENANT_B_ID,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:tenant-b-${email}`,
        email,
        displayName: 'Spec User (Tenant B)',
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });

    const resultA = await service.resolveForAuthentication(
      identityFor(email, { subject: `internal-dev:tenant-a-${email}` }),
      TENANT_1_MOCHA_HOUSE_ID,
    );
    const resultB = await service.resolveForAuthentication(
      identityFor(email, { subject: `internal-dev:tenant-b-${email}` }),
      TEST_TENANT_B_ID,
    );

    expect(resultA.outcome).toBe('active');
    expect(resultB.outcome).toBe('active');
    if (resultA.outcome === 'active' && resultB.outcome === 'active') {
      expect(resultA.user.id).not.toBe(resultB.user.id);
      expect(resultA.user.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
      expect(resultB.user.tenantId).toBe(TEST_TENANT_B_ID);
    }
  });
});
