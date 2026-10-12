import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  TEST_TENANT_B_NAME,
  TEST_TENANT_C_ID,
  TEST_TENANT_C_NAME,
  createTestTenantB,
  createTestTenantC,
  removeTestTenantB,
  removeTestTenantC,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SENDER } from '../notifications/email/email-sender';
import { LoggingEmailSender } from '../notifications/email/logging-email-sender';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { NotificationRecipientResolver } from '../notifications/notification-recipient-resolver.service';

// Security 4B — the worker boundary across THREE businesses: an outbox
// event is processed strictly as its own business. For every ordered pair
// (X, Y), an X-owned event naming a Y order fails closed (FAILED delivery,
// no email, nothing of Y disclosed), while X's own order is delivered under
// X's own name only.
type Tag = 'a' | 'b' | 'c';
const TENANTS: Record<Tag, { id: string; name: string }> = {
  a: { id: TENANT_1_MOCHA_HOUSE_ID, name: 'Mocha House' },
  b: { id: TEST_TENANT_B_ID, name: TEST_TENANT_B_NAME },
  c: { id: TEST_TENANT_C_ID, name: TEST_TENANT_C_NAME },
};
const TAGS: Tag[] = ['a', 'b', 'c'];
const PAIRS = TAGS.flatMap((x) =>
  TAGS.filter((y) => y !== x).map((y) => [x, y] as [Tag, Tag]),
);

describe('Worker three-business isolation', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let dispatch: NotificationDispatchService;
  let sender: LoggingEmailSender;
  const created = {
    locations: [] as string[],
    attempts: [] as string[],
    orders: [] as string[],
    events: [] as string[],
  };
  const orders = {} as Record<
    Tag,
    { id: string; orderNumber: string; email: string }
  >;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        NotificationDispatchService,
        NotificationRecipientResolver,
        LoggingEmailSender,
        { provide: EMAIL_SENDER, useExisting: LoggingEmailSender },
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    dispatch = moduleRef.get(NotificationDispatchService);
    sender = moduleRef.get(LoggingEmailSender);
    await createTestTenantB(prisma);
    await createTestTenantC(prisma);
    for (const tag of TAGS) {
      const tenantId = TENANTS[tag].id;
      const location = await prisma.location.create({
        data: {
          tenantId,
          name: `TBW ${tag}`,
          slug: `tbw-${randomUUID().slice(0, 8)}`,
        },
      });
      created.locations.push(location.id);
      const attempt = await prisma.paymentAttempt.create({
        data: {
          tenantId,
          idempotencyKey: `tbw-${randomUUID()}`,
          provider: 'fake',
          status: 'SUCCEEDED',
          locationId: location.id,
          amount: 500,
          currency: 'USD',
        },
      });
      created.attempts.push(attempt.id);
      const email = `tbw-${tag}-${randomUUID()}@example.test`;
      const order = await prisma.order.create({
        data: {
          tenantId,
          orderNumber: `TBW-${tag}-${randomUUID().slice(0, 8)}`,
          accessToken: randomUUID(),
          locationId: location.id,
          paymentAttemptId: attempt.id,
          guestName: 'TBW',
          guestPhone: '5550000000',
          guestEmail: email,
          currency: 'USD',
          subtotal: 500,
          status: 'RECEIVED',
        },
      });
      created.orders.push(order.id);
      orders[tag] = { id: order.id, orderNumber: order.orderNumber, email };
    }
  });

  afterEach(() => sender.clear());

  afterAll(async () => {
    await prisma.notificationDelivery.deleteMany({
      where: { outboxEventId: { in: created.events } },
    });
    await prisma.outboxEvent.deleteMany({
      where: { id: { in: created.events } },
    });
    await prisma.order.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.paymentAttempt.deleteMany({
      where: { id: { in: created.attempts } },
    });
    await prisma.location.deleteMany({
      where: { id: { in: created.locations } },
    });
    await removeTestTenantB(prisma);
    await removeTestTenantC(prisma);
    await moduleRef.close();
  });

  async function event(ownerTag: Tag, orderTag: Tag) {
    const row = await prisma.outboxEvent.create({
      data: {
        tenantId: TENANTS[ownerTag].id,
        aggregateType: 'Order',
        aggregateId: orders[orderTag].id,
        eventType: 'order.checkout.completed',
        payload: {},
      },
    });
    created.events.push(row.id);
    return {
      id: row.id,
      tenantId: row.tenantId,
      aggregateType: 'Order',
      aggregateId: orders[orderTag].id,
      eventType: 'order.checkout.completed',
    };
  }

  it.each(PAIRS)(
    "an event owned by %s naming %s's order fails closed and discloses nothing",
    async (x, y) => {
      const e = await event(x, y);
      await dispatch.dispatch(e);
      expect(sender.getSent()).toHaveLength(0);
      const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
        where: {
          outboxEventId_channel: { outboxEventId: e.id, channel: 'EMAIL' },
        },
      });
      expect(delivery.status).toBe('FAILED');
      expect(delivery.tenantId).toBe(TENANTS[x].id);
      const stored = JSON.stringify(delivery);
      expect(stored).not.toContain(orders[y].email);
      expect(stored).not.toContain(orders[y].orderNumber);
    },
  );

  it.each(TAGS)(
    'an event owned by %s for its own order is delivered under its own name only',
    async (x) => {
      const e = await event(x, x);
      await dispatch.dispatch(e);
      const sent = sender.getSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(orders[x].email);
      expect(sent[0].fromName).toBe(TENANTS[x].name);
      const text = JSON.stringify(sent[0]);
      for (const other of TAGS.filter((t) => t !== x)) {
        if (TENANTS[other].name !== 'Mocha House' || x !== 'a') {
          expect(text).not.toContain(TENANTS[other].name);
        }
        expect(text).not.toContain(orders[other].orderNumber);
      }
    },
  );
});
