import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import {
  TENANT_1_MOCHA_HOUSE_ID,
  TENANT_1_MOCHA_HOUSE_NAME,
  TENANT_1_MOCHA_HOUSE_SLUG,
  TenantConfigurationError,
  ensureTenantOne,
  resolveSingleTenant,
} from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';

// Milestone S0C — Tenant #1, SINGLE_TENANT_ID resolution and the test-only
// Tenant B fixture, over real local Postgres.
describe('Tenant foundation (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await removeTestTenantB(prisma);
    await moduleRef.close();
  });

  const findTenant = (tenantId: string) =>
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });

  describe('Tenant #1 (Mocha House)', () => {
    it('exists with the fixed id, slug, name and ACTIVE status', async () => {
      const tenant = await prisma.tenant.findUniqueOrThrow({
        where: { id: TENANT_1_MOCHA_HOUSE_ID },
      });
      expect(tenant).toMatchObject({
        id: '01a0db02-f800-7000-8000-000000000001',
        slug: TENANT_1_MOCHA_HOUSE_SLUG,
        name: TENANT_1_MOCHA_HOUSE_NAME,
        status: 'ACTIVE',
        suspensionReason: null,
      });
    });

    it('is inserted by the migration with the SAME literal id (deterministic across environments)', () => {
      const migrationsDir = join(
        __dirname,
        '../../../../packages/database/prisma/migrations',
      );
      const folder = readdirSync(migrationsDir).find((name) =>
        name.endsWith('_add_tenant_foundation'),
      );
      expect(folder).toBeDefined();
      const sql = readFileSync(
        join(migrationsDir, folder!, 'migration.sql'),
        'utf8',
      );
      expect(sql).toContain(`'${TENANT_1_MOCHA_HOUSE_ID}'`);
      expect(sql).toContain('ON CONFLICT ("id") DO NOTHING');
    });

    it('ensureTenantOne is idempotent and never creates a second Mocha House', async () => {
      const before = await prisma.tenant.findUniqueOrThrow({
        where: { id: TENANT_1_MOCHA_HOUSE_ID },
      });

      const first = await ensureTenantOne(prisma);
      const second = await ensureTenantOne(prisma);

      expect(first).toBe(TENANT_1_MOCHA_HOUSE_ID);
      expect(second).toBe(TENANT_1_MOCHA_HOUSE_ID);
      expect(
        await prisma.tenant.count({
          where: { slug: TENANT_1_MOCHA_HOUSE_SLUG },
        }),
      ).toBe(1);
      // Create-once: an existing row is never rewritten by a re-seed.
      const after = await prisma.tenant.findUniqueOrThrow({
        where: { id: TENANT_1_MOCHA_HOUSE_ID },
      });
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });
  });

  describe('Tenant table invariants', () => {
    it('rejects a SUSPENDED tenant without a suspension reason', async () => {
      await expect(
        prisma.tenant.create({
          data: {
            id: '01a0db02-f800-7000-8000-7e57000000c1',
            slug: 's0c-invariant-probe',
            name: 'probe',
            status: 'SUSPENDED',
          },
        }),
      ).rejects.toThrow();
    });

    it('rejects a suspension reason on an ACTIVE tenant', async () => {
      await expect(
        prisma.tenant.create({
          data: {
            id: '01a0db02-f800-7000-8000-7e57000000c2',
            slug: 's0c-invariant-probe',
            name: 'probe',
            status: 'ACTIVE',
            suspensionReason: 'SECURITY',
          },
        }),
      ).rejects.toThrow();
    });

    it('rejects a non-canonical tenant id and a non-URL-safe slug', async () => {
      await expect(
        prisma.tenant.create({
          data: {
            id: 'MOCHA',
            slug: 's0c-probe',
            name: 'probe',
            status: 'ACTIVE',
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.tenant.create({
          data: {
            id: '01a0db02-f800-7000-8000-7e57000000c3',
            slug: 'Not A Slug',
            name: 'probe',
            status: 'ACTIVE',
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('resolveSingleTenant (SINGLE_TENANT_ID)', () => {
    it('resolves a valid, existing Tenant #1', async () => {
      const resolution = await resolveSingleTenant(
        TENANT_1_MOCHA_HOUSE_ID,
        findTenant,
      );
      expect(resolution).toEqual({ tenantId: TENANT_1_MOCHA_HOUSE_ID });
      expect(Object.isFrozen(resolution)).toBe(true);
    });

    it.each([[undefined], [''], ['   ']])(
      'fails when SINGLE_TENANT_ID is missing (%p)',
      async (value) => {
        await expect(resolveSingleTenant(value, findTenant)).rejects.toThrow(
          TenantConfigurationError,
        );
      },
    );

    it.each([
      ['not a uuid', 'mocha-house'],
      ['uppercase', TENANT_1_MOCHA_HOUSE_ID.toUpperCase()],
      ['padded', `${TENANT_1_MOCHA_HOUSE_ID} `],
    ])(
      'fails when SINGLE_TENANT_ID is malformed (%s) — no repair',
      async (_l, value) => {
        await expect(resolveSingleTenant(value, findTenant)).rejects.toThrow(
          /canonical lowercase UUID/,
        );
      },
    );

    it('fails when SINGLE_TENANT_ID references no tenant', async () => {
      await expect(
        resolveSingleTenant('01a0db02-f800-7000-8000-00000000dead', findTenant),
      ).rejects.toThrow(/does not reference an existing tenant/);
    });

    it('never falls back to Mocha House when the lookup finds nothing', async () => {
      const lookedUp: string[] = [];
      await expect(
        resolveSingleTenant('01a0db02-f800-7000-8000-00000000dead', (id) => {
          lookedUp.push(id);
          return Promise.resolve(null);
        }),
      ).rejects.toThrow(TenantConfigurationError);
      expect(lookedUp).toEqual(['01a0db02-f800-7000-8000-00000000dead']);
    });
  });

  describe('test-only Tenant B fixture', () => {
    it('creates Tenant B idempotently with its fixed id, and removes it', async () => {
      expect(await createTestTenantB(prisma)).toBe(TEST_TENANT_B_ID);
      expect(await createTestTenantB(prisma)).toBe(TEST_TENANT_B_ID);
      expect(
        await prisma.tenant.count({ where: { id: TEST_TENANT_B_ID } }),
      ).toBe(1);

      await removeTestTenantB(prisma);
      expect(
        await prisma.tenant.count({ where: { id: TEST_TENANT_B_ID } }),
      ).toBe(0);
    });

    it('is distinct from Tenant #1', () => {
      expect(TEST_TENANT_B_ID).not.toBe(TENANT_1_MOCHA_HOUSE_ID);
    });
  });
});
