import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  PlatformPaymentCaseDetail,
  PlatformPaymentCaseListResponse,
  PlatformPaymentCaseRecoverResponse,
  PlatformPermission,
} from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
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

// ESP-03 PR 5 — restaurant payment reconciliation support in the Platform
// Console, end to end on the real AppModule in a SCRATCH database:
// payments.reconciliation.view to read, .manage plus a recent sign-in to
// act; business staff, signed-out callers and operators without the
// permission are refused; filters by business, status, category and date;
// minimal data (no contact details, codes or provider text); a support
// recovery never charges, refuses an uncertain payment and is audited, with
// its reason kept as an append-only note.
jest.setTimeout(240_000);

const codeOf = (body: unknown): unknown => (body as { code?: unknown }).code;

describe('ESP-03 PR 5 platform payment cases (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const PLATFORM_SECRET = `esp03pr5-platform-${randomUUID()}`;
  const INTERNAL_SECRET = `esp03pr5-internal-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  const REASON = 'Customer reported a missing gift card';
  let other: { id: string };
  const ids: Record<string, { attempt: string; case: string }> = {};
  const operatorIds: Record<string, string> = {};

  async function operator(key: string, permissions: PlatformPermission[]) {
    const row = await prisma.platformOperator.create({
      data: {
        externalProvider: 'platform-dev',
        externalSubject: `platform-dev:esp03pr5-${key}-${run}`,
        email: `esp03pr5-${key}-${run}@example.test`,
        status: 'ACTIVE',
      },
    });
    if (permissions.length) {
      await grantPlatformPermissions(prisma, row.id, permissions);
    }
    operatorIds[key] = row.id;
  }
  const platformToken = (key: string, signedInSecondsAgo = 0) =>
    signPlatformDevJwt(
      {
        sub: `platform-dev:esp03pr5-${key}-${run}`,
        mfa: true,
        iat: Math.floor(Date.now() / 1000) - signedInSecondsAgo,
      },
      PLATFORM_SECRET,
      3600,
    );
  const http = () => request(app.getHttpServer());
  const as = (
    key: string,
    method: 'get' | 'post',
    url: string,
    body?: object,
    signedInSecondsAgo = 0,
  ) => {
    const req = http()
      [method](url)
      .set('Authorization', `Bearer ${platformToken(key, signedInSecondsAgo)}`);
    return body ? req.send(body) : req;
  };
  const BASE = '/api/v1/platform/payment-cases';

  // A payment with its case, written directly (the payment states are the
  // point here, not how they were reached).
  async function seed(
    name: string,
    tenantId: string,
    payment: {
      status: 'PENDING' | 'SUCCEEDED' | 'DECLINED';
      paymentState: string | null;
    },
    giftCard = false,
  ) {
    const attempt = await prisma.paymentAttempt.create({
      data: {
        tenantId,
        idempotencyKey: `esp03pr5-${name}-${run}`,
        provider: 'controlled-test',
        amount: 2500,
        currency: 'USD',
        status: payment.status,
        paymentState: payment.paymentState,
        providerReference:
          payment.status === 'SUCCEEDED' ? `ref_${name}_${run}` : null,
      },
    });
    if (giftCard) {
      await prisma.giftCardPurchase.create({
        data: {
          tenantId,
          paymentAttemptId: attempt.id,
          amountMinorUnits: 2500,
          currency: 'USD',
          purchaserEmail: `buyer-${name}@example.test`,
          purchaserName: 'Private Buyer Name',
          status: 'RECONCILIATION_REQUIRED',
          chargeClaimedAt: new Date(),
        },
      });
    }
    const opened = await prisma.paymentReconciliationCase.create({
      data: {
        tenantId,
        paymentAttemptId: attempt.id,
        reasonCode:
          payment.status === 'SUCCEEDED'
            ? 'FULFILMENT_FAILED'
            : 'PROVIDER_OUTCOME_UNKNOWN',
      },
    });
    await prisma.paymentReconciliationEvent.create({
      data: {
        tenantId,
        caseId: opened.id,
        actorKind: 'SYSTEM',
        action: 'OPENED',
        detail: { source: 'payment-charge', reasonCode: opened.reasonCode },
      },
    });
    ids[name] = { attempt: attempt.id, case: opened.id };
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'esp03_pr5_platform',
    );
    await applyMigrations(
      scratch.url,
      listMigrations(
        join(__dirname, '../../../../packages/database/prisma/migrations'),
      ),
    );
    Object.assign(process.env, {
      DATABASE_URL: scratch.url,
      PLATFORM_AUTH_PROVIDER: 'dev',
      PLATFORM_AUTH_DEV_JWT_SECRET: PLATFORM_SECRET,
      INTERNAL_AUTH_PROVIDER: 'dev',
      INTERNAL_AUTH_DEV_JWT_SECRET: INTERNAL_SECRET,
      RATE_LIMIT_ENABLED: '0',
      GIFT_CARD_CODE_SECRET: 'esp03-pr5-platform-spec-secret',
      GIFT_CARD_PURCHASE_CODE_KEK:
        'c4097ecec7942a636761a7c4acc30277edaa900a9ee56f4974c8993a344e963e',
      GIFT_CARD_PURCHASE_RECOVERY_SECRET: 'esp03-pr5-platform-spec-recovery',
    });
    // Automatic recovery stays OFF (the deployment default).
    delete process.env.PAYMENT_AUTO_RECOVERY_ENABLED;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.init();
    prisma = app.get(PrismaService);

    other = await prisma.tenant.create({
      data: { slug: `pr5-other-${run}`, name: 'Other Cafe', status: 'ACTIVE' },
      select: { id: true },
    });
    await seed(
      'gift',
      TENANT_1_MOCHA_HOUSE_ID,
      { status: 'SUCCEEDED', paymentState: 'SUCCEEDED' },
      true,
    );
    await seed('held', TENANT_1_MOCHA_HOUSE_ID, {
      status: 'PENDING',
      paymentState: 'UNKNOWN',
    });
    await seed('legacy', TENANT_1_MOCHA_HOUSE_ID, {
      status: 'SUCCEEDED',
      paymentState: 'SUCCEEDED',
    });
    await seed(
      'other',
      other.id,
      { status: 'SUCCEEDED', paymentState: 'SUCCEEDED' },
      true,
    );

    await operator('none', []);
    await operator('billing', ['billing.reports.view']);
    await operator('viewer', ['payments.reconciliation.view']);
    await operator('manager', [
      'payments.reconciliation.view',
      'payments.reconciliation.manage',
    ]);
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await scratch?.drop();
      process.env = { ...originalEnv };
    }
  });

  const list = async (query = '', key = 'viewer') =>
    (await as(key, 'get', `${BASE}${query}`).expect(200))
      .body as PlatformPaymentCaseListResponse;

  describe('access', () => {
    it('refuses signed-out callers, business staff and operators without the permission', async () => {
      await http().get(BASE).expect(401);
      const staff = signInternalDevJwt(
        {
          sub: 'internal-dev:owner@example.test',
          email: 'owner@example.test',
          name: null,
          email_verified: true,
        },
        INTERNAL_SECRET,
        3600,
      );
      await http()
        .get(BASE)
        .set('Authorization', `Bearer ${staff}`)
        .expect(401);
      await as('none', 'get', BASE).expect(403);
      await as('billing', 'get', BASE).expect(403);
      await as('billing', 'get', `${BASE}/${ids.gift.case}`).expect(403);
      // Refusals are audited.
      expect(
        await prisma.platformAuditEvent.count({
          where: {
            actorPlatformOperatorId: operatorIds.billing,
            outcome: 'DENIED',
          },
        }),
      ).toBeGreaterThan(0);
    });

    it('a viewer can read but never act; acting needs manage and a recent sign-in', async () => {
      await as('viewer', 'get', `${BASE}/${ids.gift.case}`).expect(200);
      await as('viewer', 'post', `${BASE}/${ids.gift.case}/recover`, {
        reason: REASON,
      }).expect(403);
      await as('viewer', 'post', `${BASE}/${ids.gift.case}/notes`, {
        body: 'hello',
      }).expect(403);
      const stale = await as(
        'manager',
        'post',
        `${BASE}/${ids.gift.case}/notes`,
        { body: 'hello' },
        2 * 3600,
      );
      expect(stale.status).toBe(401);
      expect(codeOf(stale.body)).toBe('REAUTHENTICATION_REQUIRED');
      expect(
        await prisma.paymentReconciliationNote.count({
          where: { caseId: ids.gift.case },
        }),
      ).toBe(0);
    });
  });

  describe('reading cases', () => {
    it('lists cases across businesses with their category, filtered by business, status, category and date', async () => {
      const everything = await list('?category=NEEDS_ATTENTION');
      const mine = everything.cases.filter((c) =>
        Object.values(ids).some((i) => i.case === c.id),
      );
      expect(mine.map((c) => c.id).sort()).toEqual(
        [ids.gift.case, ids.legacy.case, ids.other.case].sort(),
      );
      expect(everything.automaticRecoveryEnabled).toBe(false);

      const awaiting = await list('?category=AWAITING_PAYMENT_OUTCOME');
      expect(awaiting.cases.map((c) => c.id)).toContain(ids.held.case);
      expect(awaiting.cases.map((c) => c.id)).not.toContain(ids.gift.case);

      const otherOnly = await list(`?tenantId=${other.id}`);
      expect(otherOnly.cases.map((c) => c.id)).toEqual([ids.other.case]);
      expect(otherOnly.cases[0].tenant).toEqual({
        id: other.id,
        name: 'Other Cafe',
      });

      const today = new Date().toISOString().slice(0, 10);
      expect(
        (await list(`?tenantId=${other.id}&from=${today}&to=${today}`)).cases,
      ).toHaveLength(1);
      expect(
        (await list(`?tenantId=${other.id}&to=2020-01-01`)).cases,
      ).toHaveLength(0);
      expect(
        (await list(`?tenantId=${other.id}&status=RESOLVED`)).cases,
      ).toHaveLength(0);

      for (const bad of [
        '?status=DONE',
        '?category=X',
        '?from=yesterday',
        '?tenantId=a%20b',
        '?sort=amount',
        '?from=2026-02-30',
      ]) {
        await as('viewer', 'get', `${BASE}${bad}`).expect(400);
      }
    });

    it('shows references, states and history but no contact details, codes or secrets', async () => {
      const detail = (
        await as('viewer', 'get', `${BASE}/${ids.gift.case}`).expect(200)
      ).body as PlatformPaymentCaseDetail;
      expect(detail.case).toMatchObject({
        id: ids.gift.case,
        status: 'OPEN',
        category: 'NEEDS_ATTENTION',
        purchaseKind: 'GIFT_CARD',
        payment: {
          id: ids.gift.attempt,
          amountMinorUnits: 2500,
          status: 'SUCCEEDED',
          paymentState: 'SUCCEEDED',
          providerReference: `ref_gift_${run}`,
        },
        giftCardPurchase: { issued: false },
        recovery: { recoverable: true, nextAutomaticAttemptAt: null },
      });
      expect(detail.events.map((e) => [e.actor, e.action])).toEqual([
        ['SYSTEM', 'OPENED'],
      ]);
      const text = JSON.stringify(detail);
      expect(text).not.toContain('buyer-gift@example.test');
      expect(text).not.toContain('Private Buyer Name');
      expect(text).not.toMatch(
        /idempotency|recoveryCredential|codeCiphertext/i,
      );
      await as('viewer', 'get', `${BASE}/${randomUUID()}`).expect(404);
      await as('viewer', 'get', `${BASE}/not-an-id`).expect(404);
    });
  });

  describe('acting on a case', () => {
    it('adds an append-only note, audited, with its author', async () => {
      await as('manager', 'post', `${BASE}/${ids.legacy.case}/notes`, {
        body: '',
      }).expect(400);
      await as('manager', 'post', `${BASE}/${ids.legacy.case}/notes`, {
        body: 'x'.repeat(1001),
      }).expect(400);
      await as('manager', 'post', `${BASE}/${ids.legacy.case}/notes`, {
        body: 'ok',
        extra: 1,
      }).expect(400);
      const detail = (
        await as('manager', 'post', `${BASE}/${ids.legacy.case}/notes`, {
          body: '  Asked the restaurant to check the till.  ',
        }).expect(200)
      ).body as PlatformPaymentCaseDetail;
      expect(detail.notes).toEqual([
        expect.objectContaining({
          body: 'Asked the restaurant to check the till.',
          authorEmail: `esp03pr5-manager-${run}@example.test`,
        }),
      ]);
      expect(
        await prisma.platformAuditEvent.findFirst({
          where: {
            action: 'platform.payment_case.note_added',
            targetId: ids.legacy.case,
          },
        }),
      ).toMatchObject({
        outcome: 'SUCCEEDED',
        actorPlatformOperatorId: operatorIds.manager,
        targetType: 'payment_case',
      });
    });

    it('refuses to recover an uncertain payment or one with nothing saved, writing nothing', async () => {
      const held = await as(
        'manager',
        'post',
        `${BASE}/${ids.held.case}/recover`,
        { reason: REASON },
      );
      expect(held.status).toBe(409);
      expect(codeOf(held.body)).toBe('PAYMENT_RECOVERY_NOT_CONFIRMED');
      const legacy = await as(
        'manager',
        'post',
        `${BASE}/${ids.legacy.case}/recover`,
        { reason: REASON },
      );
      expect(legacy.status).toBe(409);
      expect(codeOf(legacy.body)).toBe('PAYMENT_RECOVERY_NOTHING_TO_RECOVER');
      await as('manager', 'post', `${BASE}/${ids.gift.case}/recover`, {
        reason: 'short',
      }).expect(400);
      for (const c of [ids.held.case, ids.legacy.case]) {
        expect(
          await prisma.paymentReconciliationEvent.count({
            where: { caseId: c },
          }),
        ).toBe(1);
        expect(
          await prisma.paymentReconciliationCase.findUniqueOrThrow({
            where: { id: c },
          }),
        ).toMatchObject({ status: 'OPEN' });
      }
      // The refusals are audited (DENIED, with the refusal code).
      expect(
        (
          await prisma.platformAuditEvent.findMany({
            where: {
              action: 'platform.payment_case.recovery_requested',
              targetId: { in: [ids.held.case, ids.legacy.case] },
            },
            select: { outcome: true, reasonCode: true },
          })
        ).sort((a, b) => a.reasonCode!.localeCompare(b.reasonCode!)),
      ).toEqual([
        { outcome: 'DENIED', reasonCode: 'PAYMENT_RECOVERY_NOT_CONFIRMED' },
        {
          outcome: 'DENIED',
          reasonCode: 'PAYMENT_RECOVERY_NOTHING_TO_RECOVER',
        },
      ]);
    });

    it('recovers a charged gift card safely: one card, case resolved, reason kept as a note, audited, never charged', async () => {
      const response = await as(
        'manager',
        'post',
        `${BASE}/${ids.gift.case}/recover`,
        { reason: REASON },
      );
      expect(response.status).toBe(200);
      const body = response.body as PlatformPaymentCaseRecoverResponse;
      expect(body.result).toBe('RECOVERED');
      expect(body.detail.case).toMatchObject({
        status: 'RESOLVED',
        category: 'RECOVERED',
        giftCardPurchase: { issued: true },
      });
      expect(body.detail.events.map((e) => e.action)).toEqual([
        'OPENED',
        'RECOVERY_STARTED',
        'RESOLVED',
        'RECOVERY_SUCCEEDED',
      ]);
      expect(body.detail.events[1].detail).toMatchObject({
        trigger: 'platform_support',
        requestedBy: `esp03pr5-manager-${run}@example.test`,
      });
      expect(body.detail.notes[0]).toMatchObject({
        body: `Recovery requested: ${REASON}`,
      });
      // No code anywhere in the answer.
      expect(JSON.stringify(body)).not.toMatch(/"code"|displayCode|canonical/i);
      const purchase = await prisma.giftCardPurchase.findUniqueOrThrow({
        where: { paymentAttemptId: ids.gift.attempt },
      });
      expect(purchase.status).toBe('ISSUED');
      expect(
        await prisma.giftCardTransaction.count({
          where: { giftCardPurchaseId: purchase.id, type: 'ISSUANCE' },
        }),
      ).toBe(1);
      expect(
        await prisma.paymentAttempt.findUniqueOrThrow({
          where: { id: ids.gift.attempt },
        }),
      ).toMatchObject({
        status: 'SUCCEEDED',
        paymentState: 'SUCCEEDED',
        amount: 2500,
      });
      expect(
        await prisma.platformAuditEvent.findFirst({
          where: {
            action: 'platform.payment_case.recovery_requested',
            targetId: ids.gift.case,
          },
        }),
      ).toMatchObject({
        outcome: 'SUCCEEDED',
        reasonCode: 'RECOVERED',
        targetType: 'payment_case',
      });

      // Again: the case is resolved, so nothing is done (refusal audited).
      const again = await as(
        'manager',
        'post',
        `${BASE}/${ids.gift.case}/recover`,
        { reason: REASON },
      );
      expect(again.status).toBe(409);
      expect(codeOf(again.body)).toBe('PAYMENT_RECOVERY_CASE_RESOLVED');
      expect(
        await prisma.platformAuditEvent.findFirst({
          where: {
            action: 'platform.payment_case.recovery_requested',
            targetId: ids.gift.case,
            outcome: 'DENIED',
          },
        }),
      ).toMatchObject({ reasonCode: 'PAYMENT_RECOVERY_CASE_RESOLVED' });
      expect(
        await prisma.giftCardTransaction.count({
          where: { giftCardPurchaseId: purchase.id, type: 'ISSUANCE' },
        }),
      ).toBe(1);
      expect(
        (
          await list(`?category=RECOVERED&tenantId=${TENANT_1_MOCHA_HOUSE_ID}`)
        ).cases.map((c) => c.id),
      ).toContain(ids.gift.case);
    });

    it("recovering one business's case never touches another's", async () => {
      expect(
        await prisma.giftCardPurchase.findUniqueOrThrow({
          where: { paymentAttemptId: ids.other.attempt },
        }),
      ).toMatchObject({ giftCardId: null });
      expect(
        await prisma.paymentReconciliationCase.findUniqueOrThrow({
          where: { id: ids.other.case },
        }),
      ).toMatchObject({ status: 'OPEN' });
      expect(
        await prisma.paymentReconciliationNote.count({
          where: { caseId: ids.other.case },
        }),
      ).toBe(0);
    });
  });
});
