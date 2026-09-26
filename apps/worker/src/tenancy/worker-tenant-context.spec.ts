import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  TENANT_1_MOCHA_HOUSE_ID,
  TenantConfigurationError,
  getCurrentTenantContext,
  type TenantContext,
} from '@mocha-house/database';
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
    it('gives each unit of work a worker context for the configured tenant', async () => {
      const moduleRef = await compileWith(TENANT_1_MOCHA_HOUSE_ID);
      try {
        const factory = moduleRef.get(WorkerTenantContextFactory);
        const first = factory.forOutboxEvent({ id: 'event-1' });
        const second = factory.forOutboxEvent({ id: 'event-2' });

        expect(first).toMatchObject({
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          principalType: 'worker',
        });
        expect(Object.isFrozen(first)).toBe(true);
        expect(first.requestId).not.toBe(second.requestId);
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

      const event = await sharedPrisma.outboxEvent.create({
        data: {
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
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          principalType: 'worker',
        });
        // The context is scoped to the dispatch, not left behind.
        expect(getCurrentTenantContext()).toBeUndefined();
      } finally {
        await sharedPrisma.outboxEvent.deleteMany({ where: { id: event.id } });
        await moduleRef.close();
      }
    });
  });
});
