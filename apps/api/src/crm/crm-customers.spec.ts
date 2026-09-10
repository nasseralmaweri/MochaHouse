import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminCustomerDetail,
  AdminCustomerListResponse,
  CustomerNote,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { CrmModule } from './crm.module';

// Milestone 8A — Admin → Customers (HQ CRM foundation) over real local
// Postgres, mirroring admin-audit.spec.ts. Uses the seeded
// dearborn-heights fixture for the order-aggregation test.
describe('Admin CRM customers (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'crm-customers-spec-internal-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const customerIds: string[] = [];
  const orderIds: string[] = [];
  const paymentAttemptIds: string[] = [];

  const roles: Record<string, string> = {};
  const users: Record<string, string> = {};

  const token = (key: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${key}`, email: `${key}@example.com`, name: null },
      internalSecret,
      3600,
    );

  async function makeUser(key: string): Promise<string> {
    const user = await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${key}`,
        email: `${key}@example.com`,
        displayName: key,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(user.id);
    users[key] = user.id;
    return user.id;
  }

  async function makeRole(
    displayName: string,
    permissionKeys: string[],
  ): Promise<string> {
    const role = await prisma.internalRole.create({
      data: {
        key: `crm-spec-${suffix}-${randomUUID()}`,
        displayName,
        permissions: {
          create: permissionKeys.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    roleIds.push(role.id);
    return role.id;
  }

  async function assign(
    userKey: string,
    roleId: string,
    scope: { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null },
  ): Promise<void> {
    await prisma.internalUserRoleAssignment.create({
      data: { internalUserId: users[userKey]!, roleId, ...scope },
    });
  }

  async function makeCustomer(
    overrides: Partial<{
      email: string;
      displayName: string | null;
      emailVerifiedAt: Date | null;
      marketingEmailOptIn: boolean;
      createdAt: Date;
    }> = {},
  ): Promise<string> {
    const subject = `crm-${suffix}-${randomUUID()}`;
    const customer = await prisma.customer.create({
      data: {
        externalProvider: 'crm-spec',
        externalSubject: subject,
        email: overrides.email ?? `${subject}@example.com`,
        displayName:
          overrides.displayName === undefined
            ? `Customer ${subject.slice(0, 6)}`
            : overrides.displayName,
        emailVerifiedAt: overrides.emailVerifiedAt ?? null,
        marketingEmailOptIn: overrides.marketingEmailOptIn ?? false,
        ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      },
    });
    customerIds.push(customer.id);
    return customer.id;
  }

  const listReq = (key: string, qs = '') =>
    request(app.getHttpServer())
      .get(`/api/v1/admin/customers${qs}`)
      .set('Authorization', `Bearer ${token(key)}`);

  const detailReq = (key: string, customerId: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${customerId}`)
      .set('Authorization', `Bearer ${token(key)}`);

  const notesReq = (key: string, customerId: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/admin/customers/${customerId}/notes`)
      .set('Authorization', `Bearer ${token(key)}`);

  const addNoteReq = (key: string, customerId: string, body: unknown) =>
    request(app.getHttpServer())
      .post(`/api/v1/admin/customers/${customerId}/notes`)
      .set('Authorization', `Bearer ${token(key)}`)
      .send(body as object);

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.GIFT_CARD_CODE_SECRET = 'crm-spec-gift-card-code-secret';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        CrmModule,
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    roles.crmView = await makeRole('CRM Viewer', ['customers.view']);
    roles.crmNotes = await makeRole('CRM Notes', [
      'customers.view',
      'customers.notes.manage',
    ]);
    roles.viewOnly = await makeRole('CRM View Only', ['customers.view']);
    roles.noCrm = await makeRole('Orders Only', ['orders.view']);

    await makeUser(`viewer-${suffix}`);
    await assign(`viewer-${suffix}`, roles.crmView, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await makeUser(`notes-${suffix}`);
    await assign(`notes-${suffix}`, roles.crmNotes, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await makeUser(`viewOnly-${suffix}`);
    await assign(`viewOnly-${suffix}`, roles.viewOnly, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await makeUser(`noPerm-${suffix}`);
    await assign(`noPerm-${suffix}`, roles.noCrm, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    // customers.view granted only at LOCATION scope — must be rejected
    // (CORPORATE-only).
    const location = await prisma.location.findFirstOrThrow();
    await makeUser(`locScoped-${suffix}`);
    await assign(`locScoped-${suffix}`, roles.crmView, {
      scopeType: 'LOCATION',
      scopeId: location.id,
    });
  });

  afterAll(async () => {
    await prisma.customerNote.deleteMany({
      where: { customerId: { in: customerIds } },
    });
    await prisma.internalAuditEvent.deleteMany({
      where: { targetType: 'customer', targetId: { in: customerIds } },
    });
    await prisma.giftCardTransaction.deleteMany({
      where: { giftCardPurchase: { customerId: { in: customerIds } } },
    });
    const purchases = await prisma.giftCardPurchase.findMany({
      where: { customerId: { in: customerIds } },
      select: { id: true, giftCardId: true, paymentAttemptId: true },
    });
    await prisma.giftCardPurchase.deleteMany({
      where: { id: { in: purchases.map((p) => p.id) } },
    });
    await prisma.giftCard.deleteMany({
      where: {
        id: {
          in: purchases
            .map((p) => p.giftCardId)
            .filter((v): v is string => v !== null),
        },
      },
    });
    await prisma.orderLine.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderStatusHistory.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.outboxEvent.deleteMany({
      where: { aggregateType: 'Order', aggregateId: { in: orderIds } },
    });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.mochaBeanLedgerEntry.deleteMany({
      where: { loyaltyAccount: { customerId: { in: customerIds } } },
    });
    await prisma.customerLoyaltyAccount.deleteMany({
      where: { customerId: { in: customerIds } },
    });
    await prisma.paymentAttempt.deleteMany({
      where: {
        id: {
          in: [
            ...paymentAttemptIds,
            ...purchases.map((p) => p.paymentAttemptId),
          ],
        },
      },
    });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIds } },
    });
    await prisma.internalRolePermission.deleteMany({
      where: { roleId: { in: roleIds } },
    });
    await prisma.internalRole.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
    await prisma.$disconnect();
    process.env = { ...originalEnv };
  });

  // --- authorization ------------------------------------------

  it('rejects a caller with no customers.view permission (403)', async () => {
    await listReq(`noPerm-${suffix}`).expect(403);
    const c = await makeCustomer();
    await detailReq(`noPerm-${suffix}`, c).expect(403);
    await notesReq(`noPerm-${suffix}`, c).expect(403);
  });

  it('rejects customers.view held only at LOCATION scope — CORPORATE-only (403)', async () => {
    await listReq(`locScoped-${suffix}`).expect(403);
  });

  it('rejects adding a note with only customers.view (403), and no note is created', async () => {
    const c = await makeCustomer();
    await addNoteReq(`viewOnly-${suffix}`, c, { body: 'nope' }).expect(403);
    const notes = await prisma.customerNote.count({ where: { customerId: c } });
    expect(notes).toBe(0);
  });

  it('requires an internal session (401 with no token)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/customers')
      .expect(401);
  });

  // --- list / search / pagination --------------------------

  it('lists customers newest-first, cursor-paginated', async () => {
    const base = Date.now();
    const made: string[] = [];
    for (let i = 0; i < 4; i++) {
      made.push(
        await makeCustomer({
          displayName: `Page Test ${suffix} ${i}`,
          createdAt: new Date(base - i * 1000),
        }),
      );
    }

    const page1 = (
      await listReq(
        `viewer-${suffix}`,
        `?q=${encodeURIComponent(`Page Test ${suffix}`)}&`,
      ).expect(200)
    ).body as AdminCustomerListResponse;
    expect(page1.customers.length).toBeGreaterThanOrEqual(1);
    // newest first
    const times = page1.customers.map((c) =>
      new Date(c.createdAt).getTime(),
    );
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('search matches a case-insensitive email OR displayName substring', async () => {
    const token = randomUUID().slice(0, 8);
    const byEmail = await makeCustomer({
      email: `find-${token}@example.com`,
      displayName: 'Zzz Nomatch',
    });
    const byName = await makeCustomer({
      email: `other-${randomUUID()}@example.com`,
      displayName: `Findable ${token}`,
    });

    const res = (
      await listReq(
        `viewer-${suffix}`,
        `?q=${encodeURIComponent(token.toUpperCase())}`,
      ).expect(200)
    ).body as AdminCustomerListResponse;
    const ids = res.customers.map((c) => c.id);
    expect(ids).toContain(byEmail);
    expect(ids).toContain(byName);
  });

  it('search matches an exact customer id', async () => {
    const c = await makeCustomer();
    const res = (
      await listReq(`viewer-${suffix}`, `?q=${c}`).expect(200)
    ).body as AdminCustomerListResponse;
    expect(res.customers.map((x) => x.id)).toEqual([c]);
  });

  // --- detail aggregation ---------------------------------

  it('404s for an unknown customer id', async () => {
    await detailReq(`viewer-${suffix}`, randomUUID()).expect(404);
  });

  it('detail: empty sections for a customer with no activity', async () => {
    const c = await makeCustomer({
      emailVerifiedAt: new Date(),
      marketingEmailOptIn: true,
    });
    const body = (await detailReq(`viewer-${suffix}`, c).expect(200))
      .body as AdminCustomerDetail;

    expect(body.customer.id).toBe(c);
    expect(body.customer.emailVerified).toBe(true);
    expect(body.customer.marketingEmailOptIn).toBe(true);
    // no emailVerifiedAt leaked
    expect(JSON.stringify(body.customer)).not.toContain('emailVerifiedAt');
    expect(body.orders).toEqual({ count: 0, recent: [] });
    expect(body.mochaBeans).toEqual({ balance: 0, recentActivity: [] });
    expect(body.giftCards).toEqual({ purchases: [], redemptions: [] });
    expect(body.preferredLocations).toEqual([]);
    expect(body.communicationPreferences).toEqual({ marketingEmailOptIn: true });
    expect(body.notes).toEqual([]);
    expect(body.activity).toEqual([]);
  });

  it('detail: aggregates orders, Mocha Beans, gift cards, preferred locations', async () => {
    const location = await prisma.location.findUniqueOrThrow({
      where: { slug: 'dearborn-heights' },
    });
    const c = await makeCustomer();

    // Loyalty account + a manual adjustment (also produces a customer audit
    // event for the timeline).
    const account = await prisma.customerLoyaltyAccount.create({
      data: { customerId: c, balance: 120 },
    });
    await prisma.mochaBeanLedgerEntry.create({
      data: {
        loyaltyAccountId: account.id,
        type: 'MANUAL_ADJUSTMENT',
        amount: 120,
        reason: 'Goodwill',
        actorInternalUserId: users[`notes-${suffix}`],
        operationKey: `crm-spec-${randomUUID()}`,
      },
    });
    await prisma.internalAuditEvent.create({
      data: {
        actorInternalUserId: users[`notes-${suffix}`],
        action: 'loyalty.beans_adjusted',
        targetType: 'customer',
        targetId: c,
        beforeData: { balance: 0 },
        afterData: { balance: 120, delta: 120 },
        reason: 'Goodwill',
      },
    });

    // A paid order.
    const attempt = await prisma.paymentAttempt.create({
      data: {
        idempotencyKey: `crm-spec-${randomUUID()}`,
        provider: 'fake',
        locationId: location.id,
        amount: 400,
        currency: 'USD',
        status: 'SUCCEEDED',
      },
    });
    paymentAttemptIds.push(attempt.id);
    const order = await prisma.order.create({
      data: {
        orderNumber: `CRM-${randomUUID().slice(0, 8)}`,
        accessToken: randomUUID(),
        locationId: location.id,
        customerId: c,
        paymentAttemptId: attempt.id,
        guestName: 'CRM Spec',
        guestPhone: '5550000000',
        currency: 'USD',
        subtotal: 400,
      },
    });
    orderIds.push(order.id);

    // A gift card purchased by this customer.
    const gcAttempt = await prisma.paymentAttempt.create({
      data: {
        idempotencyKey: `crm-spec-gc-${randomUUID()}`,
        provider: 'fake',
        amount: 2500,
        currency: 'USD',
        status: 'SUCCEEDED',
      },
    });
    const giftCard = await prisma.giftCard.create({
      data: {
        codeHash: `crm-spec-${randomUUID()}`,
        last4: 'WXYZ',
        originalValueMinorUnits: 2500,
        balanceMinorUnits: 2500,
        currency: 'USD',
      },
    });
    await prisma.giftCardPurchase.create({
      data: {
        paymentAttemptId: gcAttempt.id,
        giftCardId: giftCard.id,
        customerId: c,
        amountMinorUnits: 2500,
        currency: 'USD',
        status: 'ISSUED',
        purchaserEmail: 'crm@example.com',
      },
    });

    await prisma.customerPreferredLocation.create({
      data: { customerId: c, locationId: location.id },
    });

    const body = (await detailReq(`viewer-${suffix}`, c).expect(200))
      .body as AdminCustomerDetail;

    expect(body.orders.count).toBe(1);
    expect(body.orders.recent[0]!.orderId).toBe(order.id);
    expect(body.mochaBeans.balance).toBe(120);
    expect(body.mochaBeans.recentActivity[0]!.amount).toBe(120);
    expect(body.giftCards.purchases).toHaveLength(1);
    expect(body.giftCards.purchases[0]!.last4).toBe('WXYZ');
    expect(body.giftCards.purchases[0]!.maskedCode).toBe(
      '•••• •••• •••• WXYZ',
    );
    // no codeHash / full code
    expect(JSON.stringify(body.giftCards)).not.toContain('codeHash');
    expect(body.preferredLocations.map((l) => l.id)).toEqual([location.id]);
    expect(body.activity.some((a) => a.summary.includes('Mocha Beans'))).toBe(
      true,
    );
  });

  // --- notes -----------------------------------------------

  it('adds a note: trimmed, persisted, newest-first, audited atomically, actor from token', async () => {
    const c = await makeCustomer();
    const before = await prisma.internalAuditEvent.count();

    const res = (
      await addNoteReq(`notes-${suffix}`, c, {
        body: '  First contact — asked about refunds.  ',
        authorInternalUserId: 'ignored-from-body',
      }).expect(201)
    ).body as CustomerNote[];

    expect(res).toHaveLength(1);
    expect(res[0]!.body).toBe('First contact — asked about refunds.');

    const stored = await prisma.customerNote.findFirstOrThrow({
      where: { customerId: c },
    });
    expect(stored.body).toBe('First contact — asked about refunds.');
    // actor is the authenticated user, never the body value
    expect(stored.authorInternalUserId).toBe(users[`notes-${suffix}`]);

    const audit = await prisma.internalAuditEvent.findFirstOrThrow({
      where: { targetType: 'customer', targetId: c, action: 'crm.note_added' },
    });
    expect(audit.actorInternalUserId).toBe(users[`notes-${suffix}`]);
    expect(JSON.stringify(audit.afterData)).not.toContain('First contact');
    expect(await prisma.internalAuditEvent.count()).toBe(before + 1);

    // second note → newest first
    await addNoteReq(`notes-${suffix}`, c, { body: 'Second note' }).expect(201);
    const list = (await notesReq(`viewer-${suffix}`, c).expect(200))
      .body as CustomerNote[];
    expect(list.map((n) => n.body)).toEqual([
      'Second note',
      'First contact — asked about refunds.',
    ]);
    expect(list[0]!.authorLabel).toBe(`notes-${suffix}`);
  });

  it('rejects an empty or over-long note body (400) and writes nothing', async () => {
    const c = await makeCustomer();
    const before = await prisma.internalAuditEvent.count();
    await addNoteReq(`notes-${suffix}`, c, { body: '   ' }).expect(400);
    await addNoteReq(`notes-${suffix}`, c, { body: 'x'.repeat(2001) }).expect(
      400,
    );
    expect(await prisma.customerNote.count({ where: { customerId: c } })).toBe(
      0,
    );
    expect(await prisma.internalAuditEvent.count()).toBe(before);
  });

  it('404s when adding a note to an unknown customer', async () => {
    await addNoteReq(`notes-${suffix}`, randomUUID(), {
      body: 'orphan',
    }).expect(404);
  });

  it('activity/notes are isolated between customers', async () => {
    const a = await makeCustomer();
    const b = await makeCustomer();
    await addNoteReq(`notes-${suffix}`, a, { body: 'for A only' }).expect(201);

    const detailB = (await detailReq(`viewer-${suffix}`, b).expect(200))
      .body as AdminCustomerDetail;
    expect(detailB.notes).toEqual([]);
    expect(detailB.activity).toEqual([]);

    const detailA = (await detailReq(`viewer-${suffix}`, a).expect(200))
      .body as AdminCustomerDetail;
    expect(detailA.notes.map((n) => n.body)).toEqual(['for A only']);
    expect(
      detailA.activity.some((x) => x.summary === 'Internal CRM note added'),
    ).toBe(true);
  });
});
