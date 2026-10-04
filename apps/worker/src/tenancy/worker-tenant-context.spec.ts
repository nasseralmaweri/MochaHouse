import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  TENANT_1_MOCHA_HOUSE_ID,
  TenantConfigurationError,
  TenantContextError,
  getCurrentTenantContext,
  type TenantContext,
} from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { OutboxProcessorService } from '../outbox/outbox-processor.service';
import { WorkerTenancyModule } from './worker-tenancy.module';
import { WorkerTenantContextFactory } from './worker-tenant-context.factory';

// Milestone S0C — the worker's TenantContext: startup validation, the
// per-event context factory, and outbox dispatch running inside it.
describe('Worker TenantContext (integration)', () => {
  const originalTenantId = process.env.SINGLE_TENANT_ID;
  // Test-owned client shared by every compiled module, so a module that
  // deliberately fails to start cannot leak its own connection pool.
  const sharedPrisma = new PrismaService();

  afterEach(() => {
    process.env.SINGLE_TENANT_ID = originalTenantId;
  });

  afterAll(async () => {
    await sharedPrisma.$disconnect();
  });

  function compileWith(
    tenantId: string | undefined,
    extra: { providers?: unknown[] } = {},
  ): Promise<TestingModule> {
    if (tenantId === undefined) {
      delete process.env.SINGLE_TENANT_ID;
    } else {
      process.env.SINGLE_TENANT_ID = tenantId;
    }
    return Test.createTestingModule({
      imports: [PrismaModule, WorkerTenancyModule],
      providers: (extra.providers ?? []) as never[],
    })
      .overrideProvider(PrismaService)
      .useValue(sharedPrisma)
      .compile();
  }

  describe('startup validation', () => {
    it.each([
      ['missing', undefined],
      ['malformed', 'mocha-house'],
      ['unknown', '01a0db02-f800-7000-8000-00000000dead'],
    ])('fails to start when SINGLE_TENANT_ID is %s', async (_label, value) => {
      await expect(compileWith(value)).rejects.toThrow(
        TenantConfigurationError,
      );
    });
  });

  describe('WorkerTenantContextFactory', () => {
    // Milestone S0D-2C-2 — the event's OWN tenantId is authoritative, not
    // SINGLE_TENANT_ID. The module is still compiled with SINGLE_TENANT_ID
    // = Tenant #1 (startup validation still requires a valid value — see
    // "startup validation" above), but every assertion below uses a
    // DIFFERENT tenant for the event to prove the two are independent.
    it("builds the context from the event's own tenantId, never from SINGLE_TENANT_ID", async () => {
      const moduleRef = await compileWith(TENANT_1_MOCHA_HOUSE_ID);
      try {
        const factory = moduleRef.get(WorkerTenantContextFactory);
        const first = factory.forOutboxEvent({
          id: 'event-1',
          tenantId: TEST_TENANT_B_ID,
        });
        const second = factory.forOutboxEvent({
          id: 'event-2',
          tenantId: TEST_TENANT_B_ID,
        });

        expect(first).toMatchObject({
          tenantId: TEST_TENANT_B_ID,
          principalType: 'worker',
        });
        expect(first.tenantId).not.toBe(TENANT_1_MOCHA_HOUSE_ID);
        expect(Object.isFrozen(first)).toBe(true);
        expect(first.requestId).not.toBe(second.requestId);
      } finally {
        await moduleRef.close();
      }
    });

    it('rebuilds a correct, independent context for consecutive events belonging to different tenants', async () => {
      const moduleRef = await compileWith(TENANT_1_MOCHA_HOUSE_ID);
      try {
        const factory = moduleRef.get(WorkerTenantContextFactory);
        const a = factory.forOutboxEvent({
          id: 'event-a',
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
        });
        const b = factory.forOutboxEvent({
          id: 'event-b',
          tenantId: TEST_TENANT_B_ID,
        });
        const a2 = factory.forOutboxEvent({
          id: 'event-a2',
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
        });

        expect(a.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
        expect(b.tenantId).toBe(TEST_TENANT_B_ID);
        expect(a2.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
        // Each is its own frozen value — the second Tenant #1 event is not
        // somehow the same object as the first, and the Tenant B context
        // in between never leaks into either.
        expect(a).not.toBe(a2);
        expect(a.requestId).not.toBe(a2.requestId);
      } finally {
        await moduleRef.close();
      }
    });

    it('fails closed on a missing or malformed event tenantId — never falls back to SINGLE_TENANT_ID', async () => {
      const moduleRef = await compileWith(TENANT_1_MOCHA_HOUSE_ID);
      try {
        const factory = moduleRef.get(WorkerTenantContextFactory);
        expect(() =>
          factory.forOutboxEvent({
            id: 'event-missing',
            tenantId: '' as unknown as string,
          }),
        ).toThrow(TenantContextError);
        expect(() =>
          factory.forOutboxEvent({
            id: 'event-malformed',
            tenantId: 'not-a-uuid',
          }),
        ).toThrow(TenantContextError);
      } finally {
        await moduleRef.close();
      }
    });
  });

  describe('outbox dispatch', () => {
    it('dispatches each claimed event inside its own worker TenantContext', async () => {
      const seen = new Map<string, TenantContext | undefined>();
      const dispatch = jest.fn((event: { id: string }) => {
        seen.set(event.id, getCurrentTenantContext());
        return Promise.resolve();
      });

      const moduleRef = await compileWith(TENANT_1_MOCHA_HOUSE_ID, {
        providers: [
          OutboxProcessorService,
          { provide: NotificationDispatchService, useValue: { dispatch } },
        ],
      });
      const processor = moduleRef.get(OutboxProcessorService);

      await createTestTenantB(sharedPrisma);
      const event = await sharedPrisma.outboxEvent.create({
        data: {
          // Deliberately Tenant B while SINGLE_TENANT_ID (compileWith
          // above) is Tenant #1 — proves the dispatched context comes
          // from the event's own row, never the worker's configured
          // single-tenant value.
          tenantId: TEST_TENANT_B_ID,
          aggregateType: 'S0CTenantContextProbe',
          aggregateId: randomUUID(),
          eventType: 's0c.tenant_context_probe',
          payload: {},
        },
      });

      try {
        for (let attempt = 0; attempt < 25 && !seen.has(event.id); attempt++) {
          await processor.processPendingBatch(200);
        }

        const context = seen.get(event.id);
        expect(context).toMatchObject({
          tenantId: TEST_TENANT_B_ID,
          principalType: 'worker',
        });
        expect(context?.tenantId).not.toBe(TENANT_1_MOCHA_HOUSE_ID);
        // The context is scoped to the dispatch, not left behind.
        expect(getCurrentTenantContext()).toBeUndefined();
      } finally {
        await sharedPrisma.outboxEvent.deleteMany({ where: { id: event.id } });
        await removeTestTenantB(sharedPrisma);
        await moduleRef.close();
      }
    });
  });
});
