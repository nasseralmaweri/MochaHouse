import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminBillingPaymentMethodResponse,
  BillingInvoiceListResponse,
  InternalPermissionKey,
  PlatformReconciliationRunResponse,
} from '@mocha-house/contracts';
import {
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  type ScratchDatabase,
} from '@mocha-house/testing';
import { AppModule } from '../app.module';
import { grantPlatformPermissions } from '../../test/platform-permissions';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializable } from '../prisma/serializable-transaction';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signPlatformDevJwt } from '../platform-auth/infrastructure/platform-dev-jwt';
import { BillingLifecycleService } from './application/billing-lifecycle.service';
import type {
  FakeEventBody,
  FakeSaasBillingProvider,
} from './provider/fake-saas-billing-provider';
import { SAAS_BILLING_PROVIDER } from './provider/saas-billing-provider';

// SC3e-1 — billing history, end to end on the real AppModule (fake provider)
// in a SCRATCH database:
//   * invoices are recorded only from a LIVE provider read, for the
//     subscription they belong to (OUR stored ids); duplicate and delayed
//     events change nothing; a contradiction is reviewed, never written;
//   * a business sees only its own invoices (paginated, newest first);
//     operators read any business's (read-only);
//   * a document link is resolved per request, for the business's own
//     invoice, re-checked live, on the provider's own host — never stored;
//   * the payment method is brand, last four and expiry — nothing else;
//   * the reconciliation sweep backfills missed invoices.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const DAY = 24 * 60 * 60 * 1000;

jest.setTimeout(180_000);

describe('SC3e-1 billing history (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let lifecycle: BillingLifecycleService;
  let fake: FakeSaasBillingProvider;
  const originalEnv = { ...process.env };
  const PLATFORM_SECRET = `sc3e1-platform-${randomUUID()}`;
  const INTERNAL_SECRET = `sc3e1-internal-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  let planVersionId: string;
  let planPriceId: string;

  const VIEW: InternalPermissionKey[] = ['billing.view', 'locations.view'];
  const MANAGE: InternalPermissionKey[] = [
    'billing.view',
    'billing.manage',
    'locations.view',
  ];

  const staffToken = (key: string) =>
    signInternalDevJwt(
      {
        sub: `internal-dev:sc3e1-${key}-${run}`,
        email: `sc3e1-${key}-${run}@example.com`,
        name: null,
        email_verified: true,
      },
      INTERNAL_SECRET,
      3600,
    );
  const asStaff = (
    method: 'get' | 'post',
    key: string,
    tenantId: string,
    path: string,
    body?: unknown,
  ) => {
    const req = request(app.getHttpServer())
      [method](`/api/v1/admin/billing${path}`)
      .set('Authorization', `Bearer ${staffToken(key)}`)
      .set('X-Tenant-Id', tenantId);
    return body !== undefined ? req.send(body as object) : req;
  };
  const operatorToken = (signedInSecondsAgo = 0) =>
    signPlatformDevJwt(
      {
        sub: `platform-dev:sc3e1-${run}`,
        mfa: true,
        iat: Math.floor(Date.now() / 1000) - signedInSecondsAgo,
      },
      PLATFORM_SECRET,
      3600,
    );
  const asOperator = (method: 'get' | 'post', path: string) =>
    request(app.getHttpServer())
      [method](`/api/v1/platform${path}`)
      .set('Authorization', `Bearer ${operatorToken()}`);
  const codeOf = (response: { body: unknown }) =>
    (response.body as { code: string }).code;

  interface Business {
    key: string;
    tenantId: string;
    subscriptionId: string;
    customer: string;
    sub: string;
  }

  async function staff(
    tenantId: string,
    key: string,
    permissions: InternalPermissionKey[],
    roleKey: string,
  ) {
    const role = await prisma.internalRole.upsert({
      where: { tenantId_key: { tenantId, key: roleKey } },
      update: {},
      create: {
        tenantId,
        key: roleKey,
        displayName: roleKey,
        isSystem: roleKey === 'platform-administrator',
        permissions: {
          create: permissions.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:sc3e1-${key}-${run}`,
        email: `sc3e1-${key}-${run}@example.com`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId,
        internalUserId: user.id,
        roleId: role.id,
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });
    return user.id;
  }

  async function business(
    label: string,
    opts: { complimentary?: boolean; noPaymentMethod?: boolean } = {},
  ): Promise<Business> {
    const tenantId = randomUUID();
    await prisma.tenant.create({
      data: {
        id: tenantId,
        slug: `sc3e1-${label}-${run}`,
        name: `SC3e1 ${label}`,
        status: 'ACTIVE',
      },
    });
    const customer = `fake_cus_${label}_${run}`;
    const sub = `fake_sub_${label}_${run}`;
    const subscription = await prisma.tenantSubscription.create({
      data: opts.complimentary
        ? { subscriberTenantId: tenantId, planVersionId }
        : {
            subscriberTenantId: tenantId,
            planVersionId,
            billingMode: 'BILLED',
            billingProvider: 'fake',
            planPriceId,
            externalCustomerId: customer,
            externalSubscriptionId: sub,
            status: 'ACTIVE',
            recurringPaymentAuthorizedAt: new Date(Date.now() - 40 * DAY),
            currentPeriodStart: new Date(Date.now() - 10 * DAY),
            currentPeriodEnd: new Date(Date.now() + 20 * DAY),
          },
    });
    if (!opts.complimentary) {
      fake.subscriptions.set(sub, {
        externalSubscriptionId: sub,
        externalCustomerId: customer,
        status: 'active',
        livemode: false,
        hasPaymentMethod: !opts.noPaymentMethod,
        paymentMethodSource: opts.noPaymentMethod ? null : 'SUBSCRIPTION',
        cancelAtPeriodEnd: false,
        trialStart: null,
        trialEnd: null,
        latestInvoiceId: null,
        items: [
          {
            externalItemId: `fake_si_${label}_${run}`,
            externalPriceId: `fake_price_${run}`,
            quantity: 1,
          },
        ],
        scheduleId: null,
        hasPendingUpdate: false,
        currentPeriodStart: new Date(Date.now() - 10 * DAY),
        currentPeriodEnd: new Date(Date.now() + 20 * DAY),
      });
    }
    await staff(tenantId, label, MANAGE, 'platform-administrator');
    return {
      key: label,
      tenantId,
      subscriptionId: subscription.id,
      customer,
      sub,
    };
  }

  // A provider invoice of the business (as Stripe would hold it).
  let invoiceSeq = 0;
  function providerInvoice(
    b: Business,
    over: {
      status?: 'paid' | 'open' | 'void' | 'uncollectible' | 'draft';
      amount?: number;
      createdAt?: Date;
      customer?: string;
      subscription?: string;
    } = {},
  ): string {
    const id = `in_${b.key}_${run}_${invoiceSeq++}`;
    fake.setInvoice(
      id,
      over.status ?? 'paid',
      over.subscription ?? b.sub,
      over.customer ?? b.customer,
      {
        amountMinorUnits: over.amount ?? 4900,
        createdAt: over.createdAt ?? new Date(Date.now() - invoiceSeq * 1000),
        billingReason: 'subscription_cycle',
      },
    );
    return id;
  }

  let seq = 0;
  async function deliver(
    b: Business | null,
    type: string,
    data: Partial<FakeEventBody['data']> = {},
    eventId = `evt_${run}_${seq++}`,
  ) {
    const occurred = Math.floor(Date.now() / 1000) + seq++;
    const body: FakeEventBody = {
      id: eventId,
      type,
      created: occurred,
      livemode: false,
      data: b
        ? { subscription: b.sub, customer: b.customer, ...data }
        : { ...data },
    };
    const signed = fake.signEvent(body, new Date(occurred * 1000));
    return lifecycle.recordAndApply(
      fake.verifyEvent({ ...signed, now: new Date(occurred * 1000) }),
    );
  }
  const changed = (b: Business, reference: string) =>
    deliver(b, 'invoice.changed', { reference });
  const rowsOf = (b: Business) =>
    prisma.billingInvoice.findMany({
      where: { subscriptionId: b.subscriptionId },
      orderBy: { issuedAt: 'desc' },
    });
  const list = async (b: Business, cursor?: string) =>
    (
      await asStaff(
        'get',
        b.key,
        b.tenantId,
        `/invoices${cursor ? `?cursor=${cursor}` : ''}`,
      ).expect(200)
    ).body as BillingInvoiceListResponse;
  const document = (
    b: Business,
    invoiceId: string,
    kind: unknown = 'invoice',
    key = b.key,
  ) =>
    asStaff('post', key, b.tenantId, `/invoices/${invoiceId}/document`, {
      kind,
    });

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3e1_history',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    process.env.DATABASE_URL = scratch.url;
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = PLATFORM_SECRET;
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = INTERNAL_SECRET;
    process.env.RATE_LIMIT_ENABLED = '0';
    process.env.SAAS_BILLING_PROVIDER = 'fake';
    process.env.SAAS_BILLING_TRIAL_CLAIM_SECRET = `sc3e1-claims-${randomUUID()}`;
    process.env.PLAN_CHANGE_SWEEP_DISABLED = '1';
    delete process.env.BILLING_ENFORCEMENT_ENABLED;
    delete process.env.BILLING_NOTIFICATIONS_ENABLED;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.init();
    prisma = app.get(PrismaService);
    lifecycle = app.get(BillingLifecycleService);
    fake = app.get(SAAS_BILLING_PROVIDER);

    const grantee = await prisma.platformOperator.create({
      data: {
        externalProvider: 'platform-dev',
        externalSubject: `platform-dev:sc3e1-${run}`,
        email: `sc3e1-${run}@example.test`,
        status: 'ACTIVE',
      },
    });
    await grantPlatformPermissions(prisma, grantee.id);
    const plan = await prisma.subscriptionPlan.create({
      data: { key: `growth-${run}`, name: 'Growth' },
    });
    const version = await prisma.subscriptionPlanVersion.create({
      data: { planId: plan.id, version: 1, moduleKeys: ['crm'] },
    });
    await prisma.subscriptionPlanVersion.update({
      where: { id: version.id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
    planVersionId = version.id;
    const price = await prisma.subscriptionPlanPrice.create({
      data: {
        planId: plan.id,
        interval: 'MONTH',
        currency: 'USD',
        amountMinorUnits: 4900,
      },
    });
    planPriceId = price.id;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = { ...originalEnv };
      await scratch?.drop();
    }
  });

  it("records an invoice from the provider's live read: amounts, period, refunds and credits — and nothing else (no links)", async () => {
    const b = await business('record');
    const id = providerInvoice(b);
    fake.invoiceDetails.set(id, {
      periodStart: new Date('2026-10-01T00:00:00Z'),
      periodEnd: new Date('2026-11-01T00:00:00Z'),
      postPaymentCreditMinorUnits: 1000,
      balanceAppliedMinorUnits: 300,
      prePaymentCreditMinorUnits: 200,
    });
    const outcome = await changed(b, id);
    expect(outcome).toMatchObject({
      status: 'APPLIED',
      outcome: 'INVOICE_RECORDED',
    });
    const [row] = await rowsOf(b);
    expect(row).toMatchObject({
      externalInvoiceId: id,
      status: 'paid',
      currency: 'usd',
      amountPaidMinorUnits: 4900,
      postPaymentCreditMinorUnits: 1000,
    });
    // Never a document link (or any URL) in the record.
    expect(JSON.stringify(row)).not.toMatch(/https?:/);
    const page = await list(b);
    expect(page.nextCursor).toBeNull();
    expect(page.invoices).toHaveLength(1);
    expect(page.invoices[0].number).toMatch(/^FAKE-/);
    expect([{ ...page.invoices[0], number: null }]).toEqual([
      {
        id: row.id,
        number: null,
        status: 'paid',
        reason: 'RENEWAL',
        currency: 'USD',
        totalMinorUnits: 4900,
        amountPaidMinorUnits: 4900,
        amountRemainingMinorUnits: 0,
        refundedOrCreditedMinorUnits: 1000,
        creditAppliedMinorUnits: 500,
        periodStart: '2026-10-01T00:00:00.000Z',
        periodEnd: '2026-11-01T00:00:00.000Z',
        issuedAt: row.issuedAt.toISOString(),
        paidAt: row.paidAt!.toISOString(),
      },
    ]);
  });

  it("a payment event's invoice joins the history too", async () => {
    const b = await business('paid-event');
    const id = providerInvoice(b, { status: 'paid' });
    await deliver(b, 'invoice.paid', {
      reference: id,
      amount: 4900,
      currency: 'usd',
    });
    expect((await rowsOf(b)).map((r) => r.externalInvoiceId)).toEqual([id]);
  });

  it('duplicate and delayed events change nothing; a newer read updates; an older read is never written', async () => {
    const b = await business('delayed');
    const id = providerInvoice(b, { status: 'open' });
    await deliver(b, 'invoice.changed', { reference: id }, `evt_dup_${run}`);
    const duplicate = await deliver(
      b,
      'invoice.changed',
      { reference: id },
      `evt_dup_${run}`,
    );
    expect(duplicate.duplicate).toBe(true);
    expect(await rowsOf(b)).toHaveLength(1);
    // Paid at the provider; a late "finalized" event for the open invoice
    // still records what the provider holds NOW.
    fake.setInvoice(id, 'paid', b.sub, b.customer, { amountMinorUnits: 4900 });
    expect((await changed(b, id)).outcome).toBe('INVOICE_RECORDED');
    expect((await rowsOf(b))[0]).toMatchObject({ status: 'paid' });
    expect((await changed(b, id)).outcome).toBe('INVOICE_UNCHANGED');
    // A read older than the stored one (a slow delivery) is not written.
    const [row] = await rowsOf(b);
    const record = (await fake.retrieveInvoice(id))!.record!;
    const stale = await runSerializable(prisma, (tx) =>
      lifecycle.recordInvoiceHistory(
        tx,
        {
          ...row,
          id: b.subscriptionId,
          billingProvider: 'fake',
          externalSubscriptionId: b.sub,
          externalCustomerId: b.customer,
        },
        { ...record, status: 'open', amountPaidMinorUnits: 0, paidAt: null },
        new Date(row.syncedAt.getTime() - 1000),
        null,
      ),
    );
    expect(stale).toBe('STALE');
    expect((await rowsOf(b))[0]).toMatchObject({ status: 'paid' });
  });

  it('a paid invoice the provider later reports otherwise is reviewed, never overwritten', async () => {
    const b = await business('conflict');
    const id = providerInvoice(b, { status: 'paid' });
    await changed(b, id);
    fake.setInvoice(id, 'open', b.sub, b.customer, { amountMinorUnits: 4900 });
    const outcome = await changed(b, id);
    expect(outcome).toMatchObject({
      status: 'REJECTED',
      outcome: 'INVOICE_HISTORY_CONFLICT',
    });
    expect((await rowsOf(b))[0]).toMatchObject({ status: 'paid' });
    expect(
      await prisma.billingReconciliationCase.count({
        where: {
          subscriptionId: b.subscriptionId,
          kind: 'INVOICE_HISTORY_CONFLICT',
          status: 'OPEN',
        },
      }),
    ).toBe(1);
  });

  it("isolation: an invoice is recorded only for the subscription it belongs to; another business's is never reached", async () => {
    const a = await business('iso-a');
    const b = await business('iso-b');
    const aInvoice = providerInvoice(a);
    await changed(a, aInvoice);
    // An event on B's subscription naming A's invoice: refused, not recorded
    // for B, and A's row untouched.
    const crossed = await changed(b, aInvoice);
    expect(crossed).toMatchObject({ status: 'REJECTED' });
    expect(await rowsOf(b)).toEqual([]);
    // An invoice on B's subscription but another customer: never recorded.
    const foreign = providerInvoice(b, { customer: `fake_cus_other_${run}` });
    expect((await changed(b, foreign)).status).toBe('REJECTED');
    expect(await rowsOf(b)).toEqual([]);
    // A credit-note style event (no subscription) for a customer that is
    // not ours: ignored.
    const strangers = await deliver(null, 'invoice.changed', {
      reference: aInvoice,
      customer: `fake_cus_stranger_${run}`,
    });
    expect(strangers).toMatchObject({ status: 'IGNORED', outcome: 'NOT_OURS' });
    // A credit-note style event for A's own customer: A's invoice re-read.
    const credit = await deliver(null, 'invoice.changed', {
      reference: aInvoice,
      customer: a.customer,
    });
    expect(credit.status).toBe('APPLIED');
    // Lists and documents are each business's own.
    expect((await list(b)).invoices).toEqual([]);
    const [aRow] = await rowsOf(a);
    await document(b, aRow.id).expect(404);
    expect((await list(a)).invoices.map((i) => i.id)).toEqual([aRow.id]);
  });

  it('pagination: newest first, 20 a page, a stable cursor; drafts are not shown; a forged cursor is refused', async () => {
    const b = await business('pages');
    const base = Date.now() - 100 * DAY;
    for (let i = 0; i < 23; i++) {
      const id = providerInvoice(b, { createdAt: new Date(base + i * DAY) });
      await changed(b, id);
    }
    await changed(b, providerInvoice(b, { status: 'draft' }));
    const first = await list(b);
    expect(first.invoices).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(b, first.nextCursor!);
    expect(second.invoices).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    const all = [...first.invoices, ...second.invoices];
    expect(new Set(all.map((i) => i.id)).size).toBe(23);
    const issued = all.map((i) => new Date(i.issuedAt).getTime());
    expect(issued).toEqual([...issued].sort((x, y) => y - x));
    await asStaff(
      'get',
      b.key,
      b.tenantId,
      '/invoices?cursor=not-a-cursor',
    ).expect(400);
    const forged = Buffer.from(
      JSON.stringify({ t: 'yesterday', i: "'; DROP" }),
    ).toString('base64url');
    await asStaff(
      'get',
      b.key,
      b.tenantId,
      `/invoices?cursor=${forged}`,
    ).expect(400);
  });

  it('permissions: billing.view lists and opens documents; without it, nothing; operators read (no documents)', async () => {
    const b = await business('perms');
    const id = providerInvoice(b);
    await changed(b, id);
    const [row] = await rowsOf(b);
    await staff(b.tenantId, `${b.key}-viewer`, VIEW, 'viewer');
    await staff(b.tenantId, `${b.key}-none`, ['locations.view'], 'no-billing');
    await asStaff('get', `${b.key}-viewer`, b.tenantId, '/invoices').expect(
      200,
    );
    await document(b, row.id, 'pdf', `${b.key}-viewer`).expect(200);
    await asStaff(
      'get',
      `${b.key}-viewer`,
      b.tenantId,
      '/payment-method',
    ).expect(200);
    await asStaff('get', `${b.key}-none`, b.tenantId, '/invoices').expect(403);
    await document(b, row.id, 'pdf', `${b.key}-none`).expect(403);
    await asStaff('get', `${b.key}-none`, b.tenantId, '/payment-method').expect(
      403,
    );
    await request(app.getHttpServer())
      .get('/api/v1/admin/billing/invoices')
      .set('X-Tenant-Id', b.tenantId)
      .expect(401);
    const operatorView = (
      await asOperator('get', `/tenants/${b.tenantId}/billing/invoices`).expect(
        200,
      )
    ).body as BillingInvoiceListResponse;
    expect(operatorView.invoices.map((i) => i.id)).toEqual([row.id]);
    await request(app.getHttpServer())
      .get(`/api/v1/platform/tenants/${b.tenantId}/billing/invoices`)
      .expect(401);
    // There is no operator document route.
    await asOperator(
      'post',
      `/tenants/${b.tenantId}/billing/invoices/${row.id}/document`,
    ).expect(404);
  });

  it("document links: resolved live for this request, the provider's own host only, ownership re-checked; audited", async () => {
    const b = await business('docs');
    const id = providerInvoice(b);
    await changed(b, id);
    const [row] = await rowsOf(b);
    const page = await document(b, row.id, 'invoice').expect(200);
    expect(page.body).toEqual({ url: `https://invoice.fake.test/i/${id}` });
    const pdf = await document(b, row.id, 'pdf').expect(200);
    expect(pdf.body).toEqual({
      url: `https://pay.fake.test/invoice/${id}/pdf`,
    });
    expect(
      await prisma.internalAuditEvent.count({
        where: {
          tenantId: b.tenantId,
          action: 'billing.invoice_document_opened',
        },
      }),
    ).toBe(2);
    // Only { kind } with a known kind.
    await document(b, row.id, 'receipt').expect(400);
    await asStaff('post', b.key, b.tenantId, `/invoices/${row.id}/document`, {
      kind: 'pdf',
      url: 'https://evil.test',
    }).expect(400);
    await document(b, 'not-a-uuid').expect(404);
    await document(b, randomUUID()).expect(404);
    // The provider hands back a link on another host: refused.
    fake.invoiceDetails.set(id, {
      invoicePdfUrl: 'https://evil.test/invoice/x/pdf',
    });
    expect(codeOf(await document(b, row.id, 'pdf').expect(409))).toBe(
      'BILLING_DOCUMENT_UNAVAILABLE',
    );
    fake.invoiceDetails.set(id, {
      invoicePdfUrl: 'https://pay.fake.test/elsewhere/x',
    });
    await document(b, row.id, 'pdf').expect(409);
    // The provider now says the invoice is another customer's: refused.
    fake.invoiceDetails.set(id, {
      externalCustomerId: `fake_cus_other_${run}`,
    });
    await document(b, row.id, 'invoice').expect(409);
    fake.invoiceDetails.delete(id);
    // The provider unavailable: 503, nothing audited.
    const audited = await prisma.internalAuditEvent.count({
      where: {
        tenantId: b.tenantId,
        action: 'billing.invoice_document_opened',
      },
    });
    fake.failNext = 'api_connection_error';
    expect(codeOf(await document(b, row.id, 'invoice').expect(503))).toBe(
      'BILLING_UNAVAILABLE',
    );
    expect(
      await prisma.internalAuditEvent.count({
        where: {
          tenantId: b.tenantId,
          action: 'billing.invoice_document_opened',
        },
      }),
    ).toBe(audited);
  });

  it('the payment method: brand, last four and expiry only — never anything else', async () => {
    const b = await business('card');
    const shown = (
      await asStaff('get', b.key, b.tenantId, '/payment-method').expect(200)
    ).body as AdminBillingPaymentMethodResponse;
    expect(shown).toEqual({
      paymentMethod: {
        kind: 'CARD',
        card: {
          brand: 'visa',
          last4: '4242',
          expMonth: 12,
          expYear: 2030,
          expired: false,
        },
      },
    });
    expect(Object.keys(shown.paymentMethod!.card!).sort()).toEqual([
      'brand',
      'expMonth',
      'expYear',
      'expired',
      'last4',
    ]);
    expect(JSON.stringify(shown)).not.toMatch(
      /fake_|cus_|sub_|pm_|fingerprint/,
    );
    fake.paymentMethods.set(b.sub, {
      type: 'card',
      card: { brand: 'mastercard', last4: '4444', expMonth: 1, expYear: 2020 },
    });
    expect(
      (
        (await asStaff('get', b.key, b.tenantId, '/payment-method').expect(200))
          .body as AdminBillingPaymentMethodResponse
      ).paymentMethod,
    ).toMatchObject({ kind: 'CARD', card: { last4: '4444', expired: true } });
    fake.paymentMethods.set(b.sub, { type: 'us_bank_account', card: null });
    expect(
      (await asStaff('get', b.key, b.tenantId, '/payment-method').expect(200))
        .body,
    ).toEqual({ paymentMethod: { kind: 'OTHER', card: null } });
    fake.failNext = 'api_connection_error';
    expect(
      codeOf(
        await asStaff('get', b.key, b.tenantId, '/payment-method').expect(503),
      ),
    ).toBe('BILLING_UNAVAILABLE');

    const none = await business('card-none', { noPaymentMethod: true });
    expect(
      (
        await asStaff('get', none.key, none.tenantId, '/payment-method').expect(
          200,
        )
      ).body,
    ).toEqual({ paymentMethod: { kind: 'NONE', card: null } });
    const founding = await business('card-founding', { complimentary: true });
    expect(
      (
        await asStaff(
          'get',
          founding.key,
          founding.tenantId,
          '/payment-method',
        ).expect(200)
      ).body,
    ).toEqual({ paymentMethod: null });
    expect(
      (
        await asStaff(
          'get',
          founding.key,
          founding.tenantId,
          '/invoices',
        ).expect(200)
      ).body,
    ).toEqual({ invoices: [], nextCursor: null });
  });

  it('the reconciliation sweep backfills invoices whose events never came; an unreadable provider is reviewed', async () => {
    const b = await business('backfill');
    const missed = [providerInvoice(b), providerInvoice(b, { status: 'open' })];
    // Another subscription's invoice in the provider: never recorded here.
    providerInvoice(b, { subscription: `fake_sub_elsewhere_${run}` });
    const result = (await asOperator('post', '/billing/reconcile').expect(200))
      .body as PlatformReconciliationRunResponse;
    expect(result.invoicesRecorded).toBeGreaterThanOrEqual(2);
    expect((await rowsOf(b)).map((r) => r.externalInvoiceId).sort()).toEqual(
      [...missed].sort(),
    );
    // Run again: nothing new.
    const again = (await asOperator('post', '/billing/reconcile').expect(200))
      .body as PlatformReconciliationRunResponse;
    expect(again.invoicesRecorded).toBe(0);
    expect(await rowsOf(b)).toHaveLength(2);
  });
});
