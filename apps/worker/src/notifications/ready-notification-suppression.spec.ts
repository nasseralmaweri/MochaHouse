import 'dotenv/config';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@mocha-house/database';
import {
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  withScratchClient,
  type ScratchDatabase,
} from '@mocha-house/testing';
import type { PrismaService } from '../prisma/prisma.service';
import type { OutboxConfig } from '../outbox/outbox.config';
import { OutboxStore } from '../outbox/outbox-store';
import { OutboxProcessorService } from '../outbox/outbox-processor.service';
import { WorkerTenantContextFactory } from '../tenancy/worker-tenant-context.factory';
import { LoggingEmailSender } from './email/logging-email-sender';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationRecipientResolver } from './notification-recipient-resolver.service';
import { orderClosedForReadyNotice } from './order-closed-guard';

// R1 / S5b — a READY ("your order is ready") notice must never go out for an
// order that was rejected or cancelled. Exercised on a scratch database (a
// closed order is append-only financial history and cannot be cleaned out of
// the shared test database), through the real dispatch service, outbox store
// and processor.

jest.setTimeout(300_000);

const migrations = listMigrations(
  join(__dirname, '../../../../packages/database/prisma/migrations'),
);
const A = '01a0db02-f800-7000-8000-5b0000000a21';

describe('R1 / S5b: READY notifications for closed orders', () => {
  let scratch: ScratchDatabase;
  let db: PrismaClient;
  let sender: LoggingEmailSender;
  let dispatch: NotificationDispatchService;
  let store: OutboxStore;
  let processor: OutboxProcessorService;
  let n = 0;

  const config: OutboxConfig = {
    enabled: true,
    concurrency: 1,
    pollIntervalMs: 50,
    leaseSeconds: 60,
    sendTimeoutMs: 2000,
    minLeaseRemainingMs: 1000,
    maxAttempts: 4,
    backoffBaseMs: 30_000,
    backoffCapMs: 60_000,
    shutdownGraceMs: 1000,
    historicalCutoff: null,
    workerId: 's5b-test-worker',
  };

  const sql = (text: string, params: unknown[] = []) =>
    withScratchClient(scratch.url, (c) => c.query(text, params));

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      's5b_ready',
    );
    await applyMigrations(scratch.url, migrations);
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: scratch.url }),
    });
    await db.$connect();
    const prisma = db as unknown as PrismaService;
    sender = new LoggingEmailSender();
    dispatch = new NotificationDispatchService(
      prisma,
      sender,
      new NotificationRecipientResolver(prisma),
      config,
    );
    store = new OutboxStore(prisma, config);
    processor = new OutboxProcessorService(
      store,
      dispatch,
      new WorkerTenantContextFactory(),
      config,
    );

    await sql(
      `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, 's5b-ready', 'Ready Cafe', 'ACTIVE', now())`,
      [A],
    );
    await sql(
      `INSERT INTO "Location" (id, name, slug, "updatedAt", "tenantId") VALUES ('loc-r', 'Main St', 'main', now(), $1)`,
      [A],
    );
    await sql(
      `INSERT INTO "InternalUser" (id, "externalProvider", email, "updatedAt", "tenantId") VALUES ('iu-r', 'internal-dev', 'staff@example.test', now(), $1)`,
      [A],
    );
  });

  afterEach(() => sender.clear());

  afterAll(async () => {
    await db?.$disconnect();
    await scratch?.drop();
  });

  // A READY order with its pending READY event, written the way checkout and
  // advance write them.
  async function readyOrderWithEvent(): Promise<{
    orderId: string;
    eventId: string;
  }> {
    n += 1;
    const orderId = `o-r${n}`;
    await sql(
      `INSERT INTO "PaymentAttempt" (id, "idempotencyKey", provider, status, amount, currency, "providerReference", "updatedAt", "tenantId")
       VALUES ($1, $2, 'fake', 'SUCCEEDED', 900, 'USD', 'ref', now(), $3)`,
      [`pa-r${n}`, `key-r${n}`, A],
    );
    await sql(
      `INSERT INTO "Order" (id, "orderNumber", "accessToken", status, "locationId", "paymentAttemptId", "guestName", "guestPhone", "guestEmail", currency, subtotal, "updatedAt", "tenantId")
       VALUES ($1, $2, $3, 'READY', 'loc-r', $4, 'G', '555', 'guest@example.test', 'USD', 900, now(), $5)`,
      [orderId, `R-${n}`, `tok-r${n}`, `pa-r${n}`, A],
    );
    const event = await db.outboxEvent.create({
      data: {
        tenantId: A,
        aggregateType: 'Order',
        aggregateId: orderId,
        eventType: 'order.status.ready',
        payload: { orderId, locationId: 'loc-r', status: 'READY' },
      },
    });
    return { orderId, eventId: event.id };
  }

  // What the closure writer commits (no card refund owed here, to keep the
  // fixture small: the obligation path is covered by the API suite).
  const closeStatements = (orderId: string) => [
    `UPDATE "Order" SET status = 'CANCELLED' WHERE id = '${orderId}'`,
    `INSERT INTO "OrderClosure" (id, "orderId", kind, "fromStatus", "reasonCode", "actorInternalUserId", "tenantId")
     VALUES ('oc-${orderId}', '${orderId}', 'CANCELLED', 'READY', 'CUSTOMER_REQUEST', 'iu-r', '${A}')`,
  ];
  async function cancelOrder(orderId: string) {
    await withScratchClient(scratch.url, async (c) => {
      await c.query('BEGIN');
      for (const s of closeStatements(orderId)) await c.query(s);
      await c.query('COMMIT');
    });
  }

  const event = (orderId: string, eventId: string) => ({
    id: eventId,
    tenantId: A,
    aggregateType: 'Order',
    aggregateId: orderId,
    eventType: 'order.status.ready',
  });

  it('a READY notice for a still-READY order is sent (no over-correction)', async () => {
    const { orderId, eventId } = await readyOrderWithEvent();
    const outcome = await dispatch.dispatch(event(orderId, eventId));
    expect(outcome.kind).toBe('accepted');
    expect(sender.getSent()).toHaveLength(1);
  });

  it('is not sent when the order was cancelled before the worker picked it up', async () => {
    const { orderId, eventId } = await readyOrderWithEvent();
    await cancelOrder(orderId);
    const outcome = await dispatch.dispatch(event(orderId, eventId));
    expect(outcome).toMatchObject({ kind: 'suppressed', code: 'ORDER_CLOSED' });
    expect(sender.getSent()).toHaveLength(0);
    expect(
      await db.notificationDelivery.count({
        where: { outboxEventId: eventId },
      }),
    ).toBe(0);
  });

  it('the processor completes the event without sending and without a dead letter', async () => {
    const { orderId, eventId } = await readyOrderWithEvent();
    await cancelOrder(orderId);
    await processor.processPendingBatch(50);
    const row = await db.outboxEvent.findUniqueOrThrow({
      where: { id: eventId },
    });
    expect(row.status).toBe('PROCESSED');
    expect(row.failedAt).toBeNull();
    expect(
      sender.getSent().filter((m) => m.subject.includes(`R-${n}`)),
    ).toHaveLength(0);
  });

  it('is not sent when the cancellation lands between resolving and starting the send', async () => {
    const { orderId, eventId } = await readyOrderWithEvent();
    const claim = (await store.claimNext())!;
    expect(claim.eventId).toBe(eventId);
    const outcome = await dispatch.dispatch(event(orderId, eventId), {
      beginSend: async (deliveryId, flag) => {
        // The order is closed after the recipient was resolved.
        await cancelOrder(orderId);
        return store.beginSend(claim, deliveryId, flag);
      },
    });
    expect(outcome).toMatchObject({ kind: 'suppressed', code: 'ORDER_CLOSED' });
    expect(sender.getSent()).toHaveLength(0);
    const delivery = await db.notificationDelivery.findFirstOrThrow({
      where: { outboxEventId: eventId },
    });
    expect(delivery.status).toBe('FAILED');
    expect(delivery.sendStartedAt).toBeNull();
    expect(delivery.failureReason).toMatch(/^ORDER_CLOSED/);
  });

  it('beginSend waits for an in-flight cancellation and then refuses to start the send', async () => {
    const { orderId, eventId } = await readyOrderWithEvent();
    const claim = (await store.claimNext())!;
    expect(claim.eventId).toBe(eventId);
    const delivery = await db.notificationDelivery.create({
      data: {
        tenantId: A,
        outboxEventId: eventId,
        channel: 'EMAIL',
        recipient: 'guest@example.test',
        templateKey: 'order.ready',
        status: 'PENDING',
        aggregateType: 'Order',
        aggregateId: orderId,
      },
    });
    await withScratchClient(scratch.url, async (c) => {
      // The closure transaction holds the order row (FOR UPDATE) ...
      await c.query('BEGIN');
      await c.query(`SELECT 1 FROM "Order" WHERE id = $1 FOR UPDATE`, [
        orderId,
      ]);
      for (const s of closeStatements(orderId)) await c.query(s);
      // ... so beginSend's FOR SHARE read waits for it.
      const pending = store.beginSend(claim, delivery.id, false);
      let settled = false;
      void pending.then(() => (settled = true));
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await c.query('COMMIT');
      await expect(pending).resolves.toBe('order-closed');
    });
    const after = await db.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(after.sendStartedAt).toBeNull();
  });

  it('only READY notices are checked', async () => {
    await db.$transaction(async (tx) => {
      expect(
        await orderClosedForReadyNotice(tx, {
          eventType: 'order.checkout.completed',
          aggregateId: 'whatever',
          tenantId: A,
        }),
      ).toBe(false);
    });
  });

  it("another business's order is never read", async () => {
    const { orderId } = await readyOrderWithEvent();
    await cancelOrder(orderId);
    await db.$transaction(async (tx) => {
      expect(
        await orderClosedForReadyNotice(tx, {
          eventType: 'order.status.ready',
          aggregateId: orderId,
          tenantId: '01a0db02-f800-7000-8000-5b00000000ff',
        }),
      ).toBe(false);
    });
  });
});
