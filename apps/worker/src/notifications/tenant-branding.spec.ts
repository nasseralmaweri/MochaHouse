import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  TEST_TENANT_B_NAME,
  createTestTenantB,
  removeTestTenantB,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SENDER } from './email/email-sender';
import { LoggingEmailSender } from './email/logging-email-sender';
import { formatSource } from './email/ses-email-sender';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationRecipientResolver } from './notification-recipient-resolver.service';
import { renderOrderReady, renderOrderReceived } from './templates';

// Security 4A — customer emails carry the ordering business's own name
// (Tenant.name, read from the outbox event's tenant), never a hardcoded
// brand, and never another business's. Mocha House's wording is unchanged.
describe('Notification business branding', () => {
  describe('templates', () => {
    it('render Mocha House order emails exactly as before', () => {
      expect(
        renderOrderReceived({
          businessName: 'Mocha House',
          orderNumber: 'MH-1',
          locationName: 'Dearborn',
        }),
      ).toEqual({
        subject: 'Mocha House — order MH-1 received',
        html: "<p>Mocha House</p><p>We've received your order <strong>MH-1</strong> at Dearborn. We'll let you know when it's ready.</p>",
        text: "Mocha House\n\nWe've received your order MH-1 at Dearborn. We'll let you know when it's ready.",
      });
      expect(
        renderOrderReady({
          businessName: 'Mocha House',
          orderNumber: 'MH-1',
          locationName: 'Dearborn',
        }),
      ).toEqual({
        subject: 'Mocha House — order MH-1 is ready',
        html: '<p>Mocha House</p><p>Your order <strong>MH-1</strong> is ready for pickup at Dearborn.</p>',
        text: 'Mocha House\n\nYour order MH-1 is ready for pickup at Dearborn.',
      });
    });

    it("render another business's order emails with only its own name, escaped and header-safe", () => {
      for (const render of [renderOrderReceived, renderOrderReady]) {
        const email = render({
          businessName: 'Bean & <Co>\r\nBcc: x@evil.test',
          orderNumber: 'B-7',
          locationName: 'Elsewhere',
        });
        expect(JSON.stringify(email)).not.toContain('Mocha House');
        expect(email.subject).not.toMatch(/[\r\n]/);
        expect(
          email.subject.startsWith('Bean & <Co> Bcc: x@evil.test — order B-7'),
        ).toBe(true);
        expect(email.html).toContain('<p>Bean &amp; &lt;Co&gt;');
        expect(email.html).not.toContain('<Co>');
      }
    });
  });

  describe('sender display name', () => {
    it('formats a quoted, header-safe display name and keeps the configured address', () => {
      expect(formatSource('orders@example.test', 'Mocha House')).toBe(
        '"Mocha House" <orders@example.test>',
      );
      expect(formatSource('orders@example.test', 'Say "hi" \\ co')).toBe(
        '"Say \\"hi\\" \\\\ co" <orders@example.test>',
      );
      expect(
        formatSource('orders@example.test', 'Evil\r\nBcc: victim@example.test'),
      ).toBe('"Evil Bcc: victim@example.test" <orders@example.test>');
      expect(formatSource('orders@example.test', 'Café Ñ')).toBe(
        `=?UTF-8?B?${Buffer.from('Café Ñ', 'utf8').toString('base64')}?= <orders@example.test>`,
      );
      expect(formatSource('orders@example.test', '  ')).toBe(
        'orders@example.test',
      );
      expect(formatSource('orders@example.test')).toBe('orders@example.test');
    });
  });

  describe('dispatch', () => {
    let moduleRef: TestingModule;
    let prisma: PrismaService;
    let dispatch: NotificationDispatchService;
    let sender: LoggingEmailSender;
    const suffix = randomUUID().slice(0, 8);
    const ids = {
      locations: [] as string[],
      attempts: [] as string[],
      orders: [] as string[],
      events: [] as string[],
    };

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
    });

    afterEach(() => sender.clear());

    afterAll(async () => {
      await prisma.notificationDelivery.deleteMany({
        where: { outboxEventId: { in: ids.events } },
      });
      await prisma.outboxEvent.deleteMany({
        where: { id: { in: ids.events } },
      });
      await prisma.order.deleteMany({ where: { id: { in: ids.orders } } });
      await prisma.paymentAttempt.deleteMany({
        where: { id: { in: ids.attempts } },
      });
      await prisma.location.deleteMany({
        where: { id: { in: ids.locations } },
      });
      await removeTestTenantB(prisma);
      await moduleRef.close();
    });

    async function orderEvent(tenantId: string, eventType: string) {
      const location = await prisma.location.create({
        data: {
          tenantId,
          name: `Branding ${suffix}`,
          slug: `branding-${suffix}-${randomUUID().slice(0, 8)}`,
        },
      });
      ids.locations.push(location.id);
      const attempt = await prisma.paymentAttempt.create({
        data: {
          tenantId,
          idempotencyKey: `branding-${randomUUID()}`,
          provider: 'fake',
          status: 'SUCCEEDED',
          locationId: location.id,
          amount: 500,
          currency: 'USD',
        },
      });
      ids.attempts.push(attempt.id);
      const order = await prisma.order.create({
        data: {
          tenantId,
          orderNumber: `BRAND-${randomUUID().slice(0, 8)}`,
          accessToken: randomUUID(),
          locationId: location.id,
          paymentAttemptId: attempt.id,
          guestName: 'Branding Guest',
          guestPhone: '5551230000',
          guestEmail: `guest-${randomUUID()}@example.test`,
          currency: 'USD',
          subtotal: 500,
          status: 'RECEIVED',
        },
      });
      ids.orders.push(order.id);
      const event = await prisma.outboxEvent.create({
        data: {
          tenantId,
          aggregateType: 'Order',
          aggregateId: order.id,
          eventType,
          payload: {},
        },
      });
      ids.events.push(event.id);
      return {
        id: event.id,
        tenantId,
        aggregateType: 'Order',
        aggregateId: order.id,
        eventType,
      };
    }

    for (const eventType of [
      'order.checkout.completed',
      'order.status.ready',
    ]) {
      it(`${eventType}: Tenant B's customer email names only Tenant B`, async () => {
        await dispatch.dispatch(await orderEvent(TEST_TENANT_B_ID, eventType));
        const [email] = sender.getSent();
        expect(email.fromName).toBe(TEST_TENANT_B_NAME);
        expect(email.subject.startsWith(`${TEST_TENANT_B_NAME} — order`)).toBe(
          true,
        );
        expect(email.text.startsWith(TEST_TENANT_B_NAME)).toBe(true);
        expect(JSON.stringify(email)).not.toContain('Mocha House');
      });

      it(`${eventType}: Mocha House's customer email is unchanged`, async () => {
        await dispatch.dispatch(
          await orderEvent(TENANT_1_MOCHA_HOUSE_ID, eventType),
        );
        const [email] = sender.getSent();
        expect(email.fromName).toBe('Mocha House');
        expect(email.subject.startsWith('Mocha House — order')).toBe(true);
        expect(JSON.stringify(email)).not.toContain(TEST_TENANT_B_NAME);
      });
    }
  });
});
