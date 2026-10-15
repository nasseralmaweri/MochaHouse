import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import { removeTestTenant } from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SENDER } from '../notifications/email/email-sender';
import type {
  EmailSender,
  SendEmailInput,
  SendEmailResult,
} from '../notifications/email/email-sender';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { NotificationRecipientResolver } from '../notifications/notification-recipient-resolver.service';
import { OUTBOX_CONFIG, type OutboxConfig } from '../outbox/outbox.config';
import { OutboxProcessorService } from '../outbox/outbox-processor.service';
import { OutboxStore, type Claim } from '../outbox/outbox-store';
import { WorkerTenancyModule } from './worker-tenancy.module';

// SC0.5a — the worker never runs a SUSPENDED business's background work, and
// never loses it either. Real PostgreSQL, real OutboxStore / processor /
// dispatch; only the email provider is a recorder.
//
// The suspended business is a test-only tenant created and removed here (it
// is never Mocha House: Tenant #1 is only ever ACTIVE in this suite, and the
// suite proves it keeps working while another business is suspended).

jest.setTimeout(120_000);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// A test-only business (the 7e57 marker makes it deletable by the shared
// disposable-database guard).
const TENANT_S = '01a0db02-f800-7000-8000-7e570000050a';

class RecordingSender implements EmailSender {
  readonly calls: SendEmailInput[] = [];
  sentTo(to: string): number {
    return this.calls.filter((c) => c.to === to).length;
  }
  send(input: SendEmailInput): Promise<SendEmailResult> {
    this.calls.push(input);
    return Promise.resolve({ providerMessageId: `msg-${randomUUID()}` });
  }
}

describe('Tenant suspension — worker (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let store: OutboxStore;
  let processor: OutboxProcessorService;
  const sender = new RecordingSender();
  const suffix = randomUUID().slice(0, 8);

  const config: OutboxConfig = {
    enabled: true,
    concurrency: 1,
    pollIntervalMs: 50,
    leaseSeconds: 60,
    sendTimeoutMs: 1000,
    minLeaseRemainingMs: 1000,
    maxAttempts: 4,
    backoffBaseMs: 30_000,
    backoffCapMs: 60_000,
    shutdownGraceMs: 3000,
    // Rows left behind by other suites are never claimed by this one.
    historicalCutoff: new Date(Date.now() - 10 * DAY),
    workerId: 'sc05a-test-worker',
  };

  const locationIds: string[] = [];
  const attemptIds: string[] = [];
  const orderIds: string[] = [];
  const eventIds: string[] = [];

  const setStatus = (status: 'ACTIVE' | 'SUSPENDED') =>
    prisma.tenant.update({
      where: { id: TENANT_S },
      data:
        status === 'SUSPENDED'
          ? { status, suspensionReason: 'BILLING' }
          : { status, suspensionReason: null },
    });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, WorkerTenancyModule],
      providers: [
        OutboxStore,
        OutboxProcessorService,
        NotificationDispatchService,
        NotificationRecipientResolver,
        { provide: OUTBOX_CONFIG, useValue: config },
        { provide: EMAIL_SENDER, useValue: sender },
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    store = moduleRef.get(OutboxStore);
    processor = moduleRef.get(OutboxProcessorService);
    await prisma.$connect();
    await prisma.tenant.upsert({
      where: { id: TENANT_S },
      update: { status: 'ACTIVE', suspensionReason: null },
      create: {
        id: TENANT_S,
        slug: 'sc05a-test-tenant-s',
        name: 'SC0.5a Test Tenant S (suspension tests only)',
        status: 'ACTIVE',
      },
    });
  });

  afterEach(async () => {
    // Never leave the test business suspended for a later test.
    await setStatus('ACTIVE');
  });

  afterAll(async () => {
    await prisma.notificationDelivery.deleteMany({
      where: { outboxEventId: { in: eventIds } },
    });
    await prisma.outboxEvent.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.paymentAttempt.deleteMany({
      where: { id: { in: attemptIds } },
    });
    await prisma.location.deleteMany({ where: { id: { in: locationIds } } });
    await removeTestTenant(prisma, TENANT_S);
    await moduleRef.close();
    await prisma.$disconnect();
  });

  // An order and its "checkout completed" notification event.
  async function scenario(tenantId: string) {
    const email = `sc05a-${randomUUID()}@example.test`;
    const location = await prisma.location.create({
      data: {
        tenantId,
        name: `SC05a ${suffix} ${randomUUID().slice(0, 6)}`,
        slug: `sc05a-${suffix}-${randomUUID().slice(0, 8)}`,
        isActive: true,
        isDigitalOrderingEnabled: true,
      },
    });
    locationIds.push(location.id);
    const attempt = await prisma.paymentAttempt.create({
      data: {
        tenantId,
        idempotencyKey: `sc05a-${randomUUID()}`,
        provider: 'fake',
        status: 'SUCCEEDED',
        locationId: location.id,
        amount: 500,
        currency: 'USD',
      },
    });
    attemptIds.push(attempt.id);
    const order = await prisma.order.create({
      data: {
        tenantId,
        orderNumber: `SC05A-${randomUUID().slice(0, 8)}`,
        accessToken: randomUUID(),
        locationId: location.id,
        paymentAttemptId: attempt.id,
        guestName: 'Suspension Guest',
        guestPhone: '5551230000',
        guestEmail: email,
        currency: 'USD',
        subtotal: 500,
        status: 'RECEIVED',
      },
    });
    orderIds.push(order.id);
    const event = await prisma.outboxEvent.create({
      data: {
        tenantId,
        aggregateType: 'Order',
        aggregateId: order.id,
        eventType: 'order.checkout.completed',
        payload: {},
      },
    });
    eventIds.push(event.id);
    return { eventId: event.id, orderId: order.id, email };
  }

  const reload = (id: string) =>
    prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
  const drain = () => processor.processPendingBatch(200);

  it('an ACTIVE business is processed normally', async () => {
    const s = await scenario(TENANT_S);
    await drain();
    expect((await reload(s.eventId)).status).toBe('PROCESSED');
    expect(sender.sentTo(s.email)).toBe(1);
  });

  it('a SUSPENDED business is not processed, its work is kept intact, and Tenant #1 keeps working in the same pass', async () => {
    const held = await scenario(TENANT_S);
    const mocha = await scenario(TENANT_1_MOCHA_HOUSE_ID);
    const before = await reload(held.eventId);
    await setStatus('SUSPENDED');

    await drain();

    const after = await reload(held.eventId);
    expect(after).toMatchObject({
      status: 'PENDING',
      attemptCount: before.attemptCount,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      failedAt: null,
      processedAt: null,
    });
    expect(after.nextAttemptAt).toEqual(before.nextAttemptAt);
    expect(sender.sentTo(held.email)).toBe(0);
    expect(
      await prisma.notificationDelivery.count({
        where: { outboxEventId: held.eventId },
      }),
    ).toBe(0);

    // Mocha House (ACTIVE) is unaffected.
    expect((await reload(mocha.eventId)).status).toBe('PROCESSED');
    expect(sender.sentTo(mocha.email)).toBe(1);
  });

  it('retry information recorded before the suspension survives it unchanged', async () => {
    const s = await scenario(TENANT_S);
    const nextAttemptAt = new Date(Date.now() - 60_000);
    await prisma.outboxEvent.update({
      where: { id: s.eventId },
      data: {
        attemptCount: 2,
        lastErrorCode: 'THROTTLING',
        lastError: 'THROTTLING: Slow down.',
        nextAttemptAt,
      },
    });
    await setStatus('SUSPENDED');

    await drain();

    expect(await reload(s.eventId)).toMatchObject({
      status: 'PENDING',
      attemptCount: 2,
      lastErrorCode: 'THROTTLING',
      lastError: 'THROTTLING: Slow down.',
      nextAttemptAt,
      leaseOwner: null,
    });
    expect(sender.sentTo(s.email)).toBe(0);
  });

  it('the backlog snapshot reports held work separately and never as "due"', async () => {
    await scenario(TENANT_S);
    const active = await store.snapshot();
    await setStatus('SUSPENDED');
    const suspended = await store.snapshot();

    expect(suspended.heldBySuspension).toBeGreaterThanOrEqual(
      active.heldBySuspension + 1,
    );
    expect(suspended.dueNow).toBeLessThanOrEqual(active.dueNow - 1);
  });

  it('reactivation restores processing: held work is delivered exactly once', async () => {
    const s = await scenario(TENANT_S);
    await setStatus('SUSPENDED');
    await drain();
    expect(sender.sentTo(s.email)).toBe(0);

    await setStatus('ACTIVE');
    await drain();
    await drain();

    const event = await reload(s.eventId);
    expect(event.status).toBe('PROCESSED');
    expect(event.attemptCount).toBe(1);
    expect(sender.sentTo(s.email)).toBe(1);
  });

  it('a business suspended after its event was claimed: the claim is handed back unsent, without using up an attempt', async () => {
    const s = await scenario(TENANT_S);
    const before = await reload(s.eventId);
    // Suspend the business right after the real claim is taken.
    const realStore = new OutboxStore(prisma, config);
    const spy = jest.spyOn(store, 'claimNext').mockImplementation(async () => {
      const claim: Claim | null = await realStore.claimNext();
      if (claim?.eventId === s.eventId) await setStatus('SUSPENDED');
      return claim;
    });
    try {
      await drain();
    } finally {
      spy.mockRestore();
    }

    expect(await reload(s.eventId)).toMatchObject({
      status: 'PENDING',
      attemptCount: before.attemptCount,
      leaseOwner: null,
      leaseExpiresAt: null,
      failedAt: null,
    });
    expect(sender.sentTo(s.email)).toBe(0);

    await setStatus('ACTIVE');
    await drain();
    expect((await reload(s.eventId)).status).toBe('PROCESSED');
    expect(sender.sentTo(s.email)).toBe(1);
  });

  it('work that went stale while suspended is dead-lettered as expired on reactivation, never sent late', async () => {
    const s = await scenario(TENANT_S);
    // Expiry is judged by the DATABASE clock (claim.dbNow), so set it there.
    await prisma.$executeRaw`UPDATE "OutboxEvent" SET "expiresAt" = timezone('utc', now()) + interval '2 seconds' WHERE id = ${s.eventId}`;
    await setStatus('SUSPENDED');
    await drain();
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    await setStatus('ACTIVE');
    await drain();

    const event = await reload(s.eventId);
    expect(event.status).toBe('FAILED');
    expect(event.lastErrorCode).toBe('EVENT_EXPIRED');
    expect(sender.sentTo(s.email)).toBe(0);
  });
});
