import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { OrderStatus } from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  createTestTenantB,
  removeTestTenantB,
  tenantContextFor,
  TEST_TENANT_B_ID,
} from '@mocha-house/testing';
import { ACTIVE_ORDER_STATUSES } from '@mocha-house/domain';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminOrdersService } from './admin-orders.service';
import { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';

// R1 / S1 — the shop queue is decided by COMMITTED ORDER STATE ONLY. These
// tests build orders straight in the database (exactly the rows a committed
// checkout leaves behind) with NO worker, NO processed outbox event and, for
// some, no outbox event at all, and prove they are visible; and that two
// independent tenants and their locations never see each other's orders.
// Tenant B is the shared synthetic test business (never an operational one).
const corporate = AuthorizationContext.of({
  'orders.view': [{ scopeType: 'CORPORATE', scopeId: null }],
  'orders.manage_status': [{ scopeType: 'CORPORATE', scopeId: null }],
});

describe('AdminOrdersService queue visibility (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let service: AdminOrdersService;
  const tenantA = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);
  const tenantB = tenantContextFor(TEST_TENANT_B_ID);
  let locationA1: string;
  let locationA2: string;
  let locationB: string;
  const orderIds: string[] = [];
  const attemptIds: string[] = [];

  async function makeOrder(
    tenantId: string,
    locationId: string,
    status: OrderStatus,
    outbox: 'PENDING' | 'PROCESSED' | 'FAILED' | 'NONE',
  ): Promise<string> {
    const attempt = await prisma.paymentAttempt.create({
      data: {
        tenantId,
        idempotencyKey: `s1_${randomUUID()}`,
        provider: 'test',
        locationId,
        amount: 400,
        currency: 'USD',
        status: 'SUCCEEDED',
      },
    });
    attemptIds.push(attempt.id);
    const order = await prisma.order.create({
      data: {
        tenantId,
        orderNumber: `S1-${randomUUID().slice(0, 12)}`,
        accessToken: randomUUID(),
        status,
        locationId,
        paymentAttemptId: attempt.id,
        guestName: 'Queue Guest',
        guestPhone: '5550001111',
        currency: 'USD',
        subtotal: 400,
      },
    });
    orderIds.push(order.id);
    if (outbox !== 'NONE') {
      await prisma.outboxEvent.create({
        data: {
          tenantId,
          aggregateType: 'Order',
          aggregateId: order.id,
          eventType: 'order.received',
          payload: { orderId: order.id },
          status: outbox,
          // S4a: a FAILED event (dead letter) always records when it failed.
          ...(outbox === 'FAILED' ? { failedAt: new Date() } : {}),
        },
      });
    }
    return order.id;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [AdminOrdersService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(AdminOrdersService);
    await prisma.$connect();
    await createTestTenantB(prisma);

    const mk = (tenantId: string, slug: string) =>
      prisma.location.upsert({
        where: { tenantId_slug: { tenantId, slug } },
        update: {},
        create: {
          tenantId,
          name: `S1 spec ${slug}`,
          slug,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      });
    locationA1 = (await mk(TENANT_1_MOCHA_HOUSE_ID, 's1-queue-a1')).id;
    locationA2 = (await mk(TENANT_1_MOCHA_HOUSE_ID, 's1-queue-a2')).id;
    locationB = (await mk(TEST_TENANT_B_ID, 's1-queue-b')).id;
  });

  afterAll(async () => {
    await prisma.orderStatusHistory.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.outboxEvent.deleteMany({
      where: { aggregateType: 'Order', aggregateId: { in: orderIds } },
    });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.paymentAttempt.deleteMany({
      where: { id: { in: attemptIds } },
    });
    await prisma.location.deleteMany({
      where: { id: { in: [locationA1, locationA2, locationB] } },
    });
    await removeTestTenantB(prisma);
    await moduleRef.close();
    await prisma.$disconnect();
  });

  const ids = async (
    locationId: string,
    tenant = tenantA,
    auth = corporate,
  ): Promise<string[]> =>
    (await service.listActive(locationId, auth, tenant)).map((o) => o.orderId);

  describe('visibility depends on committed order state only', () => {
    it.each(['PENDING', 'FAILED', 'PROCESSED', 'NONE'] as const)(
      'a committed order is listed when its outbox state is %s',
      async (outbox) => {
        const id = await makeOrder(
          TENANT_1_MOCHA_HOUSE_ID,
          locationA1,
          'RECEIVED',
          outbox,
        );
        expect(await ids(locationA1)).toContain(id);
      },
    );

    it('a stopped worker cannot hide orders: unprocessed orders can be listed, opened and advanced', async () => {
      const id = await makeOrder(
        TENANT_1_MOCHA_HOUSE_ID,
        locationA1,
        'RECEIVED',
        'PENDING',
      );
      expect(await ids(locationA1)).toContain(id);

      const detail = await service.getDetail(
        id,
        locationA1,
        corporate,
        tenantA,
      );
      expect(detail.orderId).toBe(id);

      const advanced = await service.advance(
        id,
        locationA1,
        'RECEIVED',
        corporate,
        tenantA,
      );
      expect(advanced).toMatchObject({ status: 'ACCEPTED', advanced: true });
      expect(await ids(locationA1)).toContain(id);

      // Nothing about the outbox changed: the worker never ran.
      const event = await prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateType: 'Order', aggregateId: id },
      });
      expect(event.status).toBe('PENDING');
    });

    it('lists exactly the active statuses and never a terminal one', async () => {
      const made = new Map<string, string>();
      for (const status of [
        ...ACTIVE_ORDER_STATUSES,
        'COMPLETED',
        'REJECTED',
        'CANCELLED',
      ] as const) {
        made.set(
          status,
          await makeOrder(TENANT_1_MOCHA_HOUSE_ID, locationA2, status, 'NONE'),
        );
      }
      const listed = await ids(locationA2);
      for (const status of ACTIVE_ORDER_STATUSES) {
        expect(listed).toContain(made.get(status));
      }
      for (const terminal of ['COMPLETED', 'REJECTED', 'CANCELLED']) {
        expect(listed).not.toContain(made.get(terminal));
      }
    });

    it('lists oldest first', async () => {
      const first = await makeOrder(
        TENANT_1_MOCHA_HOUSE_ID,
        locationA2,
        'RECEIVED',
        'NONE',
      );
      const second = await makeOrder(
        TENANT_1_MOCHA_HOUSE_ID,
        locationA2,
        'RECEIVED',
        'NONE',
      );
      const listed = await ids(locationA2);
      expect(listed.indexOf(first)).toBeLessThan(listed.indexOf(second));
    });
  });

  describe('tenant and location isolation', () => {
    let orderA1: string;
    let orderA2: string;
    let orderB: string;

    beforeAll(async () => {
      orderA1 = await makeOrder(
        TENANT_1_MOCHA_HOUSE_ID,
        locationA1,
        'RECEIVED',
        'NONE',
      );
      orderA2 = await makeOrder(
        TENANT_1_MOCHA_HOUSE_ID,
        locationA2,
        'RECEIVED',
        'NONE',
      );
      orderB = await makeOrder(TEST_TENANT_B_ID, locationB, 'RECEIVED', 'NONE');
    });

    it("each tenant's queue shows only its own orders", async () => {
      expect(await ids(locationA1)).toContain(orderA1);
      expect(await ids(locationA1)).not.toContain(orderA2);
      expect(await ids(locationA1)).not.toContain(orderB);
      expect(await ids(locationB, tenantB)).toContain(orderB);
      expect(await ids(locationB, tenantB)).not.toContain(orderA1);
    });

    it('a location in the same tenant does not leak into its sibling', async () => {
      expect(await ids(locationA2)).toContain(orderA2);
      expect(await ids(locationA2)).not.toContain(orderA1);
    });

    it("even a corporate staff member of tenant A sees nothing of tenant B's location", async () => {
      expect(await ids(locationB, tenantA)).toEqual([]);
      await expect(
        service.getDetail(orderB, locationB, corporate, tenantA),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("tenant B's staff cannot read or advance tenant A's order, with the same answer as a missing order", async () => {
      expect(await ids(locationA1, tenantB)).toEqual([]);
      await expect(
        service.getDetail(orderA1, locationA1, corporate, tenantB),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.advance(orderA1, locationA1, 'RECEIVED', corporate, tenantB),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.advance(orderB, locationB, 'RECEIVED', corporate, tenantA),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Nothing moved.
      const rows = await prisma.order.findMany({
        where: { id: { in: [orderA1, orderB] } },
        select: { status: true },
      });
      expect(rows.map((r) => r.status)).toEqual(['RECEIVED', 'RECEIVED']);
    });

    it('a staff member with no orders grant, or assigned to another location, is refused before any data', async () => {
      const none = AuthorizationContext.of({});
      await expect(
        service.listActive(locationA1, none, tenantA),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const elsewhere = AuthorizationContext.of({
        'orders.view': [{ scopeType: 'LOCATION', scopeId: locationA2 }],
        'orders.manage_status': [
          { scopeType: 'LOCATION', scopeId: locationA2 },
        ],
      });
      await expect(
        service.listActive(locationA1, elsewhere, tenantA),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.advance(orderA1, locationA1, 'RECEIVED', elsewhere, tenantA),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('concurrent advances of the same order still produce one transition and one history row', async () => {
      const id = await makeOrder(
        TENANT_1_MOCHA_HOUSE_ID,
        locationA1,
        'RECEIVED',
        'NONE',
      );
      const results = await Promise.all([
        service.advance(id, locationA1, 'RECEIVED', corporate, tenantA),
        service.advance(id, locationA1, 'RECEIVED', corporate, tenantA),
      ]);
      expect(results.filter((r) => r.advanced)).toHaveLength(1);
      expect(
        await prisma.orderStatusHistory.count({
          where: { orderId: id, status: 'ACCEPTED' },
        }),
      ).toBe(1);
    });
  });
});
