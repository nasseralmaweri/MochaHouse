import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminGiftCardDetail,
  AdminGiftCardSearchResponse,
  GiftCardConfiguration,
  IssueGiftCardResponse,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { GiftCardsModule } from './gift-cards.module';

type Scope = { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null };

// Milestone 7F — HQ Gift Card administration over real HTTP. Covers the
// three CORPORATE-only permission gates, the Store Manager exclusion,
// secure code handling / masking, exact-code and id lookup, the immutable
// ledger and the SUM==balance invariant, manual corrections (bounds,
// idempotency, concurrency), inactive-card corrections, deactivate /
// reactivate, audit records, configuration, and that no plaintext code
// leaks through a normal read.
describe('Gift Card administration (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'gift-card-admin-spec-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const giftCardIds: string[] = [];
  let locId: string;

  const token = (key: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${key}`, email: `${key}@example.com`, name: null },
      internalSecret,
      3600,
    );

  async function makeUserWithRole(
    key: string,
    permissionKeys: string[],
    scope: Scope,
  ): Promise<void> {
    const role = await prisma.internalRole.create({
      data: {
        key: `gift-card-admin-${suffix}-${randomUUID()}`,
        displayName: 'Gift Card Admin Spec Role',
        permissions: {
          create: permissionKeys.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    roleIds.push(role.id);
    const user = await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${key}-${suffix}`,
        email: `${key}-${suffix}@example.com`,
        displayName: key,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(user.id);
    await prisma.internalUserRoleAssignment.create({
      data: { internalUserId: user.id, roleId: role.id, ...scope },
    });
  }

  const authed = (
    method: 'get' | 'post' | 'put',
    path: string,
    key: string,
  ) =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`);

  const search = (key: string, body: unknown) =>
    authed('post', '/api/v1/admin/gift-cards/search', key).send(body as object);

  const issue = (key: string, body: unknown) =>
    authed('post', '/api/v1/admin/gift-cards', key).send(body as object);

  const detail = (key: string, id: string) =>
    authed('get', `/api/v1/admin/gift-cards/${id}`, key);

  const correct = (key: string, id: string, body: unknown) =>
    authed(
      'post',
      `/api/v1/admin/gift-cards/${id}/corrections`,
      key,
    ).send(body as object);

  const setStatus = (
    key: string,
    id: string,
    action: 'deactivate' | 'reactivate',
    body: unknown = {},
  ) =>
    authed(
      'post',
      `/api/v1/admin/gift-cards/${id}/${action}`,
      key,
    ).send(body as object);

  async function issueCard(
    key: string,
    originalValueMinorUnits: number,
  ): Promise<IssueGiftCardResponse> {
    const res = await issue(key, { originalValueMinorUnits }).expect(201);
    const body = res.body as IssueGiftCardResponse;
    giftCardIds.push(body.giftCard.id);
    return body;
  }

  async function auditFor(giftCardId: string) {
    return prisma.internalAuditEvent.findMany({
      where: { targetType: 'gift_card', targetId: giftCardId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async function ledgerSum(giftCardId: string): Promise<number> {
    const rows = await prisma.giftCardTransaction.findMany({
      where: { giftCardId },
      select: { amountMinorUnits: true },
    });
    return rows.reduce((total, row) => total + row.amountMinorUnits, 0);
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'gift-card-admin-spec-customer-secret';
    process.env.GIFT_CARD_CODE_SECRET = 'gift-card-admin-spec-code-secret';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        GiftCardsModule,
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    locId = (
      await prisma.location.create({
        data: { name: `GC Loc ${suffix}`, slug: `gc-loc-${suffix}` },
      })
    ).id;

    await makeUserWithRole(
      'hq',
      ['giftcards.view', 'giftcards.manage', 'giftcards.configure'],
      { scopeType: 'CORPORATE', scopeId: null },
    );
    await makeUserWithRole('viewer', ['giftcards.view'], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await makeUserWithRole(
      'locationScoped',
      ['giftcards.view', 'giftcards.manage', 'giftcards.configure'],
      { scopeType: 'LOCATION', scopeId: locId },
    );

    const storeManager = await prisma.internalRole.findUniqueOrThrow({
      where: { key: 'store-manager' },
    });
    const mgr = await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:storeMgr-${suffix}`,
        email: `storeMgr-${suffix}@example.com`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(mgr.id);
    await prisma.internalUserRoleAssignment.create({
      data: {
        internalUserId: mgr.id,
        roleId: storeManager.id,
        scopeType: 'LOCATION',
        scopeId: locId,
      },
    });
  }, 45_000);

  afterEach(async () => {
    if (giftCardIds.length > 0) {
      await prisma.internalAuditEvent.deleteMany({
        where: { targetType: 'gift_card', targetId: { in: giftCardIds } },
      });
      await prisma.giftCardTransaction.deleteMany({
        where: { giftCardId: { in: giftCardIds } },
      });
      await prisma.giftCard.deleteMany({ where: { id: { in: giftCardIds } } });
      giftCardIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.internalAuditEvent.deleteMany({
      where: { actorInternalUserId: { in: userIds } },
    });
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIds } },
    });
    for (const id of roleIds) {
      await prisma.internalRolePermission.deleteMany({ where: { roleId: id } });
      await prisma.internalRole.deleteMany({ where: { id } });
    }
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    if (locId) {
      await prisma.location.deleteMany({ where: { id: locId } });
    }
    await app.close();
    process.env = { ...originalEnv };
  });

  // --- AUTH ------------------------------------------------------

  it('rejects an internal user with no gift-card permission', async () => {
    await makeUserWithRole('none', ['orders.view'], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await search('none', { code: 'XXXX' }).expect(403);
    await issue('none', { originalValueMinorUnits: 1000 }).expect(403);
  });

  it('a Store Manager holds none of the gift-card permissions', async () => {
    await search('storeMgr', { code: 'XXXX' }).expect(403);
    await issue('storeMgr', { originalValueMinorUnits: 1000 }).expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/admin/gift-cards/configuration')
      .set('Authorization', `Bearer ${token(`storeMgr-${suffix}`)}`)
      .expect(403);
  });

  it('a LOCATION-scoped grant is rejected (all keys are CORPORATE-only)', async () => {
    await search('locationScoped', { code: 'XXXX' }).expect(403);
    await issue('locationScoped', { originalValueMinorUnits: 1000 }).expect(403);
  });

  it('giftcards.view cannot issue, correct, deactivate or configure', async () => {
    const { giftCard } = await issueCard('hq', 5000);
    await issue('viewer', { originalValueMinorUnits: 1000 }).expect(403);
    await correct('viewer', giftCard.id, {
      deltaMinorUnits: 100,
      reason: 'x',
      operationKey: randomUUID(),
    }).expect(403);
    await setStatus('viewer', giftCard.id, 'deactivate').expect(403);
    await request(app.getHttpServer())
      .put('/api/v1/admin/gift-cards/configuration')
      .set('Authorization', `Bearer ${token(`viewer-${suffix}`)}`)
      .send({ presetAmountsMinorUnits: [1000], customAmountEnabled: true })
      .expect(403);
    // …but it CAN read.
    await detail('viewer', giftCard.id).expect(200);
  });

  // --- ISSUANCE + SECURE CODE ----------------------------------

  it('issues a card: one ISSUANCE entry, balance == value, audit, code shown once', async () => {
    const { giftCard, code } = await issueCard('hq', 5000);

    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4} [2-9A-HJ-NP-Z]{4} [2-9A-HJ-NP-Z]{4} [2-9A-HJ-NP-Z]{4}$/);
    expect(giftCard).toMatchObject({
      status: 'ACTIVE',
      originalValueMinorUnits: 5000,
      balanceMinorUnits: 5000,
      currency: 'USD',
    });
    expect(giftCard.maskedCode).toBe(`•••• •••• •••• ${giftCard.last4}`);
    expect(code.replace(/ /g, '').endsWith(giftCard.last4)).toBe(true);

    const stored = await prisma.giftCard.findUniqueOrThrow({
      where: { id: giftCard.id },
    });
    // Plaintext code is never persisted.
    expect(JSON.stringify(stored)).not.toContain(code.replace(/ /g, ''));
    expect(stored.codeHash).not.toContain(code.replace(/ /g, ''));

    const txns = await prisma.giftCardTransaction.findMany({
      where: { giftCardId: giftCard.id },
    });
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({
      type: 'ISSUANCE',
      amountMinorUnits: 5000,
      balanceAfterMinorUnits: 5000,
      reason: null,
    });
    expect(await ledgerSum(giftCard.id)).toBe(giftCard.balanceMinorUnits);

    const audit = await auditFor(giftCard.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('giftcards.card_issued');
    expect(JSON.stringify(audit[0])).not.toContain(code.replace(/ /g, ''));
  });

  it('rejects issuance outside the $0.01–$2,000.00 range', async () => {
    await issue('hq', { originalValueMinorUnits: 0 }).expect(400);
    await issue('hq', { originalValueMinorUnits: -100 }).expect(400);
    await issue('hq', { originalValueMinorUnits: 200_001 }).expect(400);
    await issue('hq', { originalValueMinorUnits: 10.5 }).expect(400);
    await issue('hq', {
      originalValueMinorUnits: 1000,
      currency: 'EUR',
    }).expect(400);
  });

  it('detail and search never expose the full code or codeHash', async () => {
    const { giftCard, code } = await issueCard('hq', 2500);
    const canonical = code.replace(/ /g, '');

    const byId = (await detail('hq', giftCard.id).expect(200))
      .body as AdminGiftCardDetail;
    expect(JSON.stringify(byId)).not.toContain(canonical);
    expect(JSON.stringify(byId)).not.toContain('codeHash');
    expect(byId.giftCard.maskedCode).toContain('••••');

    const byCode = (await search('hq', { code }).expect(201))
      .body as AdminGiftCardSearchResponse;
    expect(byCode.giftCards).toHaveLength(1);
    expect(byCode.giftCards[0].id).toBe(giftCard.id);
    expect(JSON.stringify(byCode)).not.toContain(canonical);

    // Case / spacing insensitive.
    await search('hq', { code: canonical.toLowerCase() })
      .expect(201)
      .then((r) =>
        expect((r.body as AdminGiftCardSearchResponse).giftCards).toHaveLength(1),
      );
  });

  it('search: unknown code → empty, id lookup works, bad input → 400', async () => {
    const { giftCard } = await issueCard('hq', 1000);
    await search('hq', { code: 'ZZZZ ZZZZ ZZZZ ZZZZ' })
      .expect(201)
      .then((r) =>
        expect((r.body as AdminGiftCardSearchResponse).giftCards).toHaveLength(0),
      );
    await search('hq', { giftCardId: giftCard.id })
      .expect(201)
      .then((r) =>
        expect((r.body as AdminGiftCardSearchResponse).giftCards[0].id).toBe(
          giftCard.id,
        ),
      );
    await search('hq', {}).expect(400);
    await search('hq', { code: 'X', giftCardId: giftCard.id }).expect(400);
    await search('hq', { giftCardId: 'not-a-uuid' }).expect(400);
  });

  // --- LEDGER + CORRECTIONS -----------------------------------

  it('applies a positive and a negative correction with a running balance', async () => {
    const { giftCard } = await issueCard('hq', 5000);

    const afterAdd = (
      await correct('hq', giftCard.id, {
        deltaMinorUnits: 1500,
        reason: 'Goodwill top-up',
        operationKey: randomUUID(),
      }).expect(201)
    ).body as AdminGiftCardDetail;
    expect(afterAdd.giftCard.balanceMinorUnits).toBe(6500);

    const afterDeduct = (
      await correct('hq', giftCard.id, {
        deltaMinorUnits: -2000,
        reason: 'Correcting a double issue',
        operationKey: randomUUID(),
      }).expect(201)
    ).body as AdminGiftCardDetail;
    expect(afterDeduct.giftCard.balanceMinorUnits).toBe(4500);

    expect(afterDeduct.transactions[0]).toMatchObject({
      type: 'ADJUSTMENT',
      amountMinorUnits: -2000,
      balanceAfterMinorUnits: 4500,
      reason: 'Correcting a double issue',
    });
    expect(await ledgerSum(giftCard.id)).toBe(4500);

    const audit = await auditFor(giftCard.id);
    expect(audit.map((a) => a.action)).toEqual([
      'giftcards.card_issued',
      'giftcards.balance_corrected',
      'giftcards.balance_corrected',
    ]);
  });

  it('rejects a correction below $0.00 or above $2,000.00, and requires a reason', async () => {
    const { giftCard } = await issueCard('hq', 5000);
    await correct('hq', giftCard.id, {
      deltaMinorUnits: -5001,
      reason: 'too much',
      operationKey: randomUUID(),
    }).expect(409);
    await correct('hq', giftCard.id, {
      deltaMinorUnits: 195_001,
      reason: 'too much',
      operationKey: randomUUID(),
    }).expect(409);
    await correct('hq', giftCard.id, {
      deltaMinorUnits: 100,
      reason: '   ',
      operationKey: randomUUID(),
    }).expect(400);
    await correct('hq', giftCard.id, {
      deltaMinorUnits: 0,
      reason: 'noop',
      operationKey: randomUUID(),
    }).expect(400);
    // Nothing was written.
    const stored = await prisma.giftCard.findUniqueOrThrow({
      where: { id: giftCard.id },
    });
    expect(stored.balanceMinorUnits).toBe(5000);
    expect(await ledgerSum(giftCard.id)).toBe(5000);
  });

  it('is idempotent on operationKey (sequential replay)', async () => {
    const { giftCard } = await issueCard('hq', 5000);
    const operationKey = randomUUID();
    const body = { deltaMinorUnits: 750, reason: 'One-off', operationKey };

    const first = (await correct('hq', giftCard.id, body).expect(201))
      .body as AdminGiftCardDetail;
    const second = (await correct('hq', giftCard.id, body).expect(201))
      .body as AdminGiftCardDetail;

    expect(first.giftCard.balanceMinorUnits).toBe(5750);
    expect(second.giftCard.balanceMinorUnits).toBe(5750);
    const adjustments = await prisma.giftCardTransaction.count({
      where: { giftCardId: giftCard.id, type: 'ADJUSTMENT' },
    });
    expect(adjustments).toBe(1);
    const audit = (await auditFor(giftCard.id)).filter(
      (a) => a.action === 'giftcards.balance_corrected',
    );
    expect(audit).toHaveLength(1);
  });

  it('applies a correction exactly once under concurrent identical submissions', async () => {
    const { giftCard } = await issueCard('hq', 5000);
    const body = {
      deltaMinorUnits: 1000,
      reason: 'Race',
      operationKey: randomUUID(),
    };
    const results = await Promise.all([
      correct('hq', giftCard.id, body),
      correct('hq', giftCard.id, body),
      correct('hq', giftCard.id, body),
    ]);
    for (const r of results) {
      expect(r.status).toBe(201);
    }
    const stored = await prisma.giftCard.findUniqueOrThrow({
      where: { id: giftCard.id },
    });
    expect(stored.balanceMinorUnits).toBe(6000);
    const adjustments = await prisma.giftCardTransaction.count({
      where: { giftCardId: giftCard.id, type: 'ADJUSTMENT' },
    });
    expect(adjustments).toBe(1);
    expect(await ledgerSum(giftCard.id)).toBe(6000);
  });

  it('rejects reuse of an operationKey across two different cards', async () => {
    const a = await issueCard('hq', 5000);
    const b = await issueCard('hq', 5000);
    const operationKey = randomUUID();
    await correct('hq', a.giftCard.id, {
      deltaMinorUnits: 100,
      reason: 'first',
      operationKey,
    }).expect(201);
    await correct('hq', b.giftCard.id, {
      deltaMinorUnits: 100,
      reason: 'second',
      operationKey,
    }).expect(409);
  });

  it('rejects a concurrent cross-card operationKey clash — exactly one wins, the other is 409', async () => {
    const a = await issueCard('hq', 5000);
    const b = await issueCard('hq', 5000);
    const operationKey = randomUUID();

    const [resA, resB] = await Promise.all([
      correct('hq', a.giftCard.id, {
        deltaMinorUnits: 700,
        reason: 'card A',
        operationKey,
      }),
      correct('hq', b.giftCard.id, {
        deltaMinorUnits: 900,
        reason: 'card B',
        operationKey,
      }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const winnerIsA = resA.status === 201;
    const winnerCardId = winnerIsA ? a.giftCard.id : b.giftCard.id;
    const loserCardId = winnerIsA ? b.giftCard.id : a.giftCard.id;
    const winnerDelta = winnerIsA ? 700 : 900;

    // Exactly one ADJUSTMENT ledger row exists for that operationKey, on the
    // winning card only.
    const rows = await prisma.giftCardTransaction.findMany({
      where: { type: 'ADJUSTMENT', operationKey },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].giftCardId).toBe(winnerCardId);

    // Only the winning card's balance changed; the loser is untouched.
    const winner = await prisma.giftCard.findUniqueOrThrow({
      where: { id: winnerCardId },
    });
    const loser = await prisma.giftCard.findUniqueOrThrow({
      where: { id: loserCardId },
    });
    expect(winner.balanceMinorUnits).toBe(5000 + winnerDelta);
    expect(loser.balanceMinorUnits).toBe(5000);

    // Ledger/balance invariants hold for both cards.
    expect(await ledgerSum(winnerCardId)).toBe(winner.balanceMinorUnits);
    expect(await ledgerSum(loserCardId)).toBe(5000);

    // Audit history reflects only the successful correction.
    const winnerAudit = (await auditFor(winnerCardId)).filter(
      (e) => e.action === 'giftcards.balance_corrected',
    );
    const loserAudit = (await auditFor(loserCardId)).filter(
      (e) => e.action === 'giftcards.balance_corrected',
    );
    expect(winnerAudit).toHaveLength(1);
    expect(loserAudit).toHaveLength(0);
  });

  // --- STATUS --------------------------------------------------

  it('deactivates and reactivates, audits each change, no-op is not audited', async () => {
    const { giftCard } = await issueCard('hq', 5000);

    const deactivated = (
      await setStatus('hq', giftCard.id, 'deactivate', {
        reason: 'Reported lost',
      }).expect(201)
    ).body as AdminGiftCardDetail;
    expect(deactivated.giftCard.status).toBe('INACTIVE');
    expect(deactivated.giftCard.balanceMinorUnits).toBe(5000);

    // Repeat deactivate — no-op, not audited.
    await setStatus('hq', giftCard.id, 'deactivate').expect(201);

    const reactivated = (
      await setStatus('hq', giftCard.id, 'reactivate').expect(201)
    ).body as AdminGiftCardDetail;
    expect(reactivated.giftCard.status).toBe('ACTIVE');

    const audit = await auditFor(giftCard.id);
    expect(audit.map((a) => a.action)).toEqual([
      'giftcards.card_issued',
      'giftcards.card_deactivated',
      'giftcards.card_reactivated',
    ]);
    // Status changes never touched the ledger.
    const txns = await prisma.giftCardTransaction.count({
      where: { giftCardId: giftCard.id },
    });
    expect(txns).toBe(1);
  });

  it('allows an authorized correction on an INACTIVE card', async () => {
    const { giftCard } = await issueCard('hq', 5000);
    await setStatus('hq', giftCard.id, 'deactivate').expect(201);
    const corrected = (
      await correct('hq', giftCard.id, {
        deltaMinorUnits: -500,
        reason: 'Refund adjustment while inactive',
        operationKey: randomUUID(),
      }).expect(201)
    ).body as AdminGiftCardDetail;
    expect(corrected.giftCard.status).toBe('INACTIVE');
    expect(corrected.giftCard.balanceMinorUnits).toBe(4500);
    expect(await ledgerSum(giftCard.id)).toBe(4500);
  });

  // --- CONFIGURATION -----------------------------------------

  it('reads and updates the gift-card purchasing configuration with audit', async () => {
    const initial = (
      await request(app.getHttpServer())
        .get('/api/v1/admin/gift-cards/configuration')
        .set('Authorization', `Bearer ${token(`hq-${suffix}`)}`)
        .expect(200)
    ).body as GiftCardConfiguration;
    expect(Array.isArray(initial.presetAmountsMinorUnits)).toBe(true);
    expect(typeof initial.customAmountEnabled).toBe('boolean');

    const updated = (
      await request(app.getHttpServer())
        .put('/api/v1/admin/gift-cards/configuration')
        .set('Authorization', `Bearer ${token(`hq-${suffix}`)}`)
        .send({
          presetAmountsMinorUnits: [5000, 1000, 2000],
          customAmountEnabled: false,
        })
        .expect(200)
    ).body as GiftCardConfiguration;
    // Stored ascending.
    expect(updated.presetAmountsMinorUnits).toEqual([1000, 2000, 5000]);
    expect(updated.customAmountEnabled).toBe(false);

    const audit = await prisma.internalAuditEvent.findMany({
      where: {
        targetType: 'giftcard_configuration',
        action: 'giftcards.configuration_updated',
      },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(audit).toHaveLength(1);

    // Reject invalid presets.
    await request(app.getHttpServer())
      .put('/api/v1/admin/gift-cards/configuration')
      .set('Authorization', `Bearer ${token(`hq-${suffix}`)}`)
      .send({ presetAmountsMinorUnits: [200_001], customAmountEnabled: true })
      .expect(400);
    await request(app.getHttpServer())
      .put('/api/v1/admin/gift-cards/configuration')
      .set('Authorization', `Bearer ${token(`hq-${suffix}`)}`)
      .send({ presetAmountsMinorUnits: [1000, 1000], customAmountEnabled: true })
      .expect(400);

    // Restore the seeded defaults so the shared row is left as found.
    await request(app.getHttpServer())
      .put('/api/v1/admin/gift-cards/configuration')
      .set('Authorization', `Bearer ${token(`hq-${suffix}`)}`)
      .send({
        presetAmountsMinorUnits: [1000, 2500, 5000, 10000],
        customAmountEnabled: true,
      })
      .expect(200);
  });

  it('a no-op configuration update succeeds without writing a new audit event', async () => {
    const putConfig = (body: unknown) =>
      request(app.getHttpServer())
        .put('/api/v1/admin/gift-cards/configuration')
        .set('Authorization', `Bearer ${token(`hq-${suffix}`)}`)
        .send(body as object);

    const configAuditCount = () =>
      prisma.internalAuditEvent.count({
        where: {
          targetType: 'giftcard_configuration',
          action: 'giftcards.configuration_updated',
        },
      });

    // Set a known configuration.
    await putConfig({
      presetAmountsMinorUnits: [1500, 3000, 4500],
      customAmountEnabled: true,
    }).expect(200);

    const before = await configAuditCount();

    // Submit the exact same values — deliberately in a different preset
    // order to prove the no-op check is normalization-aware.
    const echoed = (
      await putConfig({
        presetAmountsMinorUnits: [4500, 1500, 3000],
        customAmountEnabled: true,
      }).expect(200)
    ).body as GiftCardConfiguration;
    expect(echoed.presetAmountsMinorUnits).toEqual([1500, 3000, 4500]);
    expect(echoed.customAmountEnabled).toBe(true);

    // No new audit event.
    expect(await configAuditCount()).toBe(before);

    // Restore the seeded defaults so the shared row is left as found.
    await putConfig({
      presetAmountsMinorUnits: [1000, 2500, 5000, 10000],
      customAmountEnabled: true,
    }).expect(200);
  });
});
