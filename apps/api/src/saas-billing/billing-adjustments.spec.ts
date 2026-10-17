import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  BillingInvoiceListResponse,
  InternalPermissionKey,
  PlatformAdjustableInvoice,
  PlatformAdjustmentListResponse,
  PlatformAdjustmentPreview,
  PlatformAdjustmentView,
  PlatformPermission,
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
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signPlatformDevJwt } from '../platform-auth/infrastructure/platform-dev-jwt';
import {
  BillingAdjustmentsService,
  adjustmentIdempotencyKey,
  requiredApprovals,
} from './application/billing-adjustments.service';
import type {
  FakeEventBody,
  FakeSaasBillingProvider,
} from './provider/fake-saas-billing-provider';
import { SAAS_BILLING_PROVIDER } from './provider/saas-billing-provider';

// SC3e-3 — refunds and credits on CENTERIVO subscription invoices, end to end
// on the real AppModule (fake provider) in a SCRATCH database:
//   * the approval policy: one independent approver under $250 USD; two at
//     $250 or more, for other currencies and for a full annual refund; never
//     the requester; one position per operator; revoked or inactive
//     approvers don't count; requests expire after 72 hours;
//   * financial safety: one open adjustment per invoice (also concurrent);
//     reserved before the provider is called; amounts from the provider's
//     preview, re-checked before execution; never more than remains;
//     confirmed only from the provider (a pending refund is not a success);
//     interrupted and timed-out calls reconciled before anything is re-sent,
//     never re-sent after the window;
//   * refunds and credits made directly at the provider recorded once as
//     external and reviewed — never repeated or reversed;
//   * no access effects; businesses see only their own (read-only); restaurant
//     payments are never touched.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

jest.setTimeout(240_000);

describe('SC3e-3 refunds and credits (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adjustments: BillingAdjustmentsService;
  let fake: FakeSaasBillingProvider;
  const originalEnv = { ...process.env };
  const PLATFORM_SECRET = `sc3e3-platform-${randomUUID()}`;
  const INTERNAL_SECRET = `sc3e3-internal-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  const operators: Record<string, { id: string; email: string }> = {};
  let planVersionId: string;
  let planPriceId: string;

  // --- operators ------------------------------------------------------------------
  async function operator(
    key: string,
    permissions: readonly PlatformPermission[],
  ) {
    const email = `sc3e3-${key}-${run}@example.test`.toLowerCase();
    const row = await prisma.platformOperator.create({
      data: {
        externalProvider: 'platform-dev',
        externalSubject: `platform-dev:sc3e3-${key}-${run}`,
        email,
        status: 'ACTIVE',
      },
    });
    await grantPlatformPermissions(prisma, row.id, permissions);
    operators[key] = { id: row.id, email };
    return row.id;
  }
  const operatorToken = (key: string, signedInSecondsAgo = 0) =>
    signPlatformDevJwt(
      {
        sub: `platform-dev:sc3e3-${key}-${run}`,
        mfa: true,
        iat: Math.floor(Date.now() / 1000) - signedInSecondsAgo,
      },
      PLATFORM_SECRET,
      3600,
    );
  const asOperator = (
    key: string,
    method: 'get' | 'post',
    path: string,
    body?: unknown,
    signedInSecondsAgo = 0,
  ) => {
    const req = request(app.getHttpServer())
      [method](`/api/v1/platform${path}`)
      .set('Authorization', `Bearer ${operatorToken(key, signedInSecondsAgo)}`);
    return body !== undefined ? req.send(body as object) : req;
  };
  const codeOf = (response: { body: unknown }) =>
    (response.body as { code: string }).code;

  // --- businesses and invoices ---------------------------------------------------
  interface Business {
    key: string;
    tenantId: string;
    subscriptionId: string;
    customer: string;
    sub: string;
  }
  const staffToken = (key: string) =>
    signInternalDevJwt(
      {
        sub: `internal-dev:sc3e3-${key}-${run}`,
        email: `sc3e3-${key}-${run}@example.com`,
        name: null,
        email_verified: true,
      },
      INTERNAL_SECRET,
      3600,
    );
  async function owner(tenantId: string, key: string) {
    const permissions: InternalPermissionKey[] = [
      'billing.view',
      'billing.manage',
      'locations.view',
    ];
    const role = await prisma.internalRole.create({
      data: {
        tenantId,
        key: 'platform-administrator',
        displayName: 'Owner',
        isSystem: true,
        permissions: {
          create: permissions.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:sc3e3-${key}-${run}`,
        email: `sc3e3-${key}-${run}@example.com`,
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
  }
  async function business(label: string): Promise<Business> {
    const tenantId = randomUUID();
    await prisma.tenant.create({
      data: {
        id: tenantId,
        slug: `sc3e3-${label}-${run}`,
        name: `SC3e3 ${label}`,
        status: 'ACTIVE',
      },
    });
    const customer = `fake_cus_${label}_${run}`;
    const sub = `fake_sub_${label}_${run}`;
    const subscription = await prisma.tenantSubscription.create({
      data: {
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
    await owner(tenantId, label);
    return {
      key: label,
      tenantId,
      subscriptionId: subscription.id,
      customer,
      sub,
    };
  }

  let invoiceSeq = 0;
  // A paid invoice, at the provider and in our history.
  async function invoice(
    b: Business,
    over: {
      amount?: number;
      currency?: string;
      annual?: boolean;
      taxBasisPoints?: number;
    } = {},
  ): Promise<{ id: string; external: string }> {
    const external = `in_${b.key}_${run}_${invoiceSeq++}`;
    const amount = over.amount ?? 4900;
    const issuedAt = new Date(Date.now() - 5 * DAY);
    const periodStart = new Date(Date.now() - 5 * DAY);
    const periodEnd = new Date(
      periodStart.getTime() + (over.annual ? 365 : 30) * DAY,
    );
    fake.setInvoice(external, 'paid', b.sub, b.customer, {
      amountMinorUnits: amount,
      createdAt: issuedAt,
    });
    fake.invoiceDetails.set(external, {
      periodStart,
      periodEnd,
      ...(over.currency ? { currency: over.currency } : {}),
    });
    if (over.taxBasisPoints) {
      fake.taxBasisPoints.set(external, over.taxBasisPoints);
    }
    const row = await prisma.billingInvoice.create({
      data: {
        subscriptionId: b.subscriptionId,
        provider: 'fake',
        externalInvoiceId: external,
        externalCustomerId: b.customer,
        externalSubscriptionId: b.sub,
        status: 'paid',
        currency: over.currency ?? 'usd',
        totalMinorUnits: amount,
        amountDueMinorUnits: amount,
        amountPaidMinorUnits: amount,
        amountRemainingMinorUnits: 0,
        periodStart,
        periodEnd,
        issuedAt,
        paidAt: issuedAt,
        syncedAt: new Date(),
      },
    });
    return { id: row.id, external };
  }

  const base = (b: Business, inv: { id: string }) =>
    `/tenants/${b.tenantId}/billing/invoices/${inv.id}`;
  const REASON = 'Service outage on 12 October, approved by support lead.';
  const NOTE = 'Checked the outage report and the invoice.';
  const preview = (
    b: Business,
    inv: { id: string },
    body: Record<string, unknown>,
    key = 'requester',
  ) => asOperator(key, 'post', `${base(b, inv)}/adjustments/preview`, body);
  const ask = (
    b: Business,
    inv: { id: string },
    body: Record<string, unknown>,
    key = 'requester',
    signedInSecondsAgo = 0,
  ) =>
    asOperator(
      key,
      'post',
      `${base(b, inv)}/adjustments`,
      { reason: REASON, ...body },
      signedInSecondsAgo,
    );
  async function requested(
    b: Business,
    inv: { id: string },
    body: Record<string, unknown>,
    key = 'requester',
  ): Promise<PlatformAdjustmentView> {
    return (await ask(b, inv, body, key).expect(201))
      .body as PlatformAdjustmentView;
  }
  const decide = (
    id: string,
    key: string,
    step: 'approve' | 'reject' | 'cancel' | 'resolve-not-issued' = 'approve',
    signedInSecondsAgo = 0,
  ) =>
    asOperator(
      key,
      'post',
      `/billing/adjustments/${id}/${step}`,
      { note: NOTE },
      signedInSecondsAgo,
    );
  const rowOf = (id: string) =>
    prisma.billingAdjustment.findUniqueOrThrow({ where: { id } });
  const notesOf = (external: string) =>
    [...fake.creditNotes.values()].filter(
      (note) => note.externalInvoiceId === external,
    );
  const createCalls = (id: string) =>
    fake.calls.filter(
      (c) =>
        c.op === 'createCreditNote' && c.key === adjustmentIdempotencyKey(id),
    ).length;
  const casesOf = async (b: Business) =>
    (
      await prisma.billingReconciliationCase.findMany({
        where: { subscriptionId: b.subscriptionId, status: 'OPEN' },
        select: { kind: true },
        orderBy: { createdAt: 'asc' },
      })
    ).map((c) => c.kind);
  const eventsOf = async (id: string) =>
    (
      await prisma.billingAdjustmentEvent.findMany({
        where: { adjustmentId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { type: true },
      })
    ).map((e) => e.type);

  let seq = 0;
  function deliver(
    b: Business,
    type: string,
    data: Partial<FakeEventBody['data']> = {},
  ) {
    const occurred = Math.floor(Date.now() / 1000) + seq++;
    const body: FakeEventBody = {
      id: `evt_${run}_${seq++}`,
      type,
      created: occurred,
      livemode: false,
      data: { subscription: b.sub, customer: b.customer, ...data },
    };
    const signed = fake.signEvent(body, new Date(occurred * 1000));
    return request(app.getHttpServer())
      .post('/api/v1/billing/webhooks/fake')
      .set('x-billing-signature', signed.signatureHeader)
      .set('content-type', 'application/json')
      .send(signed.rawBody);
  }
  const businessInvoices = async (b: Business) =>
    (
      await request(app.getHttpServer())
        .get('/api/v1/admin/billing/invoices')
        .set('Authorization', `Bearer ${staffToken(b.key)}`)
        .set('X-Tenant-Id', b.tenantId)
        .expect(200)
    ).body as BillingInvoiceListResponse;

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3e3_adjustments',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    process.env.DATABASE_URL = scratch.url;
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = PLATFORM_SECRET;
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = INTERNAL_SECRET;
    process.env.RATE_LIMIT_ENABLED = '0';
    process.env.SAAS_BILLING_PROVIDER = 'fake';
    process.env.SAAS_BILLING_TRIAL_CLAIM_SECRET = `sc3e3-claims-${randomUUID()}`;
    process.env.PLAN_CHANGE_SWEEP_DISABLED = '1';
    process.env.BILLING_CHECKOUT_RETURN_URL =
      'http://localhost:3000/admin/billing';
    delete process.env.BILLING_ENFORCEMENT_ENABLED;
    delete process.env.BILLING_NOTIFICATIONS_ENABLED;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({
      rawBody: true,
    });
    await app.init();
    prisma = app.get(PrismaService);
    adjustments = app.get(BillingAdjustmentsService);
    fake = app.get(SAAS_BILLING_PROVIDER);

    await operator('none', []);
    await operator('requester', ['billing.adjustments.request']);
    // Holds both permissions: may request and approve — never both on one
    // request.
    await operator('both', [
      'billing.adjustments.request',
      'billing.adjustments.approve',
    ]);
    await operator('approverA', ['billing.adjustments.approve']);
    await operator('approverB', ['billing.adjustments.approve']);
    await operator('approverC', ['billing.adjustments.approve']);

    const plan = await prisma.subscriptionPlan.create({
      data: { key: `pro-${run}`, name: 'Pro' },
    });
    const version = await prisma.subscriptionPlanVersion.create({
      data: { planId: plan.id, version: 1, moduleKeys: ['crm', 'marketing'] },
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
        amountMinorUnits: 9900,
      },
    });
    await prisma.subscriptionPlanPrice.update({
      where: { id: price.id },
      data: { externalPriceId: `fake_price_pro_${run}` },
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

  // --- D2: the approval policy ------------------------------------------------------

  it('the policy: one approver under $250 USD; two at $250 or more, for other currencies and for a full annual refund', () => {
    expect(requiredApprovals('usd', 24_999, false)).toBe(1);
    expect(requiredApprovals('usd', 25_000, false)).toBe(2);
    expect(requiredApprovals('eur', 100, false)).toBe(2);
    expect(requiredApprovals('usd', 100, true)).toBe(2);
  });

  it("previews with the provider's own amounts and tax, and the approvals the request will need", async () => {
    const b = await business('preview');
    const small = await invoice(b, { amount: 9900, taxBasisPoints: 1000 });
    const shown = (
      await asOperator(
        'requester',
        'get',
        `${base(b, small)}/adjustable`,
      ).expect(200)
    ).body as PlatformAdjustableInvoice;
    expect(shown).toMatchObject({
      currency: 'USD',
      amountPaidMinorUnits: 9900,
      adjustedMinorUnits: 0,
      remainingMinorUnits: 9900,
      refundable: true,
      annual: false,
    });
    expect(shown.lines).toHaveLength(1);
    const partial = (
      await preview(b, small, {
        kind: 'REFUND',
        scope: 'PARTIAL',
        lineId: shown.lines[0].lineId,
        amountMinorUnits: 5000,
      }).expect(200)
    ).body as PlatformAdjustmentPreview;
    // Stripe adds the tax (10%): nothing computed here.
    expect(partial).toMatchObject({
      totalMinorUnits: 5500,
      taxMinorUnits: 500,
      remainingAfterMinorUnits: 4400,
      requiredApprovals: 1,
      annualFullRefund: false,
    });

    const large = await invoice(b, { amount: 30_000 });
    expect(
      (
        (await preview(b, large, { kind: 'CREDIT', scope: 'FULL' }).expect(200))
          .body as PlatformAdjustmentPreview
      ).requiredApprovals,
    ).toBe(2);

    const euro = await invoice(b, { amount: 1000, currency: 'eur' });
    expect(
      (await preview(b, euro, { kind: 'CREDIT', scope: 'FULL' }).expect(200))
        .body as PlatformAdjustmentPreview,
    ).toMatchObject({ currency: 'EUR', requiredApprovals: 2 });

    const annual = await invoice(b, { amount: 12_000, annual: true });
    const annualLine = (
      (await asOperator('requester', 'get', `${base(b, annual)}/adjustable`))
        .body as PlatformAdjustableInvoice
    ).lines[0].lineId;
    expect(
      (await preview(b, annual, { kind: 'REFUND', scope: 'FULL' }).expect(200))
        .body as PlatformAdjustmentPreview,
    ).toMatchObject({ annualFullRefund: true, requiredApprovals: 2 });
    // A partial refund, or a full CREDIT, of an annual period: the amount rule.
    expect(
      (
        (
          await preview(b, annual, {
            kind: 'REFUND',
            scope: 'PARTIAL',
            lineId: annualLine,
            amountMinorUnits: 1000,
          }).expect(200)
        ).body as PlatformAdjustmentPreview
      ).requiredApprovals,
    ).toBe(1);
    expect(
      (await preview(b, annual, { kind: 'CREDIT', scope: 'FULL' }).expect(200))
        .body as PlatformAdjustmentPreview,
    ).toMatchObject({ annualFullRefund: false, requiredApprovals: 1 });
    // Nothing recorded or issued by a preview.
    expect(
      await prisma.billingAdjustment.count({
        where: { subscriptionId: b.subscriptionId },
      }),
    ).toBe(0);
    expect(fake.calls.filter((c) => c.op === 'createCreditNote')).toEqual([]);
  });

  it('requests need billing.adjustments.request, a recent sign-in and a written reason', async () => {
    const b = await business('gate');
    const inv = await invoice(b);
    const body = { kind: 'CREDIT', scope: 'FULL' };
    expect(codeOf(await ask(b, inv, body, 'none').expect(403))).toBe(
      'PLATFORM_PERMISSION_REQUIRED',
    );
    expect(codeOf(await ask(b, inv, body, 'approverA').expect(403))).toBe(
      'PLATFORM_PERMISSION_REQUIRED',
    );
    expect(codeOf(await preview(b, inv, body, 'none').expect(403))).toBe(
      'PLATFORM_PERMISSION_REQUIRED',
    );
    expect(codeOf(await ask(b, inv, body, 'requester', 3600).expect(401))).toBe(
      'REAUTHENTICATION_REQUIRED',
    );
    await asOperator('requester', 'post', `${base(b, inv)}/adjustments`, {
      ...body,
      reason: 'short',
    }).expect(400);
    await asOperator('requester', 'post', `${base(b, inv)}/adjustments`, {
      ...body,
      reason: REASON,
      totalMinorUnits: 1,
    }).expect(400);
    await asOperator('requester', 'post', `${base(b, inv)}/adjustments`, {
      kind: 'REFUND',
      scope: 'PARTIAL',
      lineId: 'il_x',
      amountMinorUnits: 0,
      reason: REASON,
    }).expect(400);
    expect(
      await prisma.billingAdjustment.count({
        where: { subscriptionId: b.subscriptionId },
      }),
    ).toBe(0);
  });

  it('one approver under $250: never the requester (even holding both permissions); a full refund is issued, confirmed and shown', async () => {
    const b = await business('single');
    const inv = await invoice(b, { amount: 9900 });
    const before = await prisma.tenantSubscription.findUniqueOrThrow({
      where: { id: b.subscriptionId },
    });
    const adjustment = await requested(
      b,
      inv,
      { kind: 'REFUND', scope: 'FULL' },
      'both',
    );
    expect(adjustment).toMatchObject({
      status: 'PENDING_APPROVAL',
      origin: 'CENTERIVO',
      kind: 'REFUND',
      totalMinorUnits: 9900,
      requiredApprovals: 1,
      reason: REASON,
      requestedBy: { email: operators.both.email },
    });
    expect(
      new Date(adjustment.expiresAt!).getTime() - Date.now(),
    ).toBeGreaterThan(71 * HOUR);
    // The requester can't approve its own request.
    expect(codeOf(await decide(adjustment.id, 'both').expect(409))).toBe(
      'BILLING_ADJUSTMENT_OWN_REQUEST',
    );
    // Approval needs billing.adjustments.approve and a recent sign-in.
    expect(codeOf(await decide(adjustment.id, 'requester').expect(403))).toBe(
      'PLATFORM_PERMISSION_REQUIRED',
    );
    expect(
      codeOf(
        await decide(adjustment.id, 'approverA', 'approve', 3600).expect(401),
      ),
    ).toBe('REAUTHENTICATION_REQUIRED');
    await asOperator(
      'approverA',
      'post',
      `/billing/adjustments/${adjustment.id}/approve`,
      { note: 'ok' },
    ).expect(400);
    expect(fake.calls.filter((c) => c.op === 'createCreditNote')).toHaveLength(
      0,
    );

    const done = (await decide(adjustment.id, 'approverA').expect(200))
      .body as PlatformAdjustmentView;
    expect(done.status).toBe('SUCCEEDED');
    expect(
      done.decisions.map((d) => [d.decision, d.note, d.operator.email]),
    ).toEqual([['APPROVED', NOTE, operators.approverA.email]]);
    const notes = notesOf(inv.external);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      totalMinorUnits: 9900,
      centerivoAdjustmentId: adjustment.id,
      key: adjustmentIdempotencyKey(adjustment.id),
    });
    expect(notes[0].refunds).toHaveLength(1);
    const row = await rowOf(adjustment.id);
    expect(row.externalCreditNoteId).toBe(notes[0].externalCreditNoteId);
    expect(row.externalRefundId).toBe(notes[0].refunds[0].externalRefundId);
    expect(await eventsOf(adjustment.id)).toEqual([
      'REQUESTED',
      'APPROVED',
      'EXECUTING',
      'CREDIT_NOTE_REQUESTED',
      'SUCCEEDED',
    ]);

    // D5 — no access effects: the subscription, its plan and status, and
    // the business are untouched; no cancellation was sent.
    const after = await prisma.tenantSubscription.findUniqueOrThrow({
      where: { id: b.subscriptionId },
    });
    expect({
      status: after.status,
      planVersionId: after.planVersionId,
      cancelAtPeriodEnd: after.cancelAtPeriodEnd,
      billingMode: after.billingMode,
    }).toEqual({
      status: before.status,
      planVersionId: before.planVersionId,
      cancelAtPeriodEnd: before.cancelAtPeriodEnd,
      billingMode: before.billingMode,
    });
    expect(
      (await prisma.tenant.findUniqueOrThrow({ where: { id: b.tenantId } }))
        .status,
    ).toBe('ACTIVE');
    expect(
      fake.calls.filter((c) =>
        ['setCancelAtPeriodEnd', 'cancelSubscription', 'changePlan'].includes(
          c.op,
        ),
      ),
    ).toEqual([]);

    // D6 — the business sees it as a completed refund (never who approved).
    const page = await businessInvoices(b);
    const shown = page.invoices.find((i) => i.id === inv.id)!;
    expect(
      shown.adjustments.map(({ at, ...rest }) => ({
        ...rest,
        dated: !Number.isNaN(Date.parse(at)),
      })),
    ).toEqual([
      {
        kind: 'REFUND',
        status: 'COMPLETED',
        currency: 'USD',
        totalMinorUnits: 9900,
        dated: true,
      },
    ]);
    expect(JSON.stringify(page)).not.toContain(operators.approverA.email);
    // Audited.
    expect(
      (
        await prisma.platformAuditEvent.findMany({
          where: {
            targetId: b.tenantId,
            action: { startsWith: 'platform.billing.adjustment' },
          },
          select: { action: true },
        })
      ).map((e) => e.action),
    ).toEqual(
      expect.arrayContaining([
        'platform.billing.adjustment_requested',
        'platform.billing.adjustment_decided',
        'platform.billing.adjustment_settled',
      ]),
    );
  });

  it('two DISTINCT approvers at $250 or more: one operator fills one position; the second executes it', async () => {
    const b = await business('double');
    const inv = await invoice(b, { amount: 30_000 });
    const adjustment = await requested(b, inv, {
      kind: 'CREDIT',
      scope: 'FULL',
    });
    expect(adjustment.requiredApprovals).toBe(2);
    expect(
      (
        (await decide(adjustment.id, 'approverA').expect(200))
          .body as PlatformAdjustmentView
      ).status,
    ).toBe('PENDING_APPROVAL');
    expect(codeOf(await decide(adjustment.id, 'approverA').expect(409))).toBe(
      'BILLING_ADJUSTMENT_ALREADY_DECIDED',
    );
    expect(notesOf(inv.external)).toHaveLength(0);
    const done = (await decide(adjustment.id, 'approverB').expect(200))
      .body as PlatformAdjustmentView;
    expect(done.status).toBe('SUCCEEDED');
    expect(done.decisions.map((d) => d.operator.email)).toEqual([
      operators.approverA.email,
      operators.approverB.email,
    ]);
    const [note] = notesOf(inv.external);
    // A credit toward future invoices: no refund to the payment method.
    expect(note).toMatchObject({ totalMinorUnits: 30_000, refunds: [] });
    expect(
      (await businessInvoices(b)).invoices.find((i) => i.id === inv.id)!
        .adjustments,
    ).toEqual([
      expect.objectContaining({ kind: 'CREDIT', status: 'COMPLETED' }),
    ]);
  });

  it('splitting never avoids the second approver: the threshold counts what was already adjusted on the invoice', async () => {
    const b = await business('split');
    const inv = await invoice(b, { amount: 48_000 });
    const part = {
      kind: 'REFUND',
      scope: 'PARTIAL',
      lineId: `il_${inv.external}`,
      amountMinorUnits: 24_000,
    };
    const first = await requested(b, inv, part);
    expect(first.requiredApprovals).toBe(1);
    await decide(first.id, 'approverA').expect(200);
    expect((await rowOf(first.id)).status).toBe('SUCCEEDED');
    const second = await requested(b, inv, part);
    expect(second.requiredApprovals).toBe(2);
    expect(
      (
        (await decide(second.id, 'approverA').expect(200))
          .body as PlatformAdjustmentView
      ).status,
    ).toBe('PENDING_APPROVAL');
    // The database refuses carrying it out with too few approvals, too.
    await expect(
      prisma.billingAdjustment.update({
        where: { id: second.id },
        data: { status: 'EXECUTING', executionStartedAt: new Date() },
      }),
    ).rejects.toThrow();
    expect(notesOf(inv.external)).toHaveLength(1);
  });

  it('a credit note of ours issued for an adjustment closed without one is reviewed, never ignored', async () => {
    const b = await business('late-closed');
    const inv = await invoice(b, { amount: 9900 });
    const adjustment = await requested(
      b,
      inv,
      { kind: 'CREDIT', scope: 'FULL' },
      'both',
    );
    fake.failOp = { op: 'createCreditNote', code: 'api_connection_error' };
    await decide(adjustment.id, 'approverA').expect(200);
    await adjustments.sweep(new Date(Date.now() + 2 * HOUR));
    // The requester never resolves its own (even holding approve).
    expect(
      codeOf(
        await decide(adjustment.id, 'both', 'resolve-not-issued').expect(409),
      ),
    ).toBe('BILLING_ADJUSTMENT_OWN_REQUEST');
    await decide(adjustment.id, 'approverB', 'resolve-not-issued').expect(200);
    expect((await rowOf(adjustment.id)).status).toBe('FAILED');
    // The provider issues it after all.
    await fake.createCreditNote({
      idempotencyKey: adjustmentIdempotencyKey(adjustment.id),
      adjustmentId: adjustment.id,
      note: {
        externalInvoiceId: inv.external,
        kind: 'CREDIT',
        lines: [
          { externalLineId: `il_${inv.external}`, amountMinorUnits: 9900 },
        ],
      },
      totalMinorUnits: 9900,
    });
    await adjustments.reconcileInvoice(inv.id);
    expect((await rowOf(adjustment.id)).status).toBe('FAILED');
    expect(await casesOf(b)).toContain('BILLING_ADJUSTMENT_MISMATCH');
  });

  it('a full annual refund needs two approvers whatever the amount; a rejection ends it', async () => {
    const b = await business('annual');
    const inv = await invoice(b, { amount: 12_000, annual: true });
    const adjustment = await requested(b, inv, {
      kind: 'REFUND',
      scope: 'FULL',
    });
    expect(adjustment).toMatchObject({
      annualFullRefund: true,
      requiredApprovals: 2,
    });
    await decide(adjustment.id, 'approverA').expect(200);
    const rejected = (
      await decide(adjustment.id, 'approverB', 'reject').expect(200)
    ).body as PlatformAdjustmentView;
    expect(rejected.status).toBe('REJECTED');
    expect(codeOf(await decide(adjustment.id, 'approverC').expect(409))).toBe(
      'BILLING_ADJUSTMENT_NOT_PENDING',
    );
    expect(notesOf(inv.external)).toHaveLength(0);
    // A rejected request no longer blocks a new one.
    await requested(b, inv, { kind: 'CREDIT', scope: 'FULL' });
  });

  it('an approval stops counting when the approver loses the permission or is disabled', async () => {
    const b = await business('revoked');
    const inv = await invoice(b, { amount: 30_000 });
    const adjustment = await requested(b, inv, {
      kind: 'CREDIT',
      scope: 'FULL',
    });
    const temp = await operator('temp', ['billing.adjustments.approve']);
    await decide(adjustment.id, 'temp').expect(200);
    await prisma.platformOperatorPermission.updateMany({
      where: { operatorId: temp, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'Left the billing team.' },
    });
    // The revoked operator can't act any more.
    expect(
      codeOf(await decide(adjustment.id, 'temp', 'reject').expect(403)),
    ).toBe('PLATFORM_PERMISSION_REQUIRED');
    // A second approval: only one still counts — not executed.
    expect(
      (
        (await decide(adjustment.id, 'approverA').expect(200))
          .body as PlatformAdjustmentView
      ).status,
    ).toBe('PENDING_APPROVAL');
    expect(notesOf(inv.external)).toHaveLength(0);

    const gone = await operator('gone', ['billing.adjustments.approve']);
    await decide(adjustment.id, 'gone').expect(200);
    expect((await rowOf(adjustment.id)).status).toBe('SUCCEEDED');
    expect(notesOf(inv.external)).toHaveLength(1);
    void gone;
  });

  it('a disabled approver cannot decide, and its earlier approval does not count', async () => {
    const b = await business('disabled');
    const inv = await invoice(b, { amount: 30_000 });
    const adjustment = await requested(b, inv, {
      kind: 'CREDIT',
      scope: 'FULL',
    });
    const off = await operator('off', ['billing.adjustments.approve']);
    await decide(adjustment.id, 'off').expect(200);
    await prisma.platformOperator.update({
      where: { id: off },
      data: { status: 'DISABLED' },
    });
    const refused = await decide(adjustment.id, 'off', 'reject');
    expect(refused.status).toBeGreaterThanOrEqual(401);
    expect(refused.status).toBeLessThan(404);
    await decide(adjustment.id, 'approverA').expect(200);
    expect((await rowOf(adjustment.id)).status).toBe('PENDING_APPROVAL');
    expect(notesOf(inv.external)).toHaveLength(0);
  });

  // --- D3: duplicate and financial safety -------------------------------------------

  it('one open adjustment per invoice — also for concurrent requests', async () => {
    const b = await business('concurrent');
    const inv = await invoice(b);
    const results = await Promise.all([
      ask(b, inv, { kind: 'CREDIT', scope: 'FULL' }),
      ask(b, inv, { kind: 'REFUND', scope: 'FULL' }, 'both'),
      ask(b, inv, { kind: 'CREDIT', scope: 'FULL' }, 'both'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    for (const refused of results.filter((r) => r.status === 409)) {
      expect(codeOf(refused)).toBe('BILLING_ADJUSTMENT_IN_PROGRESS');
    }
    expect(
      await prisma.billingAdjustment.count({ where: { invoiceId: inv.id } }),
    ).toBe(1);
  });

  it('concurrent final approvals issue exactly one credit note', async () => {
    const b = await business('race');
    const inv = await invoice(b, { amount: 30_000 });
    const adjustment = await requested(b, inv, {
      kind: 'REFUND',
      scope: 'FULL',
    });
    await decide(adjustment.id, 'approverA').expect(200);
    const results = await Promise.all([
      decide(adjustment.id, 'approverB'),
      decide(adjustment.id, 'approverC'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(notesOf(inv.external)).toHaveLength(1);
    expect(createCalls(adjustment.id)).toBe(1);
    expect((await rowOf(adjustment.id)).status).toBe('SUCCEEDED');
  });

  it('never more than remains: partial line amounts, earlier credits and refunds made outside CENTERIVO', async () => {
    const b = await business('limits');
    const inv = await invoice(b, { amount: 4900 });
    const line = (
      (await asOperator('requester', 'get', `${base(b, inv)}/adjustable`))
        .body as PlatformAdjustableInvoice
    ).lines[0].lineId;
    const partial = (amount: number, kind = 'CREDIT') => ({
      kind,
      scope: 'PARTIAL',
      lineId: line,
      amountMinorUnits: amount,
    });
    expect(codeOf(await preview(b, inv, partial(5000)).expect(409))).toBe(
      'BILLING_ADJUSTMENT_NOT_ELIGIBLE',
    );
    expect(
      codeOf(
        await preview(b, inv, { ...partial(100), lineId: 'il_other' }).expect(
          409,
        ),
      ),
    ).toBe('BILLING_ADJUSTMENT_NOT_ELIGIBLE');
    const first = await requested(b, inv, partial(3000));
    await decide(first.id, 'approverA').expect(200);
    expect((await rowOf(first.id)).status).toBe('SUCCEEDED');
    // 1900 remains.
    expect(codeOf(await ask(b, inv, partial(2000)).expect(409))).toBe(
      'BILLING_ADJUSTMENT_EXCEEDS_REMAINING',
    );
    expect(
      codeOf(await ask(b, inv, { kind: 'REFUND', scope: 'FULL' }).expect(409)),
    ).toBe('BILLING_ADJUSTMENT_NOT_ELIGIBLE');
    // A refund made directly at the provider counts too.
    fake.externalRefund(inv.external, 1000);
    const shown = (
      await asOperator('requester', 'get', `${base(b, inv)}/adjustable`).expect(
        200,
      )
    ).body as PlatformAdjustableInvoice;
    expect(shown).toMatchObject({
      adjustedMinorUnits: 4000,
      remainingMinorUnits: 900,
    });
    expect(codeOf(await ask(b, inv, partial(1000)).expect(409))).toBe(
      'BILLING_ADJUSTMENT_EXCEEDS_REMAINING',
    );
    await requested(b, inv, partial(900, 'REFUND'));
  });

  it('only a paid invoice of THIS business, matching our records', async () => {
    const a = await business('own-a');
    const other = await business('own-b');
    const inv = await invoice(other);
    // Another business's invoice through this business's path.
    await preview(a, inv, { kind: 'CREDIT', scope: 'FULL' }).expect(404);
    await ask(a, inv, { kind: 'CREDIT', scope: 'FULL' }).expect(404);
    await asOperator('requester', 'get', `${base(a, inv)}/adjustable`).expect(
      404,
    );
    // The provider's invoice no longer matches what we recorded.
    const moved = await invoice(a);
    fake.setInvoice(moved.external, 'paid', 'fake_sub_elsewhere', a.customer, {
      amountMinorUnits: 4900,
    });
    expect(
      codeOf(
        await preview(a, moved, { kind: 'CREDIT', scope: 'FULL' }).expect(409),
      ),
    ).toBe('BILLING_ADJUSTMENT_NOT_ELIGIBLE');
    // Not (or no longer) paid at the provider.
    const open = await invoice(a);
    fake.setInvoice(open.external, 'open', a.sub, a.customer, {
      amountMinorUnits: 4900,
    });
    expect(
      codeOf(
        await preview(a, open, { kind: 'REFUND', scope: 'FULL' }).expect(409),
      ),
    ).toBe('BILLING_ADJUSTMENT_NOT_ELIGIBLE');
  });

  it("re-checks the provider's preview before execution: a changed amount or tax issues nothing", async () => {
    const b = await business('changed');
    const inv = await invoice(b, { amount: 9900, taxBasisPoints: 1000 });
    const adjustment = await requested(b, inv, {
      kind: 'REFUND',
      scope: 'PARTIAL',
      lineId: `il_${inv.external}`,
      amountMinorUnits: 5000,
    });
    expect(adjustment).toMatchObject({
      totalMinorUnits: 5500,
      taxMinorUnits: 500,
    });
    // The provider's tax changed after the request was approved.
    fake.taxBasisPoints.set(inv.external, 500);
    const done = (await decide(adjustment.id, 'approverA').expect(200))
      .body as PlatformAdjustmentView;
    expect(done).toMatchObject({
      status: 'FAILED',
      failureCode: 'PREVIEW_CHANGED',
    });
    expect(notesOf(inv.external)).toHaveLength(0);
    expect(createCalls(adjustment.id)).toBe(0);
  });

  it('a pending refund is not a success: SUBMITTED until the provider confirms it; a failed refund is reviewed', async () => {
    const b = await business('pending');
    const inv = await invoice(b, { amount: 9900 });
    fake.nextRefundStatus = 'pending';
    const adjustment = await requested(b, inv, {
      kind: 'REFUND',
      scope: 'FULL',
    });
    const view = (await decide(adjustment.id, 'approverA').expect(200))
      .body as PlatformAdjustmentView;
    fake.nextRefundStatus = 'succeeded';
    expect(view.status).toBe('SUBMITTED');
    // The business sees it as pending.
    expect(
      (await businessInvoices(b)).invoices.find((i) => i.id === inv.id)!
        .adjustments,
    ).toEqual([expect.objectContaining({ status: 'PENDING' })]);
    // The provider confirms it (a signed refund event).
    const refundId = (await rowOf(adjustment.id)).externalRefundId!;
    fake.refunds.get(refundId)!.status = 'succeeded';
    await deliver(b, 'refund.changed', {
      reference: `pi_${inv.external}`,
    }).expect(200);
    expect((await rowOf(adjustment.id)).status).toBe('SUCCEEDED');
    expect(createCalls(adjustment.id)).toBe(1);

    const failing = await invoice(b, { amount: 9900 });
    fake.nextRefundStatus = 'pending';
    const second = await requested(b, failing, {
      kind: 'REFUND',
      scope: 'FULL',
    });
    await decide(second.id, 'approverA').expect(200);
    fake.nextRefundStatus = 'succeeded';
    fake.refunds.get((await rowOf(second.id)).externalRefundId!)!.status =
      'failed';
    await adjustments.sweep();
    expect(await rowOf(second.id)).toMatchObject({
      status: 'REVIEW',
      failureCode: 'REFUND_FAILED',
    });
    expect(await casesOf(b)).toContain('BILLING_ADJUSTMENT_REFUND_FAILED');
    // Never re-sent.
    expect(createCalls(second.id)).toBe(1);
  });

  it('a timeout after the provider issued it (late success): reconciled from the provider, never issued twice', async () => {
    const b = await business('late');
    const inv = await invoice(b, { amount: 9900 });
    const adjustment = await requested(b, inv, {
      kind: 'REFUND',
      scope: 'FULL',
    });
    fake.failAfterCreditNote = true;
    const view = (await decide(adjustment.id, 'approverA').expect(200))
      .body as PlatformAdjustmentView;
    // Submitted is not succeeded: uncertain until the provider is read.
    expect(view.status).toBe('EXECUTING');
    expect(await eventsOf(adjustment.id)).toContain('SUBMIT_UNCERTAIN');
    // The invoice event confirms it (our credit note found by its id).
    await deliver(b, 'invoice.changed', { reference: inv.external }).expect(
      200,
    );
    expect((await rowOf(adjustment.id)).status).toBe('SUCCEEDED');
    await adjustments.sweep();
    expect(notesOf(inv.external)).toHaveLength(1);
    expect(createCalls(adjustment.id)).toBe(1);
    // Not recorded as an external adjustment either.
    expect(
      await prisma.billingAdjustment.count({
        where: { invoiceId: inv.id, origin: 'EXTERNAL' },
      }),
    ).toBe(0);
  });

  it('an interrupted call (nothing issued): re-sent with the same key within the window; after it, reviewed — never blindly retried', async () => {
    const b = await business('interrupted');
    const inv = await invoice(b, { amount: 9900 });
    const adjustment = await requested(b, inv, {
      kind: 'CREDIT',
      scope: 'FULL',
    });
    fake.failOp = { op: 'createCreditNote', code: 'api_connection_error' };
    await decide(adjustment.id, 'approverA').expect(200);
    expect((await rowOf(adjustment.id)).status).toBe('EXECUTING');
    expect(notesOf(inv.external)).toHaveLength(0);
    // Within the window: the sweep reads the provider first, then re-sends.
    await adjustments.sweep();
    expect((await rowOf(adjustment.id)).status).toBe('SUCCEEDED');
    expect(notesOf(inv.external)).toHaveLength(1);
    expect(createCalls(adjustment.id)).toBe(2);

    const later = await invoice(b, { amount: 9900 });
    const second = await requested(b, later, {
      kind: 'CREDIT',
      scope: 'FULL',
    });
    fake.failOp = { op: 'createCreditNote', code: 'api_connection_error' };
    await decide(second.id, 'approverA').expect(200);
    // Past the window: reviewed, not re-sent.
    await adjustments.sweep(new Date(Date.now() + 2 * HOUR));
    expect(await rowOf(second.id)).toMatchObject({
      status: 'REVIEW',
      failureCode: 'UNCERTAIN',
    });
    expect(createCalls(second.id)).toBe(1);
    expect(await casesOf(b)).toContain('BILLING_ADJUSTMENT_UNCERTAIN');
    // Resolved as not issued only after the provider is read again
    // (approve permission, a note).
    await decide(second.id, 'requester', 'resolve-not-issued').expect(403);
    const resolved = (
      await decide(second.id, 'approverB', 'resolve-not-issued').expect(200)
    ).body as PlatformAdjustmentView;
    expect(resolved).toMatchObject({
      status: 'FAILED',
      failureCode: 'NOT_ISSUED',
    });
    expect(resolved.events.at(-1)).toMatchObject({
      type: 'FAILED',
      note: NOTE,
      actorEmail: operators.approverB.email,
    });
    expect(notesOf(later.external)).toHaveLength(0);
  });

  it('a reviewed adjustment whose credit note DID issue is confirmed, not closed as not issued', async () => {
    const b = await business('review-found');
    const inv = await invoice(b, { amount: 9900 });
    const adjustment = await requested(b, inv, {
      kind: 'CREDIT',
      scope: 'FULL',
    });
    fake.failOp = { op: 'createCreditNote', code: 'api_connection_error' };
    await decide(adjustment.id, 'approverA').expect(200);
    await adjustments.sweep(new Date(Date.now() + 2 * HOUR));
    expect((await rowOf(adjustment.id)).status).toBe('REVIEW');
    // Issued at the provider after all (late).
    await fake.createCreditNote({
      idempotencyKey: adjustmentIdempotencyKey(adjustment.id),
      adjustmentId: adjustment.id,
      note: {
        externalInvoiceId: inv.external,
        kind: 'CREDIT',
        lines: [
          { externalLineId: `il_${inv.external}`, amountMinorUnits: 9900 },
        ],
      },
      totalMinorUnits: 9900,
    });
    const view = (
      await decide(adjustment.id, 'approverB', 'resolve-not-issued').expect(200)
    ).body as PlatformAdjustmentView;
    expect(view.status).toBe('SUCCEEDED');
  });

  it('requests expire after 72 hours; only the requester withdraws one', async () => {
    const b = await business('expiry');
    const inv = await invoice(b);
    const adjustment = await requested(b, inv, {
      kind: 'CREDIT',
      scope: 'FULL',
    });
    expect(
      codeOf(await decide(adjustment.id, 'approverA', 'cancel').expect(403)),
    ).toBe('PLATFORM_PERMISSION_REQUIRED');
    expect(
      codeOf(await decide(adjustment.id, 'both', 'cancel').expect(409)),
    ).toBe('BILLING_ADJUSTMENT_NOT_PENDING');
    const withdrawn = (
      await decide(adjustment.id, 'requester', 'cancel').expect(200)
    ).body as PlatformAdjustmentView;
    expect(withdrawn.status).toBe('CANCELED');
    expect(withdrawn.events.at(-1)).toMatchObject({
      type: 'CANCELED',
      note: NOTE,
    });

    const again = await requested(b, inv, { kind: 'CREDIT', scope: 'FULL' });
    expect(
      (await adjustments.sweep(new Date(Date.now() + 73 * HOUR))).expired,
    ).toBeGreaterThanOrEqual(1);
    expect((await rowOf(again.id)).status).toBe('EXPIRED');
    expect(codeOf(await decide(again.id, 'approverA').expect(409))).toBe(
      'BILLING_ADJUSTMENT_NOT_PENDING',
    );
    // Approving a request past its expiry (before the sweep) is refused.
    const third = await requested(b, inv, { kind: 'CREDIT', scope: 'FULL' });
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "BillingAdjustment" DISABLE TRIGGER "BillingAdjustment_guard"`,
    );
    try {
      await prisma.billingAdjustment.update({
        where: { id: third.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "BillingAdjustment" ENABLE TRIGGER "BillingAdjustment_guard"`,
      );
    }
    expect(codeOf(await decide(third.id, 'approverA').expect(409))).toBe(
      'BILLING_ADJUSTMENT_EXPIRED',
    );
    expect((await rowOf(third.id)).status).toBe('EXPIRED');
    expect(notesOf(inv.external)).toHaveLength(0);
  });

  // --- D4: external adjustments -------------------------------------------------------

  it('refunds and credits made directly at the provider are recorded once as external and reviewed — never repeated or reversed', async () => {
    const b = await business('external');
    const inv = await invoice(b, { amount: 9900 });
    const noteId = fake.externalCreditNote(inv.external, 'CREDIT', 2000);
    // Duplicate deliveries of the same events.
    await deliver(b, 'invoice.changed', { reference: inv.external }).expect(
      200,
    );
    await deliver(b, 'invoice.changed', { reference: inv.external }).expect(
      200,
    );
    const refundId = fake.externalRefund(inv.external, 1500);
    for (let i = 0; i < 2; i++) {
      await deliver(b, 'refund.changed', {
        reference: `pi_${inv.external}`,
      }).expect(200);
    }
    // And the reconciliation backstop.
    await adjustments.reconcileInvoice(inv.id);
    const rows = await prisma.billingAdjustment.findMany({
      where: { invoiceId: inv.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(
      rows.map((r) => ({
        origin: r.origin,
        kind: r.kind,
        status: r.status,
        total: r.totalMinorUnits,
        note: r.externalCreditNoteId,
        refund: r.externalRefundId,
        requestedBy: r.requestedByOperatorId,
      })),
    ).toEqual([
      {
        origin: 'EXTERNAL',
        kind: 'CREDIT',
        status: 'RECORDED',
        total: 2000,
        note: noteId,
        refund: null,
        requestedBy: null,
      },
      {
        origin: 'EXTERNAL',
        kind: 'REFUND',
        status: 'RECORDED',
        total: 1500,
        note: null,
        refund: refundId,
        requestedBy: null,
      },
    ]);
    // Reviewed: one open case for the business (each adjustment is listed).
    expect(
      (await casesOf(b)).filter((k) => k === 'EXTERNAL_BILLING_ADJUSTMENT'),
    ).toHaveLength(1);
    expect(
      fake.calls.filter(
        (c) => c.op === 'createCreditNote' && c.key.includes(inv.external),
      ),
    ).toEqual([]);
    // Not approvable (never treated as a CENTERIVO request).
    expect(codeOf(await decide(rows[0].id, 'approverA').expect(409))).toBe(
      'BILLING_ADJUSTMENT_NOT_PENDING',
    );
    // They reduce what remains, and the business sees them as completed.
    expect(
      (
        (await asOperator('requester', 'get', `${base(b, inv)}/adjustable`))
          .body as PlatformAdjustableInvoice
      ).remainingMinorUnits,
    ).toBe(6400);
    expect(
      (await businessInvoices(b)).invoices
        .find((i) => i.id === inv.id)!
        .adjustments.map((a) => `${a.kind}:${a.status}:${a.totalMinorUnits}`),
    ).toEqual(['CREDIT:COMPLETED:2000', 'REFUND:COMPLETED:1500']);
    // An operator listing shows them, as external.
    const listed = (
      await asOperator(
        'none',
        'get',
        `/tenants/${b.tenantId}/billing/adjustments`,
      ).expect(200)
    ).body as PlatformAdjustmentListResponse;
    expect(listed.adjustments.map((a) => a.origin)).toEqual([
      'EXTERNAL',
      'EXTERNAL',
    ]);
  });

  it('the reconciliation run records an external refund whose event never arrived', async () => {
    const b = await business('backstop');
    const inv = await invoice(b, { amount: 9900 });
    await operator('recon', ['billing.reconciliation.run']);
    fake.subscriptions.set(b.sub, {
      externalSubscriptionId: b.sub,
      externalCustomerId: b.customer,
      status: 'active',
      livemode: false,
      hasPaymentMethod: true,
      paymentMethodSource: 'SUBSCRIPTION',
      cancelAtPeriodEnd: false,
      trialStart: null,
      trialEnd: null,
      latestInvoiceId: null,
      items: [],
      scheduleId: null,
      hasPendingUpdate: false,
      currentPeriodStart: new Date(Date.now() - 10 * DAY),
      currentPeriodEnd: new Date(Date.now() + 20 * DAY),
    });
    fake.externalRefund(inv.external, 700);
    const result = (
      await asOperator('recon', 'post', '/billing/reconcile').expect(200)
    ).body as { externalAdjustmentsRecorded: number };
    expect(result.externalAdjustmentsRecorded).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.billingAdjustment.count({
        where: { invoiceId: inv.id, origin: 'EXTERNAL', kind: 'REFUND' },
      }),
    ).toBe(1);
  });

  // --- isolation -------------------------------------------------------------------

  it('businesses only read their own adjustments, and never reach the operator routes', async () => {
    const a = await business('iso-a');
    const other = await business('iso-b');
    const inv = await invoice(other, { amount: 9900 });
    const adjustment = await requested(other, inv, {
      kind: 'CREDIT',
      scope: 'FULL',
    });
    await decide(adjustment.id, 'approverA').expect(200);
    expect(
      (await businessInvoices(a)).invoices.flatMap((i) => i.adjustments),
    ).toEqual([]);
    // Another business's tenant id with this business's staff identity.
    await request(app.getHttpServer())
      .get('/api/v1/admin/billing/invoices')
      .set('Authorization', `Bearer ${staffToken(a.key)}`)
      .set('X-Tenant-Id', other.tenantId)
      .expect((res) => expect(res.status).toBeGreaterThanOrEqual(401));
    // Staff tokens never reach the platform routes.
    for (const [method, path] of [
      ['post', `${base(other, inv)}/adjustments`],
      ['post', `/billing/adjustments/${adjustment.id}/approve`],
      ['get', '/billing/adjustments'],
    ] as const) {
      await request(app.getHttpServer())
        [method](`/api/v1/platform${path}`)
        .set('Authorization', `Bearer ${staffToken(a.key)}`)
        .send({ note: NOTE, reason: REASON, kind: 'CREDIT', scope: 'FULL' })
        .expect(401);
    }
    // No business route requests or approves anything.
    await request(app.getHttpServer())
      .post(`/api/v1/admin/billing/invoices/${inv.id}/adjustments`)
      .set('Authorization', `Bearer ${staffToken(other.key)}`)
      .set('X-Tenant-Id', other.tenantId)
      .send({ kind: 'CREDIT', scope: 'FULL', reason: REASON })
      .expect(404);
  });

  it('restaurant payments are never touched: a refund event for another payment changes nothing', async () => {
    const b = await business('restaurant');
    const before = {
      attempts: await prisma.paymentAttempt.count(),
      obligations: await prisma.orderRefundObligation.count(),
      adjustments: await prisma.billingAdjustment.count(),
    };
    await deliver(b, 'refund.changed', {
      reference: 'pi_restaurant_order_payment',
    }).expect(200);
    expect({
      attempts: await prisma.paymentAttempt.count(),
      obligations: await prisma.orderRefundObligation.count(),
      adjustments: await prisma.billingAdjustment.count(),
    }).toEqual(before);
    expect(
      fake.calls.filter(
        (c) => c.op === 'createCreditNote' && c.key.includes('restaurant'),
      ),
    ).toEqual([]);
  });

  // --- the database guards ------------------------------------------------------------

  it('the database keeps the request immutable and the history append-only', async () => {
    const b = await business('guards');
    const inv = await invoice(b);
    const adjustment = await requested(b, inv, {
      kind: 'CREDIT',
      scope: 'FULL',
    });
    for (const data of [
      { totalMinorUnits: 1 },
      { currency: 'eur' },
      { kind: 'REFUND' },
      { requestedByOperatorId: operators.approverA.id },
      { status: 'SUCCEEDED' },
    ]) {
      await expect(
        prisma.billingAdjustment.update({ where: { id: adjustment.id }, data }),
      ).rejects.toThrow();
    }
    await expect(
      prisma.billingAdjustment.delete({ where: { id: adjustment.id } }),
    ).rejects.toThrow();
    // The requester never decides, even written directly.
    await expect(
      prisma.billingAdjustmentDecision.create({
        data: {
          adjustmentId: adjustment.id,
          operatorId: operators.requester.id,
          decision: 'APPROVED',
          note: NOTE,
        },
      }),
    ).rejects.toThrow();
    // A second open adjustment on the invoice, written directly.
    await expect(
      prisma.billingAdjustment.create({
        data: {
          subscriptionId: b.subscriptionId,
          invoiceId: inv.id,
          origin: 'CENTERIVO',
          kind: 'CREDIT',
          scope: 'FULL',
          status: 'PENDING_APPROVAL',
          currency: 'usd',
          totalMinorUnits: 100,
          taxMinorUnits: 0,
          annualFullRefund: false,
          requiredApprovals: 1,
          reason: REASON,
          requestedByOperatorId: operators.requester.id,
          lineSpec: [],
          expiresAt: new Date(Date.now() + DAY),
        },
      }),
    ).rejects.toThrow();
    const [event] = await prisma.billingAdjustmentEvent.findMany({
      where: { adjustmentId: adjustment.id },
    });
    await expect(
      prisma.billingAdjustmentEvent.update({
        where: { id: event.id },
        data: { type: 'APPROVED' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.billingAdjustmentEvent.delete({ where: { id: event.id } }),
    ).rejects.toThrow();
  });
});
