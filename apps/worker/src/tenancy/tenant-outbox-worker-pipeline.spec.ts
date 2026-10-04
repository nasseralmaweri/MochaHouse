import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  TENANT_1_MOCHA_HOUSE_ID,
  getCurrentTenantContext,
} from '@mocha-house/database';
import { TEST_TENANT_B_ID, createTestTenantB, removeTestTenantB } from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SENDER } from '../notifications/email/email-sender';
import { LoggingEmailSender } from '../notifications/email/logging-email-sender';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { OutboxProcessorService } from '../outbox/outbox-processor.service';
import { WorkerTenancyModule } from './worker-tenancy.module';

// Milestone S0D-2C-2 — the genuine, end-to-end two-tenant proof: a real
// claimed-by-OutboxProcessorService -> per-event WorkerTenantContext ->
// NotificationDispatchService.resolve() -> NotificationDelivery pipeline,
// for two tenants processed in the same batch, plus a deliberately
// mismatched event/aggregate combination proving it fails closed rather
// than ever disclosing the wrong tenant's data.
describe('S0D-2C-2 two-tenant outbox -> worker -> notification pipeline (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let processor: OutboxProcessorService;
  let sender: LoggingEmailSender;
  const suffix = randomUUID();

  const locationIds: string[] = [];
  const paymentAttemptIds: string[] = [];
  const orderIds: string[] = [];
  const outboxEventIds: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, WorkerTenancyModule],
      providers: [
        OutboxProcessorService,
        NotificationDispatchService,
        LoggingEmailSender,
        { provide: EMAIL_SENDER, useExisting: LoggingEmailSender },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    processor = moduleRef.get(OutboxProcessorService);
    sender = moduleRef.get(LoggingEmailSender);
    await prisma.$connect();
    await createTestTenantB(prisma);
  });

  afterEach(() => {
    sender.clear();
  });

  afterAll(async () => {
    await prisma.notificationDelivery.deleteMany({
      where: { outboxEventId: { in: outboxEventIds } },
    });
    await prisma.outboxEvent.deleteMany({ where: { id: { in: outboxEventIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.paymentAttempt.deleteMany({
      where: { id: { in: paymentAttemptIds } },
    });
    await prisma.location.deleteMany({ where: { id: { in: locationIds } } });
    await removeTestTenantB(prisma);
    await moduleRef.close();
    await prisma.$disconnect();
  });

  async function makeOrderFixture(tenantId: string, guestEmail: string) {
    const location = await prisma.location.create({
      data: {
        tenantId,
        name: `S0D2C2 Pipeline ${suffix} ${randomUUID().slice(0, 8)}`,
        slug: `s0d2c2-pipeline-${suffix}-${randomUUID().slice(0, 8)}`,
        isActive: true,
        isDigitalOrderingEnabled: true,
      },
    });
    locationIds.push(location.id);

    const paymentAttempt = await prisma.paymentAttempt.create({
      data: {
        tenantId,
        idempotencyKey: `s0d2c2-pipeline-${randomUUID()}`,
        provider: 'fake',
        status: 'SUCCEEDED',
        locationId: location.id,
        amount: 500,
        currency: 'USD',
      },
    });
    paymentAttemptIds.push(paymentAttempt.id);

    const order = await prisma.order.create({
      data: {
        tenantId,
        orderNumber: `S0D2C2-${randomUUID().slice(0, 8)}`,
        accessToken: randomUUID(),
        locationId: location.id,
        paymentAttemptId: paymentAttempt.id,
        guestName: 'Pipeline Guest',
        guestPhone: '5551230000',
        guestEmail,
        currency: 'USD',
        subtotal: 500,
        status: 'RECEIVED',
      },
    });
    orderIds.push(order.id);
    return order;
  }

  async function makeClaimableEvent(
    tenantId: string,
    aggregateId: string,
  ): Promise<string> {
    const event = await prisma.outboxEvent.create({
      data: {
        tenantId,
        aggregateType: 'Order',
        aggregateId,
        eventType: 'order.checkout.completed',
        payload: {},
      },
    });
    outboxEventIds.push(event.id);
    return event.id;
  }

  async function waitUntilProcessed(eventId: string) {
    for (let attempt = 0; attempt < 25; attempt++) {
      await processor.processPendingBatch(200);
      const event = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: eventId },
      });
      if (event.status === 'PROCESSED') {
        return;
      }
    }
    throw new Error(`Event ${eventId} was never processed.`);
  }

  it('Tenant A event -> Tenant A context -> Tenant A aggregate -> Tenant A NotificationDelivery, and the same for Tenant B, in the same batch', async () => {
    const guestEmailA = `tenant-a-${randomUUID()}@example.com`;
    const guestEmailB = `tenant-b-${randomUUID()}@example.com`;
    const orderA = await makeOrderFixture(TENANT_1_MOCHA_HOUSE_ID, guestEmailA);
    const orderB = await makeOrderFixture(TEST_TENANT_B_ID, guestEmailB);

    const eventA = await makeClaimableEvent(TENANT_1_MOCHA_HOUSE_ID, orderA.id);
    const eventB = await makeClaimableEvent(TEST_TENANT_B_ID, orderB.id);

    await waitUntilProcessed(eventA);
    await waitUntilProcessed(eventB);

    // The ambient worker TenantContext is scoped to each dispatch and
    // never leaks past it.
    expect(getCurrentTenantContext()).toBeUndefined();

    const deliveryA = await prisma.notificationDelivery.findFirstOrThrow({
      where: { outboxEventId: eventA },
    });
    const deliveryB = await prisma.notificationDelivery.findFirstOrThrow({
      where: { outboxEventId: eventB },
    });

    expect(deliveryA.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
    expect(deliveryA.status).toBe('SENT');
    expect(deliveryA.recipient).toBe(guestEmailA);

    expect(deliveryB.tenantId).toBe(TEST_TENANT_B_ID);
    expect(deliveryB.status).toBe('SENT');
    expect(deliveryB.recipient).toBe(guestEmailB);

    // Explicit non-disclosure: neither tenant's delivery ever carries the
    // other's recipient, and the two emails actually sent match up
    // one-to-one with their own tenant's guest address.
    expect(deliveryA.recipient).not.toBe(guestEmailB);
    expect(deliveryB.recipient).not.toBe(guestEmailA);
    const sentTo = sender.getSent().map((m) => m.to);
    expect(sentTo).toContain(guestEmailA);
    expect(sentTo).toContain(guestEmailB);
  });

  it('a deliberately mismatched event (Tenant A claiming a Tenant B order) fails closed: PROCESSED outbox, FAILED delivery, no email, no disclosure', async () => {
    const guestEmailB = `tenant-b-mismatch-${randomUUID()}@example.com`;
    const orderB = await makeOrderFixture(TEST_TENANT_B_ID, guestEmailB);
    // The event itself claims Tenant #1 even though the Order it names is
    // actually Tenant B's — the exact corruption/misproduction scenario
    // this pipeline must never trust.
    const mismatchedEvent = await makeClaimableEvent(
      TENANT_1_MOCHA_HOUSE_ID,
      orderB.id,
    );

    await waitUntilProcessed(mismatchedEvent);

    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { outboxEventId: mismatchedEvent },
    });
    expect(delivery.status).toBe('FAILED');
    expect(delivery.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
    expect(delivery.recipient).not.toBe(guestEmailB);
    expect(sender.getSent().map((m) => m.to)).not.toContain(guestEmailB);

    // The outbox claim itself is unaffected by the downstream failure —
    // same invariant as every other dispatch failure (see
    // outbox-processor.service.ts: notification outcome never reopens the
    // claim).
    const event = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: mismatchedEvent },
    });
    expect(event.status).toBe('PROCESSED');
  });
});
