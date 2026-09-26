import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  MODEL_TENANCY,
  Prisma,
  TENANT_1_MOCHA_HOUSE_ID,
  TenantQueryAuditConfigurationError,
  TenantQueryAuditRecorder,
  createTenantContext,
  observeTenantQuery,
  parseTenantQueryAuditMode,
  runWithTenantContext,
  tenantQueryAuditRecorder,
} from '@mocha-house/database';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// Milestone S0C — the report-only tenant query audit and the model tenancy
// registry it relies on.
describe('Tenant query audit (report-only)', () => {
  const context = createTenantContext({
    tenantId: TENANT_1_MOCHA_HOUSE_ID,
    principalType: 'system',
    requestId: 'audit-spec',
  });

  describe('model tenancy registry', () => {
    it('classifies every Prisma model exactly once', () => {
      expect(Object.keys(MODEL_TENANCY).sort()).toEqual(
        Object.values(Prisma.ModelName).sort(),
      );
    });

    it('treats Tenant as platform-plane metadata', () => {
      expect(MODEL_TENANCY.Tenant).toBe('platform');
    });

    it('treats the internal-user models as tenant-scoped (ADR-4 amendment)', () => {
      expect(MODEL_TENANCY.InternalUser).toBe('tenant');
      expect(MODEL_TENANCY.InternalRole).toBe('tenant');
      expect(MODEL_TENANCY.InternalRolePermission).toBe('tenant');
      expect(MODEL_TENANCY.InternalUserRoleAssignment).toBe('tenant');
    });

    it('treats every existing business model as tenant-owned', () => {
      const platform = Object.entries(MODEL_TENANCY)
        .filter(([, tenancy]) => tenancy === 'platform')
        .map(([model]) => model);
      expect(platform).toEqual(['Tenant']);
    });
  });

  describe('parseTenantQueryAuditMode', () => {
    it('defaults to report and accepts off/report', () => {
      expect(parseTenantQueryAuditMode(undefined)).toBe('report');
      expect(parseTenantQueryAuditMode('')).toBe('report');
      expect(parseTenantQueryAuditMode('report')).toBe('report');
      expect(parseTenantQueryAuditMode('off')).toBe('off');
    });

    it('fails on an unrecognised value instead of silently disabling the check', () => {
      expect(() => parseTenantQueryAuditMode('enforce')).toThrow(
        TenantQueryAuditConfigurationError,
      );
    });
  });

  describe('observeTenantQuery', () => {
    it('ignores platform-plane models', () => {
      expect(
        observeTenantQuery('Tenant', 'findUnique', {}, context),
      ).toBeNull();
    });

    it('records a tenant-owned query outside any context without inventing a tenant', () => {
      expect(
        observeTenantQuery(
          'Order',
          'findMany',
          { where: { status: 'READY' } },
          undefined,
        ),
      ).toEqual({
        model: 'Order',
        operation: 'findMany',
        classification: 'tenant',
        contextPresent: false,
        tenantId: null,
        principalType: null,
        requestId: null,
        tenantPredicate: false,
      });
    });

    it('records the context when present', () => {
      expect(observeTenantQuery('Order', 'count', {}, context)).toMatchObject({
        contextPresent: true,
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        principalType: 'system',
        requestId: 'audit-spec',
        tenantPredicate: false,
      });
    });

    it('detects a top-level tenant predicate in where / data / upsert create / createMany', () => {
      const cases: [string, unknown][] = [
        ['findMany', { where: { tenantId: 't' } }],
        ['create', { data: { tenantId: 't' } }],
        ['upsert', { where: { id: 'x' }, create: { tenantId: 't' } }],
        ['createMany', { data: [{ tenantId: 't' }, { tenantId: 't' }] }],
      ];
      for (const [operation, args] of cases) {
        expect(
          observeTenantQuery('Order', operation, args, context)
            ?.tenantPredicate,
        ).toBe(true);
      }
      expect(
        observeTenantQuery(
          'Order',
          'createMany',
          { data: [{ tenantId: 't' }, {}] },
          context,
        )?.tenantPredicate,
      ).toBe(false);
    });

    it('reports an unknown model as unclassified rather than assuming it is safe', () => {
      expect(
        observeTenantQuery('Mystery', 'findMany', {}, undefined)
          ?.classification,
      ).toBe('unclassified');
    });

    it('never mutates the query arguments', () => {
      const args = deepFreeze({
        where: { id: 'x', status: { in: ['READY'] } },
        include: { lines: true },
      });
      const snapshot = JSON.stringify(args);
      expect(() =>
        observeTenantQuery('Order', 'findMany', args, context),
      ).not.toThrow();
      expect(JSON.stringify(args)).toBe(snapshot);
    });
  });

  describe('TenantQueryAuditRecorder', () => {
    it('reports only the first observation of each signature and counts the rest', () => {
      const recorder = new TenantQueryAuditRecorder();
      const observation = observeTenantQuery(
        'Order',
        'findMany',
        {},
        undefined,
      )!;

      expect(recorder.record(observation)).toBe(true);
      expect(recorder.record(observation)).toBe(false);
      expect(recorder.record({ ...observation, contextPresent: true })).toBe(
        true,
      );

      expect(recorder.snapshot()).toEqual([
        expect.objectContaining({
          model: 'Order',
          contextPresent: true,
          count: 1,
        }),
        expect.objectContaining({
          model: 'Order',
          contextPresent: false,
          count: 2,
        }),
      ]);
    });
  });

  describe('attached to PrismaService (real Postgres)', () => {
    let moduleRef: TestingModule;
    let prisma: PrismaService;
    const originalMode = process.env.TENANT_QUERY_AUDIT;

    beforeAll(async () => {
      process.env.TENANT_QUERY_AUDIT = 'report';
      moduleRef = await Test.createTestingModule({
        imports: [PrismaModule],
      }).compile();
      prisma = moduleRef.get(PrismaService);
      await moduleRef.init();
    });

    afterAll(async () => {
      process.env.TENANT_QUERY_AUDIT = originalMode;
      await moduleRef.close();
    });

    beforeEach(() => tenantQueryAuditRecorder.reset());

    it('keeps PrismaService a working PrismaService (lifecycle hooks, batch and interactive transactions)', async () => {
      // The instrumented client is Prisma's extended client, not a literal
      // PrismaService instance (`instanceof` is false — nothing relies on
      // it); what Nest and every service rely on must still be present.
      expect(typeof prisma.onModuleInit).toBe('function');
      expect(typeof prisma.onModuleDestroy).toBe('function');
      const [a, b] = await prisma.$transaction([
        prisma.location.count(),
        prisma.location.count(),
      ]);
      expect(a).toBe(b);
      const inside = await prisma.$transaction((tx) => tx.location.count());
      expect(inside).toBe(a);
    });

    it('returns exactly what an un-instrumented query returns (no query mutation)', async () => {
      const where = Object.freeze({ isActive: true });
      const audited = await prisma.location.findMany({
        where,
        orderBy: { id: 'asc' },
        select: { id: true },
      });
      const raw = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Location" WHERE "isActive" = true ORDER BY id ASC`;
      expect(audited.map((row) => row.id)).toEqual(raw.map((row) => row.id));
    });

    it('records tenant-owned queries with and without a context, and never platform ones', async () => {
      await prisma.location.count();
      // Prisma queries are lazy thenables: the context is sampled when the
      // query executes, so it must be awaited INSIDE the context (as every
      // async service method does).
      await runWithTenantContext(context, async () => {
        await prisma.location.count();
      });
      await prisma.tenant.count();

      const summaries = tenantQueryAuditRecorder.snapshot();
      expect(summaries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            model: 'Location',
            operation: 'count',
            contextPresent: false,
          }),
          expect.objectContaining({
            model: 'Location',
            operation: 'count',
            contextPresent: true,
          }),
        ]),
      );
      expect(summaries.some((summary) => summary.model === 'Tenant')).toBe(
        false,
      );
    });

    it('observes queries inside interactive transactions too', async () => {
      await runWithTenantContext(context, () =>
        prisma.$transaction((tx) => tx.product.count()),
      );
      expect(tenantQueryAuditRecorder.snapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            model: 'Product',
            operation: 'count',
            contextPresent: true,
          }),
        ]),
      );
    });

    it('can be switched off, in which case nothing is recorded', async () => {
      process.env.TENANT_QUERY_AUDIT = 'off';
      const offModule = await Test.createTestingModule({
        imports: [PrismaModule],
      }).compile();
      try {
        await offModule.get(PrismaService).location.count();
        expect(tenantQueryAuditRecorder.snapshot()).toEqual([]);
      } finally {
        process.env.TENANT_QUERY_AUDIT = 'report';
        await offModule.close();
      }
    });
  });
});
