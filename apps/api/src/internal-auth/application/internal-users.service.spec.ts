import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
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
  });

  afterAll(async () => {
    if (createdEmails.length > 0) {
      await prisma.internalUser.deleteMany({
        where: { email: { in: createdEmails } },
      });
    }
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
    opts: { withSubject?: boolean } = { withSubject: true },
  ) {
    return prisma.internalUser.create({
      data: {
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

    const result = await service.resolveForAuthentication(identityFor(email));

    expect(result.outcome).toBe('active');
    if (result.outcome === 'active') {
      expect(result.user.email).toBe(email);
      expect(result.user.lastAuthenticatedAt).not.toBeNull();
    }
  });

  it('does NOT create an InternalUser for an unknown identity', async () => {
    const email = uniqueEmail();
    const before = await prisma.internalUser.count();

    const result = await service.resolveForAuthentication(identityFor(email));

    expect(result.outcome).toBe('not-found');
    expect(await prisma.internalUser.count()).toBe(before);
    expect(
      await prisma.internalUser.findUnique({ where: { email } }),
    ).toBeNull();
  });

  it('does NOT activate an INVITED user on authentication', async () => {
    const email = uniqueEmail();
    await createInternalUser(email, 'INVITED');

    const result = await service.resolveForAuthentication(identityFor(email));

    expect(result).toEqual({ outcome: 'inactive', status: 'INVITED' });

    const stored = await prisma.internalUser.findUniqueOrThrow({
      where: { email },
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

      const result = await service.resolveForAuthentication(identityFor(email));

      expect(result).toEqual({ outcome: 'inactive', status });
      const stored = await prisma.internalUser.findUniqueOrThrow({
        where: { email },
      });
      expect(stored.status).toBe(status);
      expect(stored.lastAuthenticatedAt).toBeNull();
    },
  );

  it('binds the external subject on first authentication of an email-provisioned ACTIVE user', async () => {
    const email = uniqueEmail();
    await createInternalUser(email, 'ACTIVE', { withSubject: false });

    const result = await service.resolveForAuthentication(
      identityFor(email, { subject: 'internal-dev:bound-subject-123' }),
    );

    expect(result.outcome).toBe('active');
    const stored = await prisma.internalUser.findUniqueOrThrow({
      where: { email },
    });
    expect(stored.externalSubject).toBe('internal-dev:bound-subject-123');
  });

  it('does not bind a subject to a non-ACTIVE email-provisioned user', async () => {
    const email = uniqueEmail();
    await createInternalUser(email, 'INVITED', { withSubject: false });

    await service.resolveForAuthentication(
      identityFor(email, { subject: 'internal-dev:should-not-bind' }),
    );

    const stored = await prisma.internalUser.findUniqueOrThrow({
      where: { email },
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
    );

    expect(result.outcome).toBe('not-found');
  });
});
