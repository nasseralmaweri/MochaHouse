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
import { EMAIL_SENDER } from './email/email-sender';
import { LoggingEmailSender } from './email/logging-email-sender';
import { NotificationDispatchService } from './notification-dispatch.service';

// Milestone 8H — integration test against the real local Postgres instance,
// exercising NotificationDispatchService exactly as OutboxProcessorService
// calls it: with an already-claimed OutboxEvent row. No AWS credentials —
// LoggingEmailSender is injected directly as EMAIL_SENDER.
describe('NotificationDispatchService (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let dispatch: NotificationDispatchService;
  let sender: LoggingEmailSender;
  const originalEnv = { ...process.env };
  const suffix = randomUUID();

  const locationIds: string[] = [];
  const customerIds: string[] = [];
  const paymentAttemptIds: string[] = [];
  const orderIds: string[] = [];
  const jobOpeningIds: string[] = [];
  const jobApplicationIds: string[] = [];
  const franchiseInquiryIds: string[] = [];
  const outboxEventIds: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        NotificationDispatchService,
        LoggingEmailSender,
        { provide: EMAIL_SENDER, useExisting: LoggingEmailSender },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    dispatch = moduleRef.get(NotificationDispatchService);
    sender = moduleRef.get(LoggingEmailSender);
    await prisma.$connect();
    // Milestone S0D-2C-2 — Tenant B exists only for the cross-tenant
    // resolution-isolation tests below; every other test in this file
    // stays Tenant #1 only, as before.
    await createTestTenantB(prisma);
  });

  afterEach(() => {
    sender.clear();
  });

  afterAll(async () => {
    process.env = { ...originalEnv };
    await prisma.notificationDelivery.deleteMany({
      where: { outboxEventId: { in: outboxEventIds } },
    });
    await prisma.outboxEvent.deleteMany({ where: { id: { in: outboxEventIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.paymentAttempt.deleteMany({
      where: { id: { in: paymentAttemptIds } },
    });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.jobApplication.deleteMany({
      where: { id: { in: jobApplicationIds } },
    });
    await prisma.jobOpening.deleteMany({ where: { id: { in: jobOpeningIds } } });
    await prisma.franchiseInquiry.deleteMany({
      where: { id: { in: franchiseInquiryIds } },
    });
    await prisma.location.deleteMany({ where: { id: { in: locationIds } } });
    await removeTestTenantB(prisma);
    await moduleRef.close();
    await prisma.$disconnect();
  });

  async function makeLocation(
    tenantId: string = TENANT_1_MOCHA_HOUSE_ID,
  ): Promise<string> {
    const location = await prisma.location.create({
      data: {
        tenantId,
        name: `Notification Spec ${suffix} ${randomUUID().slice(0, 8)}`,
        slug: `notification-spec-${suffix}-${randomUUID().slice(0, 8)}`,
        isActive: true,
        isDigitalOrderingEnabled: true,
      },
    });
    locationIds.push(location.id);
    return location.id;
  }

  async function makeCustomer(overrides: {
    email?: string | null;
    marketingEmailOptIn?: boolean;
    tenantId?: string;
  } = {}): Promise<string> {
    const customer = await prisma.customer.create({
      data: {
        tenantId: overrides.tenantId ?? TENANT_1_MOCHA_HOUSE_ID,
        externalProvider: 'dev',
        externalSubject: `notification-spec-${randomUUID()}`,
        email: overrides.email ?? `customer-${randomUUID()}@example.com`,
        marketingEmailOptIn: overrides.marketingEmailOptIn ?? false,
      },
    });
    customerIds.push(customer.id);
    return customer.id;
  }

  async function makeOrder(overrides: {
    locationId: string;
    customerId?: string | null;
    guestEmail?: string | null;
    tenantId?: string;
  }): Promise<{ orderId: string; orderNumber: string }> {
    const tenantId = overrides.tenantId ?? TENANT_1_MOCHA_HOUSE_ID;
    const paymentAttempt = await prisma.paymentAttempt.create({
      data: {
        tenantId,
        idempotencyKey: `notification-spec-${randomUUID()}`,
        provider: 'fake',
        status: 'SUCCEEDED',
        locationId: overrides.locationId,
        amount: 500,
        currency: 'USD',
      },
    });
    paymentAttemptIds.push(paymentAttempt.id);

    const orderNumber = `NSPEC-${randomUUID().slice(0, 8)}`;
    const order = await prisma.order.create({
      data: {
        tenantId,
        orderNumber,
        accessToken: randomUUID(),
        locationId: overrides.locationId,
        customerId: overrides.customerId ?? null,
        paymentAttemptId: paymentAttempt.id,
        guestName: 'Notification Spec Guest',
        guestPhone: '5551230000',
        guestEmail: overrides.guestEmail ?? null,
        currency: 'USD',
        subtotal: 500,
        status: 'RECEIVED',
      },
    });
    orderIds.push(order.id);
    return { orderId: order.id, orderNumber: order.orderNumber };
  }

  async function makeJobApplication(
    tenantId: string = TENANT_1_MOCHA_HOUSE_ID,
  ): Promise<{
    applicationId: string;
    firstName: string;
    lastName: string;
    jobTitleSnapshot: string;
  }> {
    const job = await prisma.jobOpening.create({
      data: {
        tenantId,
        title: `Barista ${suffix} ${randomUUID().slice(0, 8)}`,
        employmentType: 'FULL_TIME',
        summary: 'Make great coffee.',
        description: 'Full description.',
        responsibilities: 'Pull shots.',
        qualifications: 'Friendly.',
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
    });
    jobOpeningIds.push(job.id);

    const application = await prisma.jobApplication.create({
      data: {
        tenantId,
        jobOpeningId: job.id,
        jobTitleSnapshot: job.title,
        firstName: 'Dana',
        lastName: 'Rivera',
        email: `dana-${randomUUID()}@example.com`,
        phone: '555-0100',
        location: 'Austin, TX',
        workAuthorized: true,
        availability: 'Weekday mornings',
        message: 'I love coffee and hospitality.',
      },
    });
    jobApplicationIds.push(application.id);
    return {
      applicationId: application.id,
      firstName: application.firstName,
      lastName: application.lastName,
      jobTitleSnapshot: application.jobTitleSnapshot,
    };
  }

  async function makeFranchiseInquiry(
    tenantId: string = TENANT_1_MOCHA_HOUSE_ID,
  ): Promise<{
    inquiryId: string;
    preferredMarket: string;
  }> {
    const preferredMarket = `Central Texas ${suffix} ${randomUUID().slice(0, 8)}`;
    const inquiry = await prisma.franchiseInquiry.create({
      data: {
        tenantId,
        firstName: 'Jordan',
        lastName: 'Lee',
        email: `jordan-${randomUUID()}@example.com`,
        phone: '555-0100',
        city: 'Austin',
        state: 'TX',
        country: 'USA',
        preferredMarket,
        consentAcknowledged: true,
      },
    });
    franchiseInquiryIds.push(inquiry.id);
    return { inquiryId: inquiry.id, preferredMarket };
  }

  async function makeOutboxEvent(input: {
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    tenantId?: string;
  }): Promise<string> {
    const { tenantId = TENANT_1_MOCHA_HOUSE_ID, ...rest } = input;
    const event = await prisma.outboxEvent.create({
      data: { ...rest, tenantId, payload: {} },
    });
    outboxEventIds.push(event.id);
    return event.id;
  }

  // --- Order Received --------------------------------------------------

  it('sends order.received to the signed-in customer email and records SENT, ignoring marketingEmailOptIn=false', async () => {
    const locationId = await makeLocation();
    const customerId = await makeCustomer({
      email: `customer-${randomUUID()}@example.com`,
      marketingEmailOptIn: false,
    });
    const { orderId, orderNumber } = await makeOrder({ locationId, customerId });
    const eventId = await makeOutboxEvent({
      aggregateType: 'Order',
      aggregateId: orderId,
      eventType: 'order.checkout.completed',
    });

    await dispatch.dispatch({
      id: eventId,
      tenantId: TENANT_1_MOCHA_HOUSE_ID,
      aggregateType: 'Order',
      aggregateId: orderId,
      eventType: 'order.checkout.completed',
    });

    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
    });
    expect(sender.getSent()).toHaveLength(1);
    expect(sender.getSent()[0]!.to).toBe(customer.email);
    expect(sender.getSent()[0]!.subject).toContain(orderNumber);

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { outboxEventId_channel: { outboxEventId: eventId, channel: 'EMAIL' } },
    });
    expect(delivery.status).toBe('SENT');
    expect(delivery.templateKey).toBe('order.received');
    expect(delivery.recipient).toBe(customer.email);
    expect(delivery.sentAt).not.toBeNull();
    // Privacy: no message body/rendered content or credentials are ever
    // persisted — only what's needed to know what was sent and whether it
    // worked.
    expect(Object.keys(delivery).sort()).toEqual(
      [
        'aggregateId',
        'aggregateType',
        'channel',
        'createdAt',
        'failureReason',
        'id',
        'outboxEventId',
        'providerMessageId',
        'recipient',
        'sentAt',
        'status',
        'templateKey',
        // Milestone S0D-1 — the owning tenant (ownership metadata, not
        // message content).
        'tenantId',
      ].sort(),
    );
  });

  it('sends order.received to the guest email when there is no signed-in customer', async () => {
    const locationId = await makeLocation();
    const guestEmail = `guest-${randomUUID()}@example.com`;
    const { orderId } = await makeOrder({ locationId, guestEmail });
    const eventId = await makeOutboxEvent({
      aggregateType: 'Order',
      aggregateId: orderId,
      eventType: 'order.checkout.completed',
    });

    await dispatch.dispatch({
      id: eventId,
      tenantId: TENANT_1_MOCHA_HOUSE_ID,
      aggregateType: 'Order',
      aggregateId: orderId,
      eventType: 'order.checkout.completed',
    });

    expect(sender.getSent()).toHaveLength(1);
    expect(sender.getSent()[0]!.to).toBe(guestEmail);
  });

  it('records FAILED (never throws) when an order has no recipient email available', async () => {
    const locationId = await makeLocation();
    const { orderId } = await makeOrder({ locationId, guestEmail: null });
    const eventId = await makeOutboxEvent({
      aggregateType: 'Order',
      aggregateId: orderId,
      eventType: 'order.checkout.completed',
    });

    await expect(
      dispatch.dispatch({
        id: eventId,
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        aggregateType: 'Order',
        aggregateId: orderId,
        eventType: 'order.checkout.completed',
      }),
    ).resolves.not.toThrow();

    expect(sender.getSent()).toHaveLength(0);
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { outboxEventId_channel: { outboxEventId: eventId, channel: 'EMAIL' } },
    });
    expect(delivery.status).toBe('FAILED');
    expect(delivery.failureReason).toContain('No recipient email');
  });

  // --- Order Ready -------------------------------------------------------

  it('sends order.ready with the ready-for-pickup template', async () => {
    const locationId = await makeLocation();
    const guestEmail = `guest-${randomUUID()}@example.com`;
    const { orderId, orderNumber } = await makeOrder({ locationId, guestEmail });
    const eventId = await makeOutboxEvent({
      aggregateType: 'Order',
      aggregateId: orderId,
      eventType: 'order.status.ready',
    });

    await dispatch.dispatch({
      id: eventId,
      tenantId: TENANT_1_MOCHA_HOUSE_ID,
      aggregateType: 'Order',
      aggregateId: orderId,
      eventType: 'order.status.ready',
    });

    expect(sender.getSent()).toHaveLength(1);
    expect(sender.getSent()[0]!.to).toBe(guestEmail);
    expect(sender.getSent()[0]!.subject).toContain(orderNumber);
    expect(sender.getSent()[0]!.subject.toLowerCase()).toContain('ready');

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { outboxEventId_channel: { outboxEventId: eventId, channel: 'EMAIL' } },
    });
    expect(delivery.templateKey).toBe('order.ready');
    expect(delivery.status).toBe('SENT');
  });

  // --- Careers -------------------------------------------------------

  it('sends the internal new-applicant email to CAREERS_NOTIFICATION_EMAIL', async () => {
    process.env.CAREERS_NOTIFICATION_EMAIL = 'careers-inbox@example.com';
    const { applicationId, jobTitleSnapshot } = await makeJobApplication();
    const eventId = await makeOutboxEvent({
      aggregateType: 'JobApplication',
      aggregateId: applicationId,
      eventType: 'careers.application.submitted',
    });

    await dispatch.dispatch({
      id: eventId,
      tenantId: TENANT_1_MOCHA_HOUSE_ID,
      aggregateType: 'JobApplication',
      aggregateId: applicationId,
      eventType: 'careers.application.submitted',
    });

    expect(sender.getSent()).toHaveLength(1);
    expect(sender.getSent()[0]!.to).toBe('careers-inbox@example.com');
    expect(sender.getSent()[0]!.subject).toContain(jobTitleSnapshot);

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { outboxEventId_channel: { outboxEventId: eventId, channel: 'EMAIL' } },
    });
    expect(delivery.status).toBe('SENT');
    expect(delivery.templateKey).toBe('careers.application.received');
  });

  it('records FAILED without throwing when CAREERS_NOTIFICATION_EMAIL is not configured', async () => {
    delete process.env.CAREERS_NOTIFICATION_EMAIL;
    const { applicationId } = await makeJobApplication();
    const eventId = await makeOutboxEvent({
      aggregateType: 'JobApplication',
      aggregateId: applicationId,
      eventType: 'careers.application.submitted',
    });

    await expect(
      dispatch.dispatch({
        id: eventId,
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        aggregateType: 'JobApplication',
        aggregateId: applicationId,
        eventType: 'careers.application.submitted',
      }),
    ).resolves.not.toThrow();

    expect(sender.getSent()).toHaveLength(0);
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { outboxEventId_channel: { outboxEventId: eventId, channel: 'EMAIL' } },
    });
    expect(delivery.status).toBe('FAILED');
    expect(delivery.failureReason).toContain('CAREERS_NOTIFICATION_EMAIL');
  });

  // --- Franchising -----------------------------------------------------

  it('sends the internal new-inquiry email to FRANCHISING_NOTIFICATION_EMAIL', async () => {
    process.env.FRANCHISING_NOTIFICATION_EMAIL = 'franchising-inbox@example.com';
    const { inquiryId, preferredMarket } = await makeFranchiseInquiry();
    const eventId = await makeOutboxEvent({
      aggregateType: 'FranchiseInquiry',
      aggregateId: inquiryId,
      eventType: 'franchising.inquiry.submitted',
    });

    await dispatch.dispatch({
      id: eventId,
      tenantId: TENANT_1_MOCHA_HOUSE_ID,
      aggregateType: 'FranchiseInquiry',
      aggregateId: inquiryId,
      eventType: 'franchising.inquiry.submitted',
    });

    expect(sender.getSent()).toHaveLength(1);
    expect(sender.getSent()[0]!.to).toBe('franchising-inbox@example.com');
    expect(sender.getSent()[0]!.subject).toContain(preferredMarket);

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { outboxEventId_channel: { outboxEventId: eventId, channel: 'EMAIL' } },
    });
    expect(delivery.status).toBe('SENT');
    expect(delivery.templateKey).toBe('franchising.inquiry.received');
  });

  // --- Idempotency / duplicate protection -------------------------------

  it('never sends twice for the same OutboxEvent even if dispatch is called again', async () => {
    const locationId = await makeLocation();
    const guestEmail = `guest-${randomUUID()}@example.com`;
    const { orderId } = await makeOrder({ locationId, guestEmail });
    const eventId = await makeOutboxEvent({
      aggregateType: 'Order',
      aggregateId: orderId,
      eventType: 'order.checkout.completed',
    });
    const claimed = {
      id: eventId,
      tenantId: TENANT_1_MOCHA_HOUSE_ID,
      aggregateType: 'Order',
      aggregateId: orderId,
      eventType: 'order.checkout.completed',
    };

    await dispatch.dispatch(claimed);
    await dispatch.dispatch(claimed);
    await dispatch.dispatch(claimed);

    expect(sender.getSent()).toHaveLength(1);
    expect(
      await prisma.notificationDelivery.count({
        where: { outboxEventId: eventId },
      }),
    ).toBe(1);
  });

  // --- Unrecognized event types ------------------------------------------

  it('is a no-op for an eventType it does not recognize', async () => {
    const eventId = await makeOutboxEvent({
      aggregateType: 'Order',
      aggregateId: randomUUID(),
      eventType: 'order.some.future.event',
    });

    await dispatch.dispatch({
      id: eventId,
      tenantId: TENANT_1_MOCHA_HOUSE_ID,
      aggregateType: 'Order',
      aggregateId: randomUUID(),
      eventType: 'order.some.future.event',
    });

    expect(sender.getSent()).toHaveLength(0);
    expect(
      await prisma.notificationDelivery.count({ where: { outboxEventId: eventId } }),
    ).toBe(0);
  });

  // --- Milestone S0D-2C-2: tenant-scoped aggregate resolution -----------
  //
  // Every lookup in resolve() now requires BOTH the aggregate id AND the
  // tenantId carried by the claimed event. A mismatched combination must
  // behave exactly like "aggregate not found" — same error, same FAILED
  // delivery, no email ever sent — never a cross-tenant disclosure.

  it("a Tenant A event cannot resolve a Tenant B Order — fails closed, FAILED delivery, no email sent", async () => {
    const locationId = await makeLocation(TEST_TENANT_B_ID);
    const guestEmail = `guest-${randomUUID()}@example.com`;
    const { orderId } = await makeOrder({
      locationId,
      guestEmail,
      tenantId: TEST_TENANT_B_ID,
    });
    // The OutboxEvent claims Tenant #1 even though the Order it names
    // actually belongs to Tenant B — exactly the mismatch a corrupted or
    // mis-produced event would create.
    const eventId = await makeOutboxEvent({
      aggregateType: 'Order',
      aggregateId: orderId,
      eventType: 'order.checkout.completed',
      tenantId: TENANT_1_MOCHA_HOUSE_ID,
    });

    await expect(
      dispatch.dispatch({
        id: eventId,
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        aggregateType: 'Order',
        aggregateId: orderId,
        eventType: 'order.checkout.completed',
      }),
    ).resolves.not.toThrow();

    expect(sender.getSent()).toHaveLength(0);
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { outboxEventId_channel: { outboxEventId: eventId, channel: 'EMAIL' } },
    });
    expect(delivery.status).toBe('FAILED');
    expect(delivery.failureReason).toContain('Order not found');
    // The delivery itself still carries the EVENT's tenant (Tenant #1) —
    // never silently reassigned to the aggregate's actual tenant.
    expect(delivery.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
  });

  it('a Tenant B event cannot resolve a Tenant A Order — same failure, reversed', async () => {
    const locationId = await makeLocation(TENANT_1_MOCHA_HOUSE_ID);
    const guestEmail = `guest-${randomUUID()}@example.com`;
    const { orderId } = await makeOrder({
      locationId,
      guestEmail,
      tenantId: TENANT_1_MOCHA_HOUSE_ID,
    });
    const eventId = await makeOutboxEvent({
      aggregateType: 'Order',
      aggregateId: orderId,
      eventType: 'order.checkout.completed',
      tenantId: TEST_TENANT_B_ID,
    });

    await expect(
      dispatch.dispatch({
        id: eventId,
        tenantId: TEST_TENANT_B_ID,
        aggregateType: 'Order',
        aggregateId: orderId,
        eventType: 'order.checkout.completed',
      }),
    ).resolves.not.toThrow();

    expect(sender.getSent()).toHaveLength(0);
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { outboxEventId_channel: { outboxEventId: eventId, channel: 'EMAIL' } },
    });
    expect(delivery.status).toBe('FAILED');
    expect(delivery.failureReason).toContain('Order not found');
  });

  it('a Tenant A event cannot resolve a Tenant B JobApplication', async () => {
    process.env.CAREERS_NOTIFICATION_EMAIL = 'careers-inbox@example.com';
    const { applicationId } = await makeJobApplication(TEST_TENANT_B_ID);
    const eventId = await makeOutboxEvent({
      aggregateType: 'JobApplication',
      aggregateId: applicationId,
      eventType: 'careers.application.submitted',
      tenantId: TENANT_1_MOCHA_HOUSE_ID,
    });

    await expect(
      dispatch.dispatch({
        id: eventId,
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        aggregateType: 'JobApplication',
        aggregateId: applicationId,
        eventType: 'careers.application.submitted',
      }),
    ).resolves.not.toThrow();

    expect(sender.getSent()).toHaveLength(0);
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { outboxEventId_channel: { outboxEventId: eventId, channel: 'EMAIL' } },
    });
    expect(delivery.status).toBe('FAILED');
    expect(delivery.failureReason).toContain('Job application not found');
  });

  it('a Tenant A event cannot resolve a Tenant B FranchiseInquiry', async () => {
    process.env.FRANCHISING_NOTIFICATION_EMAIL = 'franchising-inbox@example.com';
    const { inquiryId } = await makeFranchiseInquiry(TEST_TENANT_B_ID);
    const eventId = await makeOutboxEvent({
      aggregateType: 'FranchiseInquiry',
      aggregateId: inquiryId,
      eventType: 'franchising.inquiry.submitted',
      tenantId: TENANT_1_MOCHA_HOUSE_ID,
    });

    await expect(
      dispatch.dispatch({
        id: eventId,
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        aggregateType: 'FranchiseInquiry',
        aggregateId: inquiryId,
        eventType: 'franchising.inquiry.submitted',
      }),
    ).resolves.not.toThrow();

    expect(sender.getSent()).toHaveLength(0);
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { outboxEventId_channel: { outboxEventId: eventId, channel: 'EMAIL' } },
    });
    expect(delivery.status).toBe('FAILED');
    expect(delivery.failureReason).toContain('Franchise inquiry not found');
  });

  it('a correctly-scoped Order lookup still succeeds for its own tenant (no over-correction)', async () => {
    const locationId = await makeLocation(TEST_TENANT_B_ID);
    const guestEmail = `guest-${randomUUID()}@example.com`;
    const { orderId, orderNumber } = await makeOrder({
      locationId,
      guestEmail,
      tenantId: TEST_TENANT_B_ID,
    });
    const eventId = await makeOutboxEvent({
      aggregateType: 'Order',
      aggregateId: orderId,
      eventType: 'order.checkout.completed',
      tenantId: TEST_TENANT_B_ID,
    });

    await dispatch.dispatch({
      id: eventId,
      tenantId: TEST_TENANT_B_ID,
      aggregateType: 'Order',
      aggregateId: orderId,
      eventType: 'order.checkout.completed',
    });

    expect(sender.getSent()).toHaveLength(1);
    expect(sender.getSent()[0]!.to).toBe(guestEmail);
    expect(sender.getSent()[0]!.subject).toContain(orderNumber);
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { outboxEventId_channel: { outboxEventId: eventId, channel: 'EMAIL' } },
    });
    expect(delivery.status).toBe('SENT');
    expect(delivery.tenantId).toBe(TEST_TENANT_B_ID);
  });

  // --- Failure sanitization ----------------------------------------------

  it('bounds a failure reason to 500 characters and never lets an email-send error escape', async () => {
    const locationId = await makeLocation();
    const guestEmail = `guest-${randomUUID()}@example.com`;
    const { orderId } = await makeOrder({ locationId, guestEmail });
    const eventId = await makeOutboxEvent({
      aggregateType: 'Order',
      aggregateId: orderId,
      eventType: 'order.checkout.completed',
    });

    const failingModuleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        NotificationDispatchService,
        {
          provide: EMAIL_SENDER,
          useValue: {
            send: async () => {
              throw new Error('x'.repeat(1000));
            },
          },
        },
      ],
    }).compile();
    const failingDispatch = failingModuleRef.get(NotificationDispatchService);

    await expect(
      failingDispatch.dispatch({
        id: eventId,
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        aggregateType: 'Order',
        aggregateId: orderId,
        eventType: 'order.checkout.completed',
      }),
    ).resolves.not.toThrow();

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { outboxEventId_channel: { outboxEventId: eventId, channel: 'EMAIL' } },
    });
    expect(delivery.status).toBe('FAILED');
    expect(delivery.failureReason!.length).toBeLessThanOrEqual(500);

    await failingModuleRef.close();
  });
});
