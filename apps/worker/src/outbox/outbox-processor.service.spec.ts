import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { WorkerTenancyModule } from '../tenancy/worker-tenancy.module';
import { WorkerTenantContextFactory } from '../tenancy/worker-tenant-context.factory';
import { EMAIL_SENDER } from '../notifications/email/email-sender';
import type {
  EmailSender,
  SendEmailInput,
  SendEmailResult,
} from '../notifications/email/email-sender';
import { EmailProviderRejection } from '../notifications/delivery-errors';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { NotificationRecipientResolver } from '../notifications/notification-recipient-resolver.service';
import { OUTBOX_CONFIG, type OutboxConfig } from './outbox.config';
import { OutboxProcessorService } from './outbox-processor.service';
import { OutboxStore, type Claim } from './outbox-store';

// R1 / S4b — the reliable notification worker, against real PostgreSQL and a
// scripted email provider. Every failure boundary is exercised: crash before
// and after the claim, crash after the delivery intent, provider timeout,
// acceptance before the database record, lease expiry and stale-worker fencing,
// concurrent workers, throttling and recovery, permanent failure, retry
// exhaustion, expiry, shutdown, and tenant isolation.

jest.setTimeout(120_000);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Behavior = 'accept' | 'throttle' | 'reject' | 'hang' | 'unknown-error';

// A scripted provider. Behaviours are queued per recipient (default: accept),
// so each test controls exactly what the "provider" does to its own recipient.
class ScriptedSender implements EmailSender {
  readonly calls: SendEmailInput[] = [];
  inFlight = 0;
  maxInFlight = 0;
  holdMs = 0;
  private readonly script = new Map<string, Behavior[]>();

  queue(to: string, ...behaviors: Behavior[]): void {
    this.script.set(to, [...(this.script.get(to) ?? []), ...behaviors]);
  }
  sentTo(to: string): number {
    return this.calls.filter((c) => c.to === to).length;
  }
  reset(): void {
    this.calls.length = 0;
    this.script.clear();
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.holdMs = 0;
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    this.calls.push(input);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.holdMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.holdMs));
      }
      const behavior = this.script.get(input.to)?.shift() ?? 'accept';
      switch (behavior) {
        case 'accept':
          return { providerMessageId: `msg-${randomUUID()}` };
        case 'throttle':
          throw new EmailProviderRejection('Throttling', 'Slow down.', true);
        case 'reject':
          throw new EmailProviderRejection(
            'MessageRejected',
            'Rejected.',
            false,
          );
        case 'unknown-error':
          throw new Error('socket hang up');
        case 'hang':
          await new Promise<never>(() => undefined);
      }
      throw new Error('unreachable');
    } finally {
      this.inFlight -= 1;
    }
  }
}

describe('OutboxProcessorService — reliable delivery (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let store: OutboxStore;
  let processor: OutboxProcessorService;
  let dispatch: NotificationDispatchService;
  let tenantContexts: WorkerTenantContextFactory;
  const sender = new ScriptedSender();
  const suffix = randomUUID().slice(0, 8);

  // Events older than this are never claimed, so rows left by other suites
  // cannot interfere. Wide enough for the staleness tests that back-date events.
  const suiteCutoff = new Date(Date.now() - 10 * DAY);

  const config: { -readonly [K in keyof OutboxConfig]: OutboxConfig[K] } = {
    enabled: true,
    concurrency: 2,
    pollIntervalMs: 50,
    leaseSeconds: 60,
    sendTimeoutMs: 300,
    minLeaseRemainingMs: 1000,
    maxAttempts: 4,
    backoffBaseMs: 30_000, // long enough that a retry is never due again within one drain
    backoffCapMs: 60_000,
    shutdownGraceMs: 3000,
    historicalCutoff: suiteCutoff,
    workerId: 'test-worker-1',
  };
  const defaults = { ...config };

  const locationIds: string[] = [];
  const attemptIds: string[] = [];
  const orderIds: string[] = [];
  const eventIds: string[] = [];

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
    dispatch = moduleRef.get(NotificationDispatchService);
    tenantContexts = moduleRef.get(WorkerTenantContextFactory);
    await prisma.$connect();
    await createTestTenantB(prisma);
  });

  beforeEach(() => {
    sender.reset();
    Object.assign(config, defaults);
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
    await removeTestTenantB(prisma);
    await moduleRef.close();
    await prisma.$disconnect();
  });

  // ---- fixtures -----------------------------------------------------------

  async function makeOrder(tenantId: string, guestEmail: string | null) {
    const location = await prisma.location.create({
      data: {
        tenantId,
        name: `S4b ${suffix} ${randomUUID().slice(0, 6)}`,
        slug: `s4b-${suffix}-${randomUUID().slice(0, 8)}`,
        isActive: true,
        isDigitalOrderingEnabled: true,
      },
    });
    locationIds.push(location.id);
    const attempt = await prisma.paymentAttempt.create({
      data: {
        tenantId,
        idempotencyKey: `s4b-${randomUUID()}`,
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
        orderNumber: `S4B-${randomUUID().slice(0, 8)}`,
        accessToken: randomUUID(),
        locationId: location.id,
        paymentAttemptId: attempt.id,
        guestName: 'Reliability Guest',
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

  // An order plus its notification event. `email` is unique per call.
  async function scenario(
    options: {
      tenantId?: string;
      email?: string | null;
      eventType?: string;
      createdAt?: Date;
      expiresAt?: Date;
    } = {},
  ) {
    const tenantId = options.tenantId ?? TENANT_1_MOCHA_HOUSE_ID;
    const email =
      options.email === undefined
        ? `s4b-${randomUUID()}@example.test`
        : options.email;
    const order = await makeOrder(tenantId, email);
    const event = await prisma.outboxEvent.create({
      data: {
        tenantId,
        aggregateType: 'Order',
        aggregateId: order.id,
        eventType: options.eventType ?? 'order.checkout.completed',
        payload: {},
        ...(options.createdAt ? { createdAt: options.createdAt } : {}),
        ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      },
    });
    eventIds.push(event.id);
    return {
      orderId: order.id,
      eventId: event.id,
      email: email ?? '',
      tenantId,
    };
  }

  type Scenario = Awaited<ReturnType<typeof scenario>>;

  const reload = (id: string) =>
    prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
  const deliveryOf = (eventId: string) =>
    prisma.notificationDelivery.findUnique({
      where: {
        outboxEventId_channel: { outboxEventId: eventId, channel: 'EMAIL' },
      },
    });
  const makeDue = (id: string) =>
    prisma.$executeRaw`UPDATE "OutboxEvent" SET "nextAttemptAt" = timezone('utc', now()) - interval '1 second' WHERE id = ${id}`;
  const expireLease = (id: string) =>
    prisma.$executeRaw`UPDATE "OutboxEvent" SET "leaseExpiresAt" = timezone('utc', now()) - interval '1 second' WHERE id = ${id}`;
  const drain = () => processor.processPendingBatch(200);

  // A fresh processor (own stop flag, own counters) for tests that stop it.
  function newProcessor(overrides: Partial<OutboxConfig> = {}) {
    const cfg = { ...config, ...overrides };
    return new OutboxProcessorService(
      new OutboxStore(prisma, cfg),
      dispatch,
      tenantContexts,
      cfg,
    );
  }

  const eventOf = (s: {
    eventId: string;
    orderId: string;
    tenantId: string;
  }) => ({
    id: s.eventId,
    tenantId: s.tenantId,
    aggregateType: 'Order',
    aggregateId: s.orderId,
    eventType: 'order.checkout.completed',
  });

  // Claims exactly the given event (other due rows may exist): claim until it is
  // ours, handing everything else back.
  async function claimSpecific(eventId: string) {
    const others: Claim[] = [];
    for (let i = 0; i < 100; i += 1) {
      const claim = await store.claimNext();
      if (!claim) break;
      if (claim.eventId === eventId) {
        for (const other of others) await store.release(other);
        return claim;
      }
      others.push(claim);
    }
    for (const other of others) await store.release(other);
    throw new Error(`Could not claim ${eventId}`);
  }

  // -----------------------------------------------------------------------

  describe('normal delivery', () => {
    it('sends once, records provider acceptance, and only then marks the event PROCESSED', async () => {
      const s = await scenario();
      await drain();

      const event = await reload(s.eventId);
      expect(event.status).toBe('PROCESSED');
      expect(event.processedAt).not.toBeNull();
      expect(event.leaseOwner).toBeNull();
      expect(event.leaseExpiresAt).toBeNull();
      expect(event.attemptCount).toBe(1);
      expect(event.failedAt).toBeNull();

      const delivery = await deliveryOf(s.eventId);
      expect(delivery).toMatchObject({
        status: 'SENT',
        recipient: s.email,
        tenantId: s.tenantId,
        possibleDuplicate: false,
      });
      expect(delivery?.sendStartedAt).not.toBeNull(); // intent was recorded first
      expect(delivery?.sentAt).not.toBeNull();
      expect(delivery?.providerMessageId).toMatch(/^msg-/);
      expect(sender.sentTo(s.email)).toBe(1);
    });

    it('does not process an event twice on later runs', async () => {
      const s = await scenario();
      await drain();
      const first = await reload(s.eventId);
      await drain();
      await drain();
      const later = await reload(s.eventId);
      expect(later.processedAt?.getTime()).toBe(first.processedAt?.getTime());
      expect(later.attemptCount).toBe(1);
      expect(sender.sentTo(s.email)).toBe(1);
    });

    it('completes an event type with no notification without sending anything', async () => {
      const s = await scenario({ eventType: 'fixture.no-handler' });
      await drain();
      expect((await reload(s.eventId)).status).toBe('PROCESSED');
      expect(await deliveryOf(s.eventId)).toBeNull();
      expect(sender.calls).toHaveLength(0);
    });

    it('keeps the order itself untouched by any notification outcome (the shop queue reads Order only)', async () => {
      const failing = await scenario({ email: null });
      const throttled = await scenario();
      sender.queue(throttled.email, 'throttle');
      await drain();
      for (const s of [failing, throttled]) {
        const order = await prisma.order.findUniqueOrThrow({
          where: { id: s.orderId },
        });
        expect(order.status).toBe('RECEIVED');
      }
      expect((await reload(failing.eventId)).status).toBe('FAILED');
      expect((await reload(throttled.eventId)).status).toBe('PENDING');
    });
  });

  describe('claiming and fencing', () => {
    it('a claimed event is leased: another worker cannot take it until the lease expires', async () => {
      const s = await scenario();
      const claim = await claimSpecific(s.eventId);
      expect(claim.generation).toBe(1);
      const leased = await reload(s.eventId);
      expect(leased.leaseOwner).toBe(claim.owner);
      expect(leased.leaseExpiresAt!.getTime()).toBeGreaterThan(
        Date.now() - 5000,
      );

      await drain(); // another worker's pass
      expect(sender.sentTo(s.email)).toBe(0);
      expect((await reload(s.eventId)).attemptCount).toBe(1);
    });

    it('crash after the claim, before anything else: the lease expires and the event is delivered exactly once', async () => {
      const s = await scenario();
      await claimSpecific(s.eventId); // ...and the worker dies
      await expireLease(s.eventId);
      await drain();
      const event = await reload(s.eventId);
      expect(event.status).toBe('PROCESSED');
      expect(event.attemptCount).toBe(2);
      expect(sender.sentTo(s.email)).toBe(1);
      expect((await deliveryOf(s.eventId))?.possibleDuplicate).toBe(false);
    });

    it('a stale worker cannot commit: its fenced writes change nothing after the event was re-claimed', async () => {
      const s = await scenario();
      const stale = await claimSpecific(s.eventId);
      await expireLease(s.eventId);
      const fresh = await claimSpecific(s.eventId);
      expect(fresh.generation).toBe(2);
      expect(fresh.owner).not.toBe(stale.owner);

      expect(await store.complete(stale)).toBe(false);
      expect(await store.reschedule(stale, 0, 'X', 'x')).toBe(false);
      expect(await store.deadLetter(stale, 'X', 'x')).toBe(false);
      expect(await store.release(stale)).toBe(false);
      expect((await reload(s.eventId)).status).toBe('PENDING');

      expect(await store.complete(fresh)).toBe(true);
      expect((await reload(s.eventId)).status).toBe('PROCESSED');
    });

    it('the generation and tenant are part of the fence, not just the owner token', async () => {
      const s = await scenario();
      const claim = await claimSpecific(s.eventId);
      expect(
        await store.complete({ ...claim, generation: claim.generation + 1 }),
      ).toBe(false);
      expect(
        await store.complete({ ...claim, tenantId: TEST_TENANT_B_ID }),
      ).toBe(false);
      expect(await store.complete(claim)).toBe(true);
    });

    it('a worker that lost its claim never sends', async () => {
      const s = await scenario();
      const stale = await claimSpecific(s.eventId);
      await expireLease(s.eventId);
      await claimSpecific(s.eventId); // someone else owns it now
      const outcome = await dispatch.dispatch(eventOf(s), {
        beginSend: (deliveryId, flag) =>
          store.beginSend(stale, deliveryId, flag),
      });
      expect(outcome.kind).toBe('lost-claim');
      expect(sender.calls).toHaveLength(0);
    });

    it('never begins a send it could not finish before the lease runs out', async () => {
      const s = await scenario();
      const claim = await claimSpecific(s.eventId);
      await prisma.$executeRaw`UPDATE "OutboxEvent" SET "leaseExpiresAt" = timezone('utc', now()) + interval '200 milliseconds' WHERE id = ${s.eventId}`;
      const outcome = await dispatch.dispatch(eventOf(s), {
        beginSend: (id, flag) => store.beginSend(claim, id, flag),
      });
      expect(outcome.kind).toBe('lost-claim');
      expect(sender.calls).toHaveLength(0);
    });
  });

  describe('crash recovery around the provider call', () => {
    it('crash after the delivery intent is recorded: the retry is allowed once and flagged possibleDuplicate', async () => {
      const s = await scenario();
      const claim = await claimSpecific(s.eventId);
      // The first worker records its intent, starts the send, and dies.
      sender.holdMs = 0;
      sender.queue(s.email, 'hang');
      const hung = dispatch.dispatch(eventOf(s), {
        beginSend: (id, flag) => store.beginSend(claim, id, flag),
      });
      void hung.catch(() => undefined); // the "dead" worker's promise is abandoned
      for (let i = 0; i < 40 && sender.calls.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const midway = await deliveryOf(s.eventId);
      expect(midway?.sendStartedAt).not.toBeNull();
      expect(midway?.sentAt).toBeNull();

      await expireLease(s.eventId);
      sender.reset();
      await drain();

      const delivery = await deliveryOf(s.eventId);
      expect(delivery?.status).toBe('SENT');
      expect(delivery?.possibleDuplicate).toBe(true);
      expect((await reload(s.eventId)).status).toBe('PROCESSED');
      expect(sender.sentTo(s.email)).toBe(1);
    });

    it('provider acceptance recorded but the event not yet PROCESSED (crash): recovery completes it WITHOUT sending again', async () => {
      const s = await scenario();
      const claim = await claimSpecific(s.eventId);
      const outcome = await dispatch.dispatch(eventOf(s), {
        beginSend: (id, flag) => store.beginSend(claim, id, flag),
      });
      expect(outcome.kind).toBe('accepted');
      // ...the worker dies here, before store.complete(claim).
      expect((await reload(s.eventId)).status).toBe('PENDING');
      expect((await deliveryOf(s.eventId))?.status).toBe('SENT');

      await expireLease(s.eventId);
      await drain();
      expect((await reload(s.eventId)).status).toBe('PROCESSED');
      expect(sender.sentTo(s.email)).toBe(1); // still just the original send
      expect((await deliveryOf(s.eventId))?.possibleDuplicate).toBe(false);
    });

    it('provider accepted but the database could not record it: retried later as ambiguous, then delivered with possibleDuplicate (a duplicate is possible and flagged)', async () => {
      const s = await scenario();
      const deliveryModel = prisma.notificationDelivery as unknown as {
        updateMany: (args: { data?: { status?: string } }) => Promise<unknown>;
      };
      const originalUpdateMany = deliveryModel.updateMany;
      const spy = jest
        .spyOn(deliveryModel, 'updateMany')
        .mockImplementation((args) => {
          if (args?.data?.status === 'SENT') {
            return Promise.reject(new Error('connection lost'));
          }
          return originalUpdateMany.call(
            deliveryModel,
            args,
          ) as Promise<unknown>;
        });
      try {
        await drain();
      } finally {
        spy.mockRestore();
      }
      const afterFailure = await reload(s.eventId);
      expect(afterFailure.status).toBe('PENDING');
      expect(afterFailure.lastErrorCode).toBe('ACCEPTANCE_NOT_RECORDED');
      expect((await deliveryOf(s.eventId))?.status).toBe('PENDING');
      expect(sender.sentTo(s.email)).toBe(1);

      await makeDue(s.eventId);
      await drain();
      expect((await reload(s.eventId)).status).toBe('PROCESSED');
      const delivery = await deliveryOf(s.eventId);
      expect(delivery?.status).toBe('SENT');
      expect(delivery?.possibleDuplicate).toBe(true);
      expect(sender.sentTo(s.email)).toBe(2);
    });
  });

  describe('provider failures and retries', () => {
    it('a timeout is ambiguous: scheduled for retry, intent left unresolved, then delivered once with possibleDuplicate', async () => {
      const s = await scenario();
      sender.queue(s.email, 'hang');
      await drain();

      const event = await reload(s.eventId);
      expect(event.status).toBe('PENDING');
      expect(event.lastErrorCode).toBe('SEND_TIMEOUT');
      expect(event.leaseOwner).toBeNull();
      const delivery = await deliveryOf(s.eventId);
      expect(delivery).toMatchObject({
        status: 'PENDING',
        sentAt: null,
        failureReason: null,
      });
      expect(delivery?.sendStartedAt).not.toBeNull();
      expect(processor.getCounters().ambiguous).toBeGreaterThanOrEqual(1);

      await makeDue(s.eventId);
      await drain();
      expect((await reload(s.eventId)).status).toBe('PROCESSED');
      expect((await deliveryOf(s.eventId))?.possibleDuplicate).toBe(true);
      expect(sender.sentTo(s.email)).toBe(2);
    });

    it('two ambiguous sends in a row are escalated to the dead letter, not repeated', async () => {
      const s = await scenario();
      sender.queue(s.email, 'hang', 'unknown-error');
      await drain(); // ambiguous #1 (timeout)
      await makeDue(s.eventId);
      await drain(); // ambiguous #2 (flagged retry, unknown error)
      expect((await reload(s.eventId)).status).toBe('PENDING');
      await makeDue(s.eventId);
      await drain(); // third claim: escalate without sending

      const event = await reload(s.eventId);
      expect(event.status).toBe('FAILED');
      expect(event.lastErrorCode).toBe('AMBIGUOUS_REPEATED');
      expect(event.failedAt).not.toBeNull();
      const delivery = await deliveryOf(s.eventId);
      expect(delivery?.status).toBe('FAILED');
      expect(delivery?.possibleDuplicate).toBe(true);
      expect(sender.sentTo(s.email)).toBe(2);
    });

    it('throttling is a definite failure: backed off, retried, recovers, and is NOT flagged as a duplicate', async () => {
      const s = await scenario();
      sender.queue(s.email, 'throttle', 'throttle');

      await drain();
      let event = await reload(s.eventId);
      expect(event.status).toBe('PENDING');
      expect(event.attemptCount).toBe(1);
      expect(event.lastErrorCode).toBe('THROTTLING');
      expect(event.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() - 1000);
      await drain(); // not due yet: untouched
      expect((await reload(s.eventId)).attemptCount).toBe(1);

      await makeDue(s.eventId);
      await drain();
      event = await reload(s.eventId);
      expect(event.attemptCount).toBe(2);
      expect(event.status).toBe('PENDING');

      await makeDue(s.eventId);
      await drain();
      event = await reload(s.eventId);
      expect(event.status).toBe('PROCESSED');
      expect(event.attemptCount).toBe(3);
      expect((await deliveryOf(s.eventId))?.possibleDuplicate).toBe(false);
      expect(sender.sentTo(s.email)).toBe(3);
    });

    it('a provider rejection that can never succeed is dead-lettered at once', async () => {
      const s = await scenario();
      sender.queue(s.email, 'reject');
      await drain();
      const event = await reload(s.eventId);
      expect(event.status).toBe('FAILED');
      expect(event.lastErrorCode).toBe('MESSAGE_REJECTED');
      expect(event.attemptCount).toBe(1);
      expect((await deliveryOf(s.eventId))?.status).toBe('FAILED');
    });

    it('exhausted retries are dead-lettered with diagnostics and never claimed again', async () => {
      const s = await scenario();
      sender.queue(
        s.email,
        'throttle',
        'throttle',
        'throttle',
        'throttle',
        'throttle',
      );
      for (let i = 0; i < config.maxAttempts; i += 1) {
        await makeDue(s.eventId);
        await drain();
      }
      const event = await reload(s.eventId);
      expect(event.status).toBe('FAILED');
      expect(event.attemptCount).toBe(config.maxAttempts);
      expect(event.lastErrorCode).toBe('RETRIES_EXHAUSTED');
      expect(event.lastError).toContain('Throttling');
      expect(event.failedAt).not.toBeNull();
      expect(event.leaseOwner).toBeNull();
      const delivery = await deliveryOf(s.eventId);
      expect(delivery?.status).toBe('FAILED');
      expect(delivery?.failureReason).toBeTruthy();
      expect(sender.sentTo(s.email)).toBe(config.maxAttempts);

      await drain();
      expect((await reload(s.eventId)).attemptCount).toBe(config.maxAttempts);
    });

    it('a missing recipient is a permanent failure: dead-lettered on the first attempt, nothing sent', async () => {
      const s = await scenario({ email: null });
      await drain();
      const event = await reload(s.eventId);
      expect(event.status).toBe('FAILED');
      expect(event.lastErrorCode).toBe('NO_RECIPIENT');
      expect(event.attemptCount).toBe(1);
      const delivery = await deliveryOf(s.eventId);
      expect(delivery).toMatchObject({
        status: 'FAILED',
        recipient: '(unresolved)',
      });
      expect(sender.calls).toHaveLength(0);
    });
  });

  describe('event-specific expiry (no global age cut-off)', () => {
    it('a "ready for pickup" notice that went stale is dead-lettered unsent, while an older but still useful notice is sent', async () => {
      const staleReady = await scenario({
        eventType: 'order.status.ready',
        createdAt: new Date(Date.now() - 5 * HOUR), // ready notices go stale after 3h
      });
      const oldRecord = await scenario({
        eventType: 'order.checkout.completed',
        createdAt: new Date(Date.now() - 2 * HOUR), // received notices last 12h
      });
      await drain();

      const stale = await reload(staleReady.eventId);
      expect(stale.status).toBe('FAILED');
      expect(stale.lastErrorCode).toBe('EVENT_EXPIRED');
      expect(sender.sentTo(staleReady.email)).toBe(0);
      expect((await reload(oldRecord.eventId)).status).toBe('PROCESSED');
      expect(sender.sentTo(oldRecord.email)).toBe(1);
    });

    it('an explicit expiresAt on the event overrides the type default', async () => {
      const past = await scenario({
        createdAt: new Date(Date.now() - 2 * HOUR),
        expiresAt: new Date(Date.now() - HOUR),
      });
      const future = await scenario({
        eventType: 'order.status.ready',
        createdAt: new Date(Date.now() - 5 * HOUR),
        expiresAt: new Date(Date.now() + HOUR), // explicitly still worth sending
      });
      await drain();
      expect((await reload(past.eventId)).lastErrorCode).toBe('EVENT_EXPIRED');
      expect((await reload(future.eventId)).status).toBe('PROCESSED');
    });

    it('stops retrying once the next attempt would land after the event expires', async () => {
      const s = await scenario({
        eventType: 'order.status.ready',
        createdAt: new Date(Date.now() - 3 * HOUR + 30_000), // ~30 s before it goes stale
      });
      sender.queue(s.email, 'throttle');
      config.backoffBaseMs = 600_000; // the retry would be ten minutes away
      config.backoffCapMs = 600_000;
      await drain();
      const event = await reload(s.eventId);
      expect(event.status).toBe('FAILED');
      expect(event.lastErrorCode).toBe('EVENT_EXPIRED');
    });

    it('events created before the historical cut-off are left untouched for an operator to classify', async () => {
      const old = await scenario({
        createdAt: new Date(Date.now() - 3 * HOUR),
      });
      const recent = await scenario();
      config.historicalCutoff = new Date(Date.now() - HOUR);
      await drain();
      const untouched = await reload(old.eventId);
      expect(untouched).toMatchObject({
        status: 'PENDING',
        attemptCount: 0,
        leaseOwner: null,
      });
      expect(sender.sentTo(old.email)).toBe(0);
      expect((await reload(recent.eventId)).status).toBe('PROCESSED');
    });
  });

  describe('concurrent workers', () => {
    it('several workers draining one backlog deliver every event exactly once', async () => {
      const scenarios: Scenario[] = [];
      for (let i = 0; i < 16; i += 1) {
        scenarios.push(
          await scenario({
            tenantId: i % 2 ? TEST_TENANT_B_ID : TENANT_1_MOCHA_HOUSE_ID,
          }),
        );
      }
      const workers = [1, 2, 3, 4].map((n) =>
        newProcessor({ workerId: `test-worker-${n}` }),
      );
      sender.holdMs = 15; // widen the race window
      await Promise.all(workers.map((w) => w.processPendingBatch(200)));

      for (const s of scenarios) {
        const event = await reload(s.eventId);
        expect(event.status).toBe('PROCESSED');
        expect(event.attemptCount).toBe(1);
        expect(sender.sentTo(s.email)).toBe(1);
      }
    });

    it('the long-running loops respect the configured concurrency and never overlap an event', async () => {
      const looping = newProcessor({ concurrency: 3 });
      const scenarios: Scenario[] = [];
      for (let i = 0; i < 12; i += 1) scenarios.push(await scenario());
      sender.holdMs = 40;
      await looping.onModuleInit();
      try {
        for (let waited = 0; waited < 100; waited += 1) {
          const pending = await prisma.outboxEvent.count({
            where: {
              id: { in: scenarios.map((s) => s.eventId) },
              status: 'PENDING',
            },
          });
          if (pending === 0) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      } finally {
        await looping.stop();
      }
      for (const s of scenarios) {
        expect((await reload(s.eventId)).status).toBe('PROCESSED');
        expect(sender.sentTo(s.email)).toBe(1);
      }
      expect(sender.maxInFlight).toBeLessThanOrEqual(3);
      expect(sender.maxInFlight).toBeGreaterThan(1); // it really ran in parallel
    });
  });

  describe('shutdown', () => {
    it('graceful: stop() lets the attempt in flight finish, then nothing more is claimed', async () => {
      const first = await scenario();
      sender.holdMs = 200; // well inside the 300 ms send timeout
      const looping = newProcessor({ concurrency: 1 });
      await looping.onModuleInit();
      for (let i = 0; i < 80 && sender.calls.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(sender.calls.length).toBeGreaterThan(0); // an attempt is in flight
      const inFlightRecipient = sender.calls[0].to;
      await scenario(); // arrives after the shutdown signal
      await looping.stop();

      expect(sender.inFlight).toBe(0); // nothing still running
      const sentAtStop = sender.calls.length;
      // The attempt that was running finished cleanly (accepted and recorded).
      const finished = await prisma.notificationDelivery.findFirst({
        where: { recipient: inFlightRecipient },
      });
      expect(finished?.status).toBe('SENT');
      await new Promise((r) => setTimeout(r, 300));
      expect(sender.calls.length).toBe(sentAtStop); // no new claims after stop
      void first;
    });

    it('a claim taken during shutdown is handed back without using up an attempt', async () => {
      const s = await scenario();
      const stopping = newProcessor();
      await stopping.stop(); // no loops: marks the worker as stopping
      for (let i = 0; i < 50; i += 1) {
        await stopping.processNext();
        if ((await reload(s.eventId)).lastAttemptAt) break;
      }
      const event = await reload(s.eventId);
      expect(event).toMatchObject({
        status: 'PENDING',
        attemptCount: 0,
        leaseOwner: null,
      });
      expect(sender.sentTo(s.email)).toBe(0);
    });

    it('forced kill: an abandoned claim is recovered after its lease expires', async () => {
      const s = await scenario();
      await claimSpecific(s.eventId); // killed right after claiming
      await expireLease(s.eventId);
      await drain();
      expect((await reload(s.eventId)).status).toBe('PROCESSED');
    });
  });

  describe('tenant isolation', () => {
    it('one tenant failing (permanently or by throttling) does not block another tenant in the same pass', async () => {
      const a1 = await scenario({
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        email: null,
      });
      const a2 = await scenario({ tenantId: TENANT_1_MOCHA_HOUSE_ID });
      const b = await scenario({ tenantId: TEST_TENANT_B_ID });
      sender.queue(a2.email, 'throttle');
      await drain();

      expect((await reload(a1.eventId)).status).toBe('FAILED');
      expect((await reload(a2.eventId)).status).toBe('PENDING');
      expect((await reload(b.eventId)).status).toBe('PROCESSED');
      expect(sender.sentTo(b.email)).toBe(1);
    });

    it('a Tenant A event naming a Tenant B order fails closed: dead letter, no email, no disclosure', async () => {
      const orderB = await makeOrder(
        TEST_TENANT_B_ID,
        `b-${randomUUID()}@example.test`,
      );
      const event = await prisma.outboxEvent.create({
        data: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          aggregateType: 'Order',
          aggregateId: orderB.id,
          eventType: 'order.checkout.completed',
          payload: { tenantId: TEST_TENANT_B_ID },
        },
      });
      eventIds.push(event.id);
      await drain();
      const reloaded = await reload(event.id);
      expect(reloaded.status).toBe('FAILED');
      expect(reloaded.lastErrorCode).toBe('ORDER_NOT_FOUND');
      expect(sender.sentTo(orderB.guestEmail!)).toBe(0);
    });

    it("the delivery inherits the event's own tenant", async () => {
      const b = await scenario({ tenantId: TEST_TENANT_B_ID });
      await drain();
      expect((await deliveryOf(b.eventId))?.tenantId).toBe(TEST_TENANT_B_ID);
    });
  });

  describe('infrastructure outages', () => {
    it('does not depend on Redis: delivery works with Redis unreachable', async () => {
      const original = process.env.REDIS_URL;
      process.env.REDIS_URL = 'redis://127.0.0.1:1';
      try {
        const s = await scenario();
        await drain();
        expect((await reload(s.eventId)).status).toBe('PROCESSED');
      } finally {
        if (original === undefined) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = original;
      }
    });

    it('refuses to start without the S4a schema (fails closed, never falls back to claim-then-send)', async () => {
      const brokenPrisma = {
        $queryRaw: () =>
          Promise.resolve([{ table_name: 'OutboxEvent', column_name: 'id' }]),
      } as unknown as PrismaService;
      const broken = new OutboxStore(brokenPrisma, config);
      await expect(broken.assertSchemaReady()).rejects.toThrow(
        /requires the S4a migrations.*OutboxEvent\.leaseOwner/,
      );
      await expect(store.assertSchemaReady()).resolves.toBeUndefined();
    });

    it('a database outage while claiming surfaces to the loop (which backs off) and loses nothing', async () => {
      const s = await scenario();
      const down = new OutboxStore(
        {
          $queryRaw: () => Promise.reject(new Error('database unavailable')),
        } as unknown as PrismaService,
        config,
      );
      await expect(down.claimNext()).rejects.toThrow('database unavailable');
      await drain();
      expect((await reload(s.eventId)).status).toBe('PROCESSED');
    });
  });

  describe('review hardening', () => {
    it('an event claimed too many times without an outcome (a crash loop) is dead-lettered unsent', async () => {
      const s = await scenario();
      await prisma.$executeRaw`UPDATE "OutboxEvent" SET "attemptCount" = ${config.maxAttempts} WHERE id = ${s.eventId}`;
      await drain(); // this claim makes it maxAttempts + 1
      const event = await reload(s.eventId);
      expect(event.status).toBe('FAILED');
      expect(event.lastErrorCode).toBe('ATTEMPTS_EXCEEDED');
      expect(sender.sentTo(s.email)).toBe(0);
    });

    it('a message the provider already accepted is completed, never dead-lettered as expired or exhausted', async () => {
      const s = await scenario({
        eventType: 'order.status.ready',
        createdAt: new Date(Date.now() - 5 * HOUR), // past the 3 h window
      });
      const delivery = await prisma.notificationDelivery.create({
        data: {
          outboxEventId: s.eventId,
          channel: 'EMAIL',
          recipient: s.email,
          templateKey: 'order.ready',
          status: 'SENT',
          sentAt: new Date(),
          sendStartedAt: new Date(),
          aggregateType: 'Order',
          aggregateId: s.orderId,
          tenantId: s.tenantId,
        },
      });
      expect(delivery.status).toBe('SENT');
      await drain();
      expect((await reload(s.eventId)).status).toBe('PROCESSED');
      expect(sender.sentTo(s.email)).toBe(0);
    });

    it('a stale worker cannot mark a delivery FAILED: with a fence the dispatch leaves terminal state to the processor', async () => {
      const s = await scenario({ email: null });
      const stale = await claimSpecific(s.eventId);
      await expireLease(s.eventId);
      await claimSpecific(s.eventId);
      const outcome = await dispatch.dispatch(eventOf(s), {
        beginSend: (id, flag) => store.beginSend(stale, id, flag),
      });
      expect(outcome).toMatchObject({
        kind: 'dead',
        code: 'NO_RECIPIENT',
        deliveryMarked: false,
      });
      expect(await deliveryOf(s.eventId)).toBeNull(); // nothing was written by the stale worker
      expect(await store.deadLetter(stale, 'NO_RECIPIENT', 'x')).toBe(false);
    });

    it('no durable intent, no send: if the delivery cannot be updated the claim check is rolled back and nothing is sent', async () => {
      const s = await scenario();
      const claim = await claimSpecific(s.eventId);
      const delivery = await prisma.notificationDelivery.create({
        data: {
          outboxEventId: s.eventId,
          channel: 'EMAIL',
          recipient: s.email,
          templateKey: 'order.received',
          status: 'FAILED', // something else already failed it
          failureReason: 'x',
          aggregateType: 'Order',
          aggregateId: s.orderId,
          tenantId: s.tenantId,
        },
      });
      expect(await store.beginSend(claim, delivery.id, false)).toBe(false);
      expect(sender.calls).toHaveLength(0);
    });

    it('provider acceptance is recorded as SENT even if the delivery was marked otherwise meanwhile', async () => {
      const s = await scenario();
      const claim = await claimSpecific(s.eventId);
      sender.holdMs = 100;
      const running = dispatch.dispatch(eventOf(s), {
        beginSend: (id, flag) => store.beginSend(claim, id, flag),
      });
      for (let i = 0; i < 40 && sender.calls.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await prisma.notificationDelivery.updateMany({
        where: { outboxEventId: s.eventId },
        data: { status: 'FAILED', failureReason: 'marked by something else' },
      });
      expect((await running).kind).toBe('accepted');
      expect((await deliveryOf(s.eventId))?.status).toBe('SENT');
    });

    it('stored and logged error text never contains a recipient address', async () => {
      const s = await scenario();
      const spy = jest
        .spyOn(sender, 'send')
        .mockImplementationOnce(() =>
          Promise.reject(
            new EmailProviderRejection(
              'MessageRejected',
              `Address ${s.email} is not verified`,
              false,
            ),
          ),
        );
      await drain();
      spy.mockRestore();
      const event = await reload(s.eventId);
      const delivery = await deliveryOf(s.eventId);
      expect(event.lastError).not.toContain(s.email);
      expect(delivery?.failureReason).not.toContain(s.email);
      expect(event.lastError).toContain('[email]');
    });

    it('the cut-off is respected by the backlog snapshot: held events are not "due"', async () => {
      const old = await scenario({
        createdAt: new Date(Date.now() - 3 * HOUR),
      });
      config.historicalCutoff = new Date(Date.now() - HOUR);
      const snap = await store.snapshot();
      expect(snap.heldByCutoff).toBeGreaterThanOrEqual(1);
      await prisma.$executeRaw`UPDATE "OutboxEvent" SET "nextAttemptAt" = timezone('utc', now()) - interval '1 second' WHERE id = ${old.eventId}`;
      const after = await store.snapshot();
      expect(after.heldByCutoff).toBeGreaterThanOrEqual(1);
    });
  });
});
