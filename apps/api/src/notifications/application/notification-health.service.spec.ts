import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import type { NotificationHealthResponse } from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
  tenantContextFor,
} from '@mocha-house/testing';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { REQUIRE_PERMISSION_METADATA } from '../../internal-auth/authorization/require-permission.decorator';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { AdminNotificationHealthController } from '../api/admin-notification-health.controller';
import { NotificationHealthService } from './notification-health.service';

// R1 / S4c — notification health against real PostgreSQL. Tenant B is the
// "clean" business under test (exact figures); Tenant #1 is the other business,
// whose data must never appear in B's answer and vice versa.

jest.setTimeout(120_000);

const corporate = [{ scopeType: 'CORPORATE' as const, scopeId: null }];
const viewer = AuthorizationContext.of({
  'notifications.routing.view': corporate,
});
const tenantOne = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);
const tenantB = tenantContextFor(TEST_TENANT_B_ID);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('NotificationHealthService (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let service: NotificationHealthService;
  const suffix = randomUUID().slice(0, 8);
  const eventIds: string[] = [];
  const orderIds: string[] = [];
  const attemptIds: string[] = [];
  const locationIds: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [NotificationHealthService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(NotificationHealthService);
    await prisma.$connect();
    await createTestTenantB(prisma);
  });

  afterEach(async () => {
    await prisma.notificationDelivery.deleteMany({
      where: { outboxEventId: { in: eventIds } },
    });
    await prisma.outboxEvent.deleteMany({ where: { id: { in: eventIds } } });
    eventIds.length = 0;
  });

  afterAll(async () => {
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

  const ago = (ms: number) => new Date(Date.now() - ms);
  const ahead = (ms: number) => new Date(Date.now() + ms);

  async function makeOrder(tenantId: string, guestEmail: string) {
    const location = await prisma.location.create({
      data: {
        tenantId,
        name: `S4c ${suffix} ${randomUUID().slice(0, 6)}`,
        slug: `s4c-${suffix}-${randomUUID().slice(0, 8)}`,
        isActive: true,
        isDigitalOrderingEnabled: true,
      },
    });
    locationIds.push(location.id);
    const attempt = await prisma.paymentAttempt.create({
      data: {
        tenantId,
        idempotencyKey: `s4c-${randomUUID()}`,
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
        orderNumber: `S4C-${randomUUID().slice(0, 6).toUpperCase()}`,
        accessToken: `secret-token-${randomUUID()}`,
        locationId: location.id,
        paymentAttemptId: attempt.id,
        guestName: 'Private Guest Name',
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

  interface EventSpec {
    tenantId: string;
    status?: 'PENDING' | 'PROCESSED' | 'FAILED';
    attempts?: number;
    nextAttemptAt?: Date;
    createdAt?: Date;
    leased?: 'active' | 'expired';
    failedAt?: Date;
    code?: string;
    aggregateId?: string;
    eventType?: string;
    lastError?: string;
  }

  async function makeEvent(spec: EventSpec) {
    const status = spec.status ?? 'PENDING';
    const event = await prisma.outboxEvent.create({
      data: {
        tenantId: spec.tenantId,
        aggregateType: 'Order',
        aggregateId: spec.aggregateId ?? randomUUID(),
        eventType: spec.eventType ?? 'order.checkout.completed',
        payload: {},
        status,
        attemptCount: spec.attempts ?? 0,
        ...(spec.nextAttemptAt ? { nextAttemptAt: spec.nextAttemptAt } : {}),
        ...(spec.createdAt ? { createdAt: spec.createdAt } : {}),
        ...(status === 'FAILED'
          ? { failedAt: spec.failedAt ?? new Date() }
          : {}),
        ...(status === 'PROCESSED' ? { processedAt: new Date() } : {}),
        ...(spec.leased
          ? {
              leaseOwner: 'worker-test:token',
              leaseExpiresAt:
                spec.leased === 'active' ? ahead(30 * SECOND) : ago(MINUTE),
            }
          : {}),
        lastErrorCode: spec.code ?? null,
        lastError: spec.lastError ?? null,
      },
    });
    eventIds.push(event.id);
    return event;
  }

  async function makeDelivery(
    tenantId: string,
    eventId: string,
    options: {
      status: 'SENT' | 'PENDING' | 'FAILED';
      sentAt?: Date;
      possibleDuplicate?: boolean;
      recipient?: string;
    },
  ) {
    return prisma.notificationDelivery.create({
      data: {
        tenantId,
        outboxEventId: eventId,
        channel: 'EMAIL',
        recipient:
          options.recipient ?? `recipient-${randomUUID()}@private.example`,
        templateKey: 'order.received',
        status: options.status,
        aggregateType: 'Order',
        aggregateId: randomUUID(),
        sentAt:
          options.sentAt ?? (options.status === 'SENT' ? new Date() : null),
        sendStartedAt: options.possibleDuplicate ? ago(HOUR) : null,
        possibleDuplicate: options.possibleDuplicate ?? false,
      },
    });
  }

  const summaryB = () => service.summary(viewer, tenantB);
  const summaryOne = () => service.summary(viewer, tenantOne);

  // The counts that must not move when ANOTHER tenant's data changes.
  const counts = (s: NotificationHealthResponse) => ({
    pending: {
      ...s.pending,
      oldestPendingAgeSeconds: null,
      oldestRetryingAgeSeconds: null,
      oldestOverdueSeconds: null,
    },
    failed: s.failed,
    accepted: s.accepted,
    possibleDuplicatesLast7d: s.possibleDuplicatesLast7d,
    items: s.items.map((i) => i.eventId),
  });

  // ---- tests ----------------------------------------------------------

  describe('states and counts', () => {
    it('an empty business is OK with zero counts, no ages and nothing to show', async () => {
      const s = await summaryB();
      expect(s.status).toBe('ok');
      expect(s.pending).toMatchObject({
        total: 0,
        waiting: 0,
        inProgress: 0,
        scheduledRetry: 0,
        delayed: 0,
        repeatedlyFailing: 0,
        oldestPendingAgeSeconds: null,
        oldestRetryingAgeSeconds: null,
        oldestOverdueSeconds: null,
        retryReasons: [],
      });
      expect(s.failed).toEqual({
        total: 0,
        last24h: 0,
        last7d: 0,
        reasons: [],
        closedDeliberately: 0,
      });
      expect(s.accepted).toEqual({ last24h: 0, last7d: 0 });
      expect(s.itemsTruncated).toBe(false);
      expect(s.attention).toEqual([]);
      expect(s.items).toEqual([]);
      expect(s.thresholds).toEqual({
        delayedAfterSeconds: 300,
        criticalDelaySeconds: 1800,
        repeatedFailureAttempts: 3,
      });
    });

    it('classifies pending, retrying, delayed, failed and processed notifications, with exact counts and ages', async () => {
      const B = TEST_TENANT_B_ID;
      // waiting: due 30 s ago, never tried
      await makeEvent({ tenantId: B, nextAttemptAt: ago(30 * SECOND) });
      await makeEvent({ tenantId: B, nextAttemptAt: ago(30 * SECOND) });
      // in progress: leased by a worker right now
      await makeEvent({
        tenantId: B,
        attempts: 1,
        leased: 'active',
        nextAttemptAt: ago(10 * SECOND),
      });
      // scheduled retries: failed before, waiting out their backoff
      await makeEvent({
        tenantId: B,
        attempts: 2,
        nextAttemptAt: ahead(10 * MINUTE),
        code: 'THROTTLING',
        createdAt: ago(2 * HOUR),
      });
      await makeEvent({
        tenantId: B,
        attempts: 1,
        nextAttemptAt: ahead(5 * MINUTE),
        code: 'THROTTLING',
      });
      // repeatedly failing, also waiting out a backoff
      await makeEvent({
        tenantId: B,
        attempts: 4,
        nextAttemptAt: ahead(30 * MINUTE),
        code: 'SES_NOT_CONFIGURED',
      });
      // delayed: due 20 minutes ago and nobody picked it up
      await makeEvent({ tenantId: B, nextAttemptAt: ago(20 * MINUTE) });
      // delayed with an EXPIRED lease (its worker died)
      await makeEvent({
        tenantId: B,
        attempts: 1,
        leased: 'expired',
        nextAttemptAt: ago(10 * MINUTE),
      });
      // dead letters: two in the last 24 h, one this week, one older
      await makeEvent({
        tenantId: B,
        status: 'FAILED',
        failedAt: ago(HOUR),
        code: 'MESSAGE_REJECTED',
        attempts: 1,
      });
      await makeEvent({
        tenantId: B,
        status: 'FAILED',
        failedAt: ago(2 * HOUR),
        code: 'MESSAGE_REJECTED',
        attempts: 1,
      });
      await makeEvent({
        tenantId: B,
        status: 'FAILED',
        failedAt: ago(3 * DAY),
        code: 'RETRIES_EXHAUSTED',
        attempts: 7,
      });
      await makeEvent({
        tenantId: B,
        status: 'FAILED',
        failedAt: ago(10 * DAY),
        code: 'EVENT_EXPIRED',
      });
      // processed, with provider acceptance recorded on two of them
      const p1 = await makeEvent({
        tenantId: B,
        status: 'PROCESSED',
        attempts: 1,
      });
      const p2 = await makeEvent({
        tenantId: B,
        status: 'PROCESSED',
        attempts: 1,
      });
      const p3 = await makeEvent({
        tenantId: B,
        status: 'PROCESSED',
        attempts: 2,
      });
      const p4 = await makeEvent({
        tenantId: B,
        status: 'PROCESSED',
        attempts: 1,
      });
      await makeDelivery(B, p1.id, { status: 'SENT', sentAt: ago(HOUR) });
      await makeDelivery(B, p2.id, { status: 'SENT', sentAt: ago(23 * HOUR) });
      await makeDelivery(B, p3.id, {
        status: 'SENT',
        sentAt: ago(2 * HOUR),
        possibleDuplicate: true,
      });
      await makeDelivery(B, p4.id, { status: 'SENT', sentAt: ago(3 * DAY) });

      const s = await summaryB();

      expect(s.pending).toMatchObject({
        total: 8,
        waiting: 2,
        inProgress: 1,
        scheduledRetry: 3,
        delayed: 2,
        repeatedlyFailing: 1,
      });
      expect(
        s.pending.waiting +
          s.pending.inProgress +
          s.pending.scheduledRetry +
          s.pending.delayed,
      ).toBe(s.pending.total); // every pending notification is in exactly one bucket
      expect(s.pending.oldestOverdueSeconds).toBeGreaterThanOrEqual(
        20 * 60 - 5,
      );
      expect(s.pending.oldestOverdueSeconds).toBeLessThan(20 * 60 + 60);
      expect(s.pending.oldestRetryingAgeSeconds).toBeGreaterThanOrEqual(
        2 * 3600 - 5,
      );
      expect(s.pending.oldestRetryingAgeSeconds).toBeLessThan(2 * 3600 + 120);
      expect(s.pending.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(
        2 * 3600 - 5,
      );
      expect(s.pending.retryReasons).toEqual(
        expect.arrayContaining([
          { code: 'THROTTLING', count: 2 },
          { code: 'SES_NOT_CONFIGURED', count: 1 },
        ]),
      );

      expect(s.failed).toMatchObject({ total: 4, last24h: 2, last7d: 3 });
      expect(s.failed.reasons).toEqual([
        { code: 'MESSAGE_REJECTED', count: 2 },
        { code: 'RETRIES_EXHAUSTED', count: 1 },
      ]); // the 10-day-old dead letter is outside the week

      expect(s.accepted).toEqual({ last24h: 3, last7d: 4 });
      expect(s.possibleDuplicatesLast7d).toBe(1);

      // What an administrator must act on, worst first; an ordinary retry is not in it.
      expect(s.attention.map((a) => [a.key, a.severity])).toEqual([
        ['DEAD_LETTERED', 'critical'],
        ['DELAYED', 'warning'],
        ['REPEATED_FAILURES', 'warning'],
        ['POSSIBLE_DUPLICATES', 'info'],
      ]);
      expect(s.status).toBe('critical');

      // The list: dead letters first, then delayed / repeatedly failing; never ordinary retries.
      const states = s.items.map((i) => i.state);
      expect(states.filter((x) => x === 'dead-lettered')).toHaveLength(3);
      expect(states.slice(0, 3)).toEqual([
        'dead-lettered',
        'dead-lettered',
        'dead-lettered',
      ]);
      expect(states.filter((x) => x === 'delayed')).toHaveLength(2);
      expect(states.filter((x) => x === 'retrying')).toHaveLength(1);
      expect(s.items).toHaveLength(6);
    });

    it('worker RUNNING and healthy: notifications flow through waiting/in progress with no alert', async () => {
      const B = TEST_TENANT_B_ID;
      await makeEvent({ tenantId: B, nextAttemptAt: ago(5 * SECOND) });
      await makeEvent({
        tenantId: B,
        attempts: 1,
        leased: 'active',
        nextAttemptAt: ago(SECOND),
      });
      const done = await makeEvent({
        tenantId: B,
        status: 'PROCESSED',
        attempts: 1,
      });
      await makeDelivery(B, done.id, { status: 'SENT' });
      const s = await summaryB();
      expect(s.status).toBe('ok');
      expect(s.attention).toEqual([]);
      expect(s.accepted.last24h).toBe(1);
    });

    it('worker STOPPED: due notifications age into a warning, then a critical alert', async () => {
      const B = TEST_TENANT_B_ID;
      const stuck = await makeEvent({
        tenantId: B,
        nextAttemptAt: ago(10 * MINUTE),
      });
      let s = await summaryB();
      expect(s.pending.delayed).toBe(1);
      expect(s.attention[0]).toMatchObject({
        key: 'DELAYED',
        severity: 'warning',
      });
      expect(s.status).toBe('warning');

      await prisma.outboxEvent.update({
        where: { id: stuck.id },
        data: { nextAttemptAt: ago(45 * MINUTE) },
      });
      s = await summaryB();
      expect(s.attention[0]).toMatchObject({
        key: 'DELAYED',
        severity: 'critical',
      });
      expect(s.status).toBe('critical');
    });

    it('worker FAILING (provider trouble): repeated failures are flagged; the first retries are not', async () => {
      const B = TEST_TENANT_B_ID;
      await makeEvent({
        tenantId: B,
        attempts: 1,
        nextAttemptAt: ahead(MINUTE),
        code: 'THROTTLING',
      });
      await makeEvent({
        tenantId: B,
        attempts: 2,
        nextAttemptAt: ahead(2 * MINUTE),
        code: 'THROTTLING',
      });
      let s = await summaryB();
      expect(s.status).toBe('ok'); // ordinary retries
      expect(s.pending.scheduledRetry).toBe(2);

      await makeEvent({
        tenantId: B,
        attempts: 3,
        nextAttemptAt: ahead(8 * MINUTE),
        code: 'THROTTLING',
      });
      s = await summaryB();
      expect(s.status).toBe('warning');
      expect(s.attention.map((a) => a.key)).toEqual(['REPEATED_FAILURES']);
      expect(s.items).toHaveLength(1);
      expect(s.items[0]).toMatchObject({
        state: 'retrying',
        attempts: 3,
        reasonCode: 'THROTTLING',
      });
    });

    it('a dead letter becomes critical, and falls to a warning after 24 hours and out of the alerts after a week', async () => {
      const B = TEST_TENANT_B_ID;
      const dead = await makeEvent({
        tenantId: B,
        status: 'FAILED',
        failedAt: ago(HOUR),
        code: 'NO_RECIPIENT',
      });
      expect((await summaryB()).status).toBe('critical');
      await prisma.outboxEvent.update({
        where: { id: dead.id },
        data: { failedAt: ago(2 * DAY) },
      });
      expect((await summaryB()).status).toBe('warning');
      await prisma.outboxEvent.update({
        where: { id: dead.id },
        data: { failedAt: ago(8 * DAY) },
      });
      const s = await summaryB();
      expect(s.status).toBe('ok');
      expect(s.failed.total).toBe(1);
      expect(s.items).toEqual([]);
    });

    it('is capped: at most 25 items however many problems exist', async () => {
      for (let i = 0; i < 30; i += 1) {
        await makeEvent({
          tenantId: TEST_TENANT_B_ID,
          status: 'FAILED',
          failedAt: ago(HOUR),
          code: 'MESSAGE_REJECTED',
        });
      }
      const s = await summaryB();
      expect(s.failed.total).toBe(30);
      expect(s.items).toHaveLength(25);
    });

    it('shows the customer-visible order number as the reference, and the notification type', async () => {
      const order = await makeOrder(TEST_TENANT_B_ID, 'guest@private.example');
      await makeEvent({
        tenantId: TEST_TENANT_B_ID,
        status: 'FAILED',
        failedAt: ago(MINUTE),
        code: 'NO_RECIPIENT',
        aggregateId: order.id,
        eventType: 'order.status.ready',
      });
      const [item] = (await summaryB()).items;
      expect(item).toMatchObject({
        reference: order.orderNumber,
        eventType: 'order.status.ready',
        reasonCode: 'NO_RECIPIENT',
        state: 'dead-lettered',
        nextAttemptAt: null,
      });
    });
  });

  describe('operator closures, ordering and truncation', () => {
    it('events closed on purpose at a cut-over are not failures: counted separately, never an alert', async () => {
      const B = TEST_TENANT_B_ID;
      for (let i = 0; i < 5; i += 1) {
        await makeEvent({
          tenantId: B,
          status: 'FAILED',
          failedAt: ago(HOUR),
          code: 'HISTORICAL_NOT_SENT',
        });
      }
      let s = await summaryB();
      expect(s.failed).toMatchObject({
        total: 0,
        last24h: 0,
        last7d: 0,
        reasons: [],
        closedDeliberately: 5,
      });
      expect(s.status).toBe('ok');
      expect(s.attention).toEqual([]);
      expect(s.items).toEqual([]);

      // A real dead letter alongside them is still reported on its own.
      await makeEvent({
        tenantId: B,
        status: 'FAILED',
        failedAt: ago(MINUTE),
        code: 'NO_RECIPIENT',
      });
      s = await summaryB();
      expect(s.failed).toMatchObject({
        total: 1,
        last24h: 1,
        closedDeliberately: 5,
      });
      expect(s.failed.reasons).toEqual([{ code: 'NO_RECIPIENT', count: 1 }]);
      expect(s.items).toHaveLength(1);
      expect(s.status).toBe('critical');
    });

    it('the list shows the longest-overdue notifications first and says when it is truncated', async () => {
      const B = TEST_TENANT_B_ID;
      const oldest = await makeEvent({
        tenantId: B,
        nextAttemptAt: ago(3 * HOUR),
      });
      for (let i = 0; i < 29; i += 1) {
        await makeEvent({
          tenantId: B,
          nextAttemptAt: ago(10 * MINUTE + i * SECOND),
        });
      }
      const s = await summaryB();
      expect(s.pending.delayed).toBe(30);
      expect(s.items).toHaveLength(25);
      expect(s.itemsTruncated).toBe(true);
      expect(s.items[0].eventId).toBe(oldest.id); // the longest-stuck one is never pushed out
      const waits = s.items.map((i) =>
        new Date(i.nextAttemptAt as string).getTime(),
      );
      expect([...waits].sort((a, b) => a - b)).toEqual(waits); // oldest first
    });
  });

  describe('tenant isolation', () => {
    it("never counts or lists another business's notifications, in either direction", async () => {
      const B = TEST_TENANT_B_ID;
      const one = TENANT_1_MOCHA_HOUSE_ID;
      const oneBefore = counts(await summaryOne());
      const bBefore = counts(await summaryB());

      // Tenant B gets problems of every kind...
      const bEvents = [
        await makeEvent({
          tenantId: B,
          status: 'FAILED',
          failedAt: ago(HOUR),
          code: 'MESSAGE_REJECTED',
        }),
        await makeEvent({ tenantId: B, nextAttemptAt: ago(40 * MINUTE) }),
        await makeEvent({
          tenantId: B,
          attempts: 5,
          nextAttemptAt: ahead(MINUTE),
          code: 'THROTTLING',
        }),
        await makeEvent({ tenantId: B, status: 'PROCESSED', attempts: 1 }),
      ];
      await makeDelivery(B, bEvents[3].id, {
        status: 'SENT',
        possibleDuplicate: true,
      });

      // ...and Tenant #1's own numbers do not move.
      expect(counts(await summaryOne())).toEqual(oneBefore);

      // Now Tenant #1 gets different data...
      const oneEvents = [
        await makeEvent({
          tenantId: one,
          status: 'FAILED',
          failedAt: ago(MINUTE),
          code: 'NO_RECIPIENT',
        }),
        await makeEvent({
          tenantId: one,
          status: 'FAILED',
          failedAt: ago(MINUTE),
          code: 'NO_RECIPIENT',
        }),
        await makeEvent({ tenantId: one, nextAttemptAt: ago(MINUTE) }),
      ];
      const bAfter = await summaryB();
      // ...and B's figures only reflect B's data.
      expect(bAfter.failed.last24h).toBe(bBefore.failed.last24h + 1);
      expect(bAfter.items.map((i) => i.eventId)).toEqual(
        expect.not.arrayContaining(oneEvents.map((e) => e.id)),
      );
      const oneAfter = await summaryOne();
      expect(oneAfter.failed.last24h).toBe(oneBefore.failed.last24h + 2);
      expect(oneAfter.items.map((i) => i.eventId)).toEqual(
        expect.not.arrayContaining(bEvents.map((e) => e.id)),
      );
      for (const item of oneAfter.items) {
        const owner = await prisma.outboxEvent.findUniqueOrThrow({
          where: { id: item.eventId },
          select: { tenantId: true },
        });
        expect(owner.tenantId).toBe(one);
      }
      for (const item of bAfter.items) {
        const owner = await prisma.outboxEvent.findUniqueOrThrow({
          where: { id: item.eventId },
          select: { tenantId: true },
        });
        expect(owner.tenantId).toBe(B);
      }
      expect(bAfter.possibleDuplicatesLast7d).toBe(
        bBefore.possibleDuplicatesLast7d + 1,
      );
      expect(oneAfter.possibleDuplicatesLast7d).toBe(
        oneBefore.possibleDuplicatesLast7d,
      );
    });

    it("does not reveal another business's order number through the join", async () => {
      const orderOne = await makeOrder(
        TENANT_1_MOCHA_HOUSE_ID,
        'one@private.example',
      );
      // A Tenant B event that (wrongly) names Tenant #1's order id.
      await makeEvent({
        tenantId: TEST_TENANT_B_ID,
        status: 'FAILED',
        failedAt: ago(MINUTE),
        code: 'ORDER_NOT_FOUND',
        aggregateId: orderOne.id,
      });
      const [item] = (await summaryB()).items;
      expect(item.reference).toBeNull();
      expect(JSON.stringify(item)).not.toContain(orderOne.orderNumber);
    });
  });

  describe('authorization', () => {
    it('requires notifications.routing.view', async () => {
      await expect(
        service.summary(AuthorizationContext.empty(), tenantB),
      ).rejects.toThrow(ForbiddenException);
    });

    it('requires a CORPORATE grant: a location-scoped one is not enough', async () => {
      const locationOnly = AuthorizationContext.of({
        'notifications.routing.view': [
          { scopeType: 'LOCATION', scopeId: randomUUID() },
        ],
      });
      await expect(service.summary(locationOnly, tenantB)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('a different permission (for example orders.view) does not grant it', async () => {
      const other = AuthorizationContext.of({ 'orders.view': corporate });
      await expect(service.summary(other, tenantB)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('the route is guarded by authentication and the same permission, and is read-only', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        AdminNotificationHealthController,
      ) as unknown[];
      expect(guards).toEqual(
        expect.arrayContaining([InternalAuthGuard, PermissionGuard]),
      );
      const handler = Object.getOwnPropertyDescriptor(
        AdminNotificationHealthController.prototype,
        'summary',
      )!.value as object;
      expect(Reflect.getMetadata(REQUIRE_PERMISSION_METADATA, handler)).toBe(
        'notifications.routing.view',
      );
      // Only GET exists on this controller: no re-send, no re-drive.
      const methods = Object.getOwnPropertyNames(
        AdminNotificationHealthController.prototype,
      ).filter((n) => n !== 'constructor');
      expect(methods).toEqual(['summary']);
      expect(Reflect.getMetadata('method', handler)).toBe(0); // RequestMethod.GET
    });
  });

  describe('no sensitive data', () => {
    it('never returns recipient addresses, guest details, access tokens or free-text error messages', async () => {
      const recipient = `leak-check-${randomUUID()}@private.example`;
      const guestEmail = `guest-${randomUUID()}@private.example`;
      const order = await makeOrder(TEST_TENANT_B_ID, guestEmail);
      const failed = await makeEvent({
        tenantId: TEST_TENANT_B_ID,
        status: 'FAILED',
        failedAt: ago(MINUTE),
        code: 'MESSAGE_REJECTED',
        aggregateId: order.id,
        lastError: `MESSAGE_REJECTED: Address ${recipient} is not verified (token secret-token-xyz)`,
      });
      await makeDelivery(TEST_TENANT_B_ID, failed.id, {
        status: 'FAILED',
        recipient,
      });
      const retry = await makeEvent({
        tenantId: TEST_TENANT_B_ID,
        attempts: 4,
        nextAttemptAt: ahead(MINUTE),
        code: 'THROTTLING',
        lastError: `Throttling for ${recipient}`,
      });
      await makeDelivery(TEST_TENANT_B_ID, retry.id, {
        status: 'PENDING',
        recipient,
      });

      const body = JSON.stringify(await summaryB());
      for (const secret of [
        recipient,
        guestEmail,
        'private.example',
        'Private Guest Name',
        '5551230000',
        order.accessToken,
        'secret-token',
        'is not verified',
        'Throttling for',
      ]) {
        expect(body).not.toContain(secret);
      }
      // Only the machine-readable reason code and the order number come through.
      expect(body).toContain('MESSAGE_REJECTED');
      expect(body).toContain(order.orderNumber);
    });

    it('the service itself logs nothing and writes nothing', () => {
      const source = readFileSync(
        join(__dirname, 'notification-health.service.ts'),
        'utf8',
      );
      expect(source).not.toMatch(/Logger|console\./);
      expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b\s+(INTO\s+)?"/i);
      expect(source).not.toMatch(/\.(create|update|upsert|delete)(Many)?\(/);
    });
  });

  describe('independent of the shop queue', () => {
    it('reading the summary changes no order and no outbox row', async () => {
      const order = await makeOrder(TEST_TENANT_B_ID, 'queue@private.example');
      const event = await makeEvent({
        tenantId: TEST_TENANT_B_ID,
        status: 'FAILED',
        failedAt: ago(MINUTE),
        code: 'NO_RECIPIENT',
        aggregateId: order.id,
      });
      const before = {
        order: await prisma.order.findUniqueOrThrow({
          where: { id: order.id },
        }),
        event: await prisma.outboxEvent.findUniqueOrThrow({
          where: { id: event.id },
        }),
      };
      await summaryB();
      await summaryB();
      expect(
        await prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      ).toEqual(before.order);
      expect(
        await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } }),
      ).toEqual(before.event);
    });
  });
});
