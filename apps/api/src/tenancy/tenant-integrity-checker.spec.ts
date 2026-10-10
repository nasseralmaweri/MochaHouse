import 'dotenv/config';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  TENANT_1_MOCHA_HOUSE_ID,
  TENANT_RELATIONSHIPS,
  checkTenantIntegrity,
  type DirectReference,
  type IntegrityQueryable,
  type TenantIntegrityReport,
} from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  withScratchClient,
  type ScratchDatabase,
} from '@mocha-house/testing';

// Security 4C-1 — the read-only tenant integrity checker, on a scratch
// database migrated to the current schema:
//   - a clean two-business fixture produces zero findings;
//   - deliberately planted cross-business, missing and invalid references
//     of every relationship type are each detected, attributed to the right
//     relationship and reported by primary key only;
//   - the checker modifies nothing and runs in a read-only transaction;
//   - the CLI exits non-zero on violations and never prints the URL.
// All data is fictional.

jest.setTimeout(300_000);

const repoRoot = join(__dirname, '../../../..');
const baseUrl = process.env.DATABASE_URL!;
const A = TENANT_1_MOCHA_HOUSE_ID;
const B = TEST_TENANT_B_ID;
// Distinctive fictional personal data that must never appear in a report.
const PRIVATE_MARKERS = [
  'Privatina Testperson',
  'private.person@example.test',
  '5559876543',
];

type Ids = Awaited<ReturnType<typeof business>>;

async function business(prisma: PrismaClient, tenantId: string, tag: string) {
  const location = await prisma.location.create({
    data: { tenantId, name: `${tag} Store`, slug: `${tag}-store` },
  });
  const category = await prisma.category.create({
    data: { tenantId, name: `${tag} Drinks`, slug: `${tag}-drinks` },
  });
  const product = await prisma.product.create({
    data: {
      tenantId,
      name: `${tag} Latte`,
      slug: `${tag}-latte`,
      categoryId: category.id,
    },
  });
  const menu = await prisma.menu.create({
    data: { tenantId, name: `${tag} Menu`, slug: `${tag}-menu` },
  });
  await prisma.menuProduct.create({
    data: { tenantId, menuId: menu.id, productId: product.id },
  });
  const customer = await prisma.customer.create({
    data: {
      tenantId,
      externalProvider: 'dev',
      externalSubject: `${tag}-subject`,
      email: PRIVATE_MARKERS[1].replace('@', `+${tag}@`),
    },
  });
  const payment = await prisma.paymentAttempt.create({
    data: {
      tenantId,
      idempotencyKey: `${tag}-idem-${randomUUID()}`,
      provider: 'fake',
      amount: 500,
      currency: 'USD',
      locationId: location.id,
    },
  });
  const order = await prisma.order.create({
    data: {
      tenantId,
      orderNumber: `${tag}-${randomUUID().slice(0, 8)}`,
      accessToken: randomUUID(),
      locationId: location.id,
      customerId: customer.id,
      paymentAttemptId: payment.id,
      guestName: PRIVATE_MARKERS[0],
      guestPhone: PRIVATE_MARKERS[2],
      currency: 'USD',
      subtotal: 500,
    },
  });
  const line = await prisma.orderLine.create({
    data: {
      tenantId,
      orderId: order.id,
      productId: product.id,
      productName: `${tag} Latte`,
      unitPrice: 500,
      quantity: 1,
      lineTotal: 500,
      currency: 'USD',
      selections: [],
    },
  });
  const user = await prisma.internalUser.create({
    data: {
      tenantId,
      externalProvider: 'dev',
      externalSubject: `${tag}-staff`,
      email: `${tag}.staff@example.test`,
    },
  });
  const role = await prisma.internalRole.create({
    data: { tenantId, key: `${tag}-role`, displayName: `${tag} Role` },
  });
  const assignment = await prisma.internalUserRoleAssignment.create({
    data: {
      tenantId,
      internalUserId: user.id,
      roleId: role.id,
      scopeType: 'LOCATION',
      scopeId: location.id,
    },
  });
  const media = await prisma.mediaAsset.create({
    data: {
      tenantId,
      objectKey: `${tag}/${randomUUID()}.jpg`,
      fileName: 'hero.jpg',
      contentType: 'image/jpeg',
      fileSizeBytes: 1000,
      uploadedByInternalUserId: user.id,
    },
  });
  const page = await prisma.cmsPage.create({
    data: {
      tenantId,
      key: 'home',
      title: `${tag} Home`,
      draftContent: { hero: { backgroundImageId: media.id } },
      publishedContent: { hero: { backgroundImageId: media.id } },
    },
  });
  const campaign = await prisma.campaign.create({
    data: { tenantId, name: `${tag} Campaign`, mediaAssetId: media.id },
  });
  const promotion = await prisma.promotion.create({
    data: {
      tenantId,
      name: `${tag} Promo`,
      kind: 'AUTOMATIC',
      discountType: 'PERCENTAGE_OFF',
    },
  });
  const redemption = await prisma.orderPromotionRedemption.create({
    data: {
      tenantId,
      orderId: order.id,
      sourcePromotionId: promotion.id,
      promotionName: `${tag} Promo`,
      promotionKind: 'AUTOMATIC',
      discountType: 'PERCENTAGE_OFF',
      discountValue: 10,
      discountMinorUnits: 50,
      customerId: customer.id,
    },
  });
  const audit = await prisma.internalAuditEvent.create({
    data: {
      tenantId,
      actorInternalUserId: user.id,
      action: 'customer.viewed',
      targetType: 'customer',
      targetId: customer.id,
      reason: 'fixture',
    },
  });
  const outbox = await prisma.outboxEvent.create({
    data: {
      tenantId,
      aggregateType: 'Order',
      aggregateId: order.id,
      eventType: 'order.placed',
      payload: { orderId: order.id },
    },
  });
  const approval = await prisma.approvalRequest.create({
    data: {
      tenantId,
      targetType: 'Campaign',
      targetId: campaign.id,
      action: 'activate',
      requestedByInternalUserId: user.id,
    },
  });
  return {
    location: location.id,
    category: category.id,
    product: product.id,
    menu: menu.id,
    customer: customer.id,
    payment: payment.id,
    order: order.id,
    line: line.id,
    user: user.id,
    role: role.id,
    assignment: assignment.id,
    media: media.id,
    page: page.id,
    campaign: campaign.id,
    promotion: promotion.id,
    redemption: redemption.id,
    audit: audit.id,
    outbox: outbox.id,
    approval: approval.id,
  };
}

// A checksum of every row in every table: proves the checker wrote nothing.
async function databaseChecksum(url: string): Promise<string> {
  return withScratchClient(url, async (client) => {
    const { rows: tables } = await client.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
    );
    const parts: string[] = [];
    for (const { name } of tables) {
      const { rows } = await client.query<{ sum: string }>(
        `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS sum FROM "${name}" t`,
      );
      parts.push(`${name}:${rows[0].sum}`);
    }
    return parts.join(',');
  });
}

const summarize = (report: TenantIntegrityReport) =>
  report.findings
    .map(
      (f) =>
        `${f.severity} ${f.relationshipId} ${f.type}${f.detail ? ` [${f.detail}]` : ''} x${f.count}`,
    )
    .sort();

describe('Tenant relationship integrity checker (Security 4C-1)', () => {
  let scratch: ScratchDatabase;
  let prisma: PrismaClient;
  let a: Ids;
  let b: Ids;

  const check = (options: Parameters<typeof checkTenantIntegrity>[1] = {}) =>
    withScratchClient(scratch.url, (client) =>
      checkTenantIntegrity(client, options),
    );

  beforeAll(async () => {
    scratch = await createScratchDatabase(baseUrl, 'integrity');
    await applyMigrations(
      scratch.url,
      listMigrations(join(repoRoot, 'packages/database/prisma/migrations')),
    );
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: scratch.url }),
    });
    await prisma.tenant.create({
      data: {
        id: B,
        slug: 'test-tenant-b',
        name: 'Test Tenant B',
        status: 'ACTIVE',
      },
    });
    a = await business(prisma, A, 'a');
    b = await business(prisma, B, 'b');
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await scratch?.drop();
  });

  it('every existing foreign key in the migrated schema matches the inventory (name, columns, delete rule)', async () => {
    const actions: Record<string, string> = {
      a: 'NoAction',
      r: 'Restrict',
      c: 'Cascade',
      n: 'SetNull',
      d: 'SetDefault',
    };
    const rows = await withScratchClient(
      scratch.url,
      async (client) =>
        (
          await client.query<{
            child: string;
            col: string;
            parent: string;
            action: string;
          }>(
            `SELECT cl.relname AS child, a.attname AS col, pcl.relname AS parent,
                  c.confdeltype AS action
             FROM pg_constraint c
             JOIN pg_class cl ON cl.oid = c.conrelid
             JOIN pg_class pcl ON pcl.oid = c.confrelid
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
            WHERE c.contype = 'f' AND pcl.relname <> 'Tenant'
              AND cl.relnamespace = 'public'::regnamespace`,
          )
        ).rows,
    );
    const inDatabase = rows
      .map((r) => `${r.child}.${r.col}->${r.parent} ${actions[r.action]}`)
      .sort();
    const inInventory = TENANT_RELATIONSHIPS.filter(
      (r): r is DirectReference =>
        (r.kind === 'composite-fk-candidate' ||
          r.kind === 'historical-snapshot') &&
        r.hasForeignKey,
    )
      .map((r) => `${r.id}->${r.target} ${r.onDelete}`)
      .sort();
    expect(inDatabase).toEqual(inInventory);
  });

  it('a clean two-business database has zero findings', async () => {
    const report = await check();
    expect(summarize(report)).toEqual([]);
    expect(report.violations).toBe(0);
    expect(report.warnings).toBe(0);
    expect(report.relationshipsChecked).toBe(100);
    expect(report.notCheckable.map((n) => n.id).sort()).toEqual([
      'InternalAuditEvent.afterData',
      'InternalAuditEvent.beforeData',
      'NotificationDelivery.providerMessageId',
      'OrderLine.selections',
      'OutboxEvent.payload',
    ]);
  });

  describe('with deliberately planted bad references', () => {
    const missingId = '01a0db02-f800-7000-8000-00000000beef';
    let report: TenantIntegrityReport;
    let before: string;
    const statements: string[] = [];
    let readOnlyInsideCheck: string | undefined;

    beforeAll(async () => {
      // Composite-FK candidates with a real foreign key (required and
      // optional), including a join table with a composite primary key.
      await prisma.order.update({
        where: { id: a.order },
        data: { locationId: b.location, customerId: b.customer },
      });
      await prisma.menuProduct.update({
        where: { menuId_productId: { menuId: a.menu, productId: a.product } },
        data: { productId: b.product },
      });
      // Composite-FK candidates without a foreign key: cross and missing.
      await prisma.paymentAttempt.update({
        where: { id: a.payment },
        data: { locationId: b.location },
      });
      await prisma.paymentAttempt.update({
        where: { id: b.payment },
        data: { locationId: missingId },
      });
      await prisma.campaign.update({
        where: { id: a.campaign },
        data: { mediaAssetId: b.media },
      });
      await prisma.orderPromotionRedemption.update({
        where: { id: a.redemption },
        data: { customerId: b.customer, sourcePromotionId: b.promotion },
      });
      // Historical snapshots: cross (violation) and missing (warning).
      await prisma.orderLine.update({
        where: { id: a.line },
        data: { productId: b.product },
      });
      await prisma.orderLine.update({
        where: { id: b.line },
        data: { productId: missingId },
      });
      // Polymorphic: staff scope (cross, CORPORATE with an id, LOCATION
      // without one), audit target (cross, unknown type), approval target,
      // outbox aggregate.
      await prisma.internalUserRoleAssignment.update({
        where: { id: a.assignment },
        data: { scopeId: b.location },
      });
      const role2 = await prisma.internalRole.create({
        data: { tenantId: A, key: 'a-role-2', displayName: 'A Role 2' },
      });
      const role3 = await prisma.internalRole.create({
        data: { tenantId: A, key: 'a-role-3', displayName: 'A Role 3' },
      });
      await prisma.internalUserRoleAssignment.create({
        data: {
          tenantId: A,
          internalUserId: a.user,
          roleId: role2.id,
          scopeType: 'CORPORATE',
          scopeId: a.location,
        },
      });
      await prisma.internalUserRoleAssignment.create({
        data: {
          tenantId: A,
          internalUserId: a.user,
          roleId: role3.id,
          scopeType: 'LOCATION',
          scopeId: null,
        },
      });
      await prisma.internalAuditEvent.update({
        where: { id: a.audit },
        data: { targetId: b.customer },
      });
      await prisma.internalAuditEvent.create({
        data: {
          tenantId: A,
          actorInternalUserId: a.user,
          action: 'mystery.done',
          targetType: 'mystery_type',
          targetId: a.customer,
          reason: 'fixture',
        },
      });
      await prisma.approvalRequest.update({
        where: { id: a.approval },
        // A different action: pending approvals are unique per target+action.
        data: { targetId: b.campaign, action: 'deactivate' },
      });
      await prisma.outboxEvent.update({
        where: { id: a.outbox },
        data: { aggregateId: b.order },
      });
      // JSON media references: cross (draft) and missing (published).
      await prisma.cmsPage.update({
        where: { id: a.page },
        data: {
          draftContent: { hero: { backgroundImageId: b.media } },
          publishedContent: { hero: { backgroundImageId: missingId } },
        },
      });

      before = await databaseChecksum(scratch.url);
      report = await withScratchClient(scratch.url, (client) => {
        const recording: IntegrityQueryable = {
          query: async (text: string, values?: unknown[]) => {
            statements.push(text.trim().split(/\s+/)[0].toUpperCase());
            if (text.startsWith('SET LOCAL')) {
              const { rows } = await client.query<{ ro: string }>(
                `SELECT current_setting('transaction_read_only') AS ro`,
              );
              readOnlyInsideCheck = rows[0].ro;
            }
            return client.query(text, values) as never;
          },
        };
        return checkTenantIntegrity(recording, { sampleLimit: 10 });
      });
    });

    it('detects every planted reference, attributed to the right relationship and type', () => {
      expect(summarize(report)).toEqual(
        [
          'violation ApprovalRequest.targetId cross-tenant [Campaign] x1',
          'violation Campaign.mediaAssetId cross-tenant x1',
          'violation CmsPage.draftContent cross-tenant [hero.backgroundImageId] x1',
          'violation CmsPage.publishedContent missing-target [hero.backgroundImageId] x1',
          'violation InternalAuditEvent.targetId cross-tenant [customer] x1',
          'violation InternalUserRoleAssignment.scopeId cross-tenant [LOCATION] x1',
          'violation InternalUserRoleAssignment.scopeId invalid-reference [CORPORATE must not carry an id] x1',
          'violation InternalUserRoleAssignment.scopeId missing-required [LOCATION requires an id] x1',
          'violation MenuProduct.productId cross-tenant x1',
          'violation Order.customerId cross-tenant x1',
          'violation Order.locationId cross-tenant x1',
          'violation OrderLine.productId cross-tenant x1',
          'violation OrderPromotionRedemption.customerId cross-tenant x1',
          'violation OrderPromotionRedemption.sourcePromotionId cross-tenant x1',
          'violation OutboxEvent.aggregateId cross-tenant [Order] x1',
          'violation PaymentAttempt.locationId cross-tenant x1',
          'violation PaymentAttempt.locationId missing-target x1',
          'warning InternalAuditEvent.targetId unresolved-type [mystery_type] x1',
          'warning OrderLine.productId missing-target x1',
        ].sort(),
      );
      expect(report.violations).toBe(17);
      expect(report.warnings).toBe(2);
    });

    it('summarizes violations by relationship type', () => {
      expect(report.byKind).toEqual({
        'composite-fk-candidate': {
          relationships: 85,
          checked: 85,
          violations: 7,
          warnings: 0,
        },
        'historical-snapshot': {
          relationships: 8,
          checked: 8,
          violations: 2,
          warnings: 1,
        },
        polymorphic: {
          relationships: 5,
          checked: 5,
          violations: 6,
          warnings: 1,
        },
        'json-reference': {
          relationships: 6,
          checked: 2,
          violations: 2,
          warnings: 0,
        },
        'external-identifier': {
          relationships: 1,
          checked: 0,
          violations: 0,
          warnings: 0,
        },
      });
    });

    it('identifies offending rows by primary key only (composite keys included)', () => {
      const keys = (id: string, type: string) =>
        report.findings.find((f) => f.relationshipId === id && f.type === type)
          ?.sampleKeys;
      expect(keys('Order.locationId', 'cross-tenant')).toEqual([a.order]);
      expect(keys('MenuProduct.productId', 'cross-tenant')).toEqual([
        `${a.menu}:${b.product}`,
      ]);
      expect(keys('PaymentAttempt.locationId', 'missing-target')).toEqual([
        b.payment,
      ]);
      expect(keys('CmsPage.draftContent', 'cross-tenant')).toEqual([a.page]);
      const serialized = JSON.stringify(report);
      for (const secret of [...PRIVATE_MARKERS, 'a-subject', 'b-subject']) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).not.toContain(scratch.url);
    });

    it('modifies nothing and runs entirely inside a READ ONLY transaction', async () => {
      expect(await databaseChecksum(scratch.url)).toBe(before);
      expect(readOnlyInsideCheck).toBe('on');
      expect(new Set(statements)).toEqual(
        new Set(['BEGIN', 'SET', 'SELECT', 'ROLLBACK']),
      );
      expect(statements[0]).toBe('BEGIN');
      expect(statements[statements.length - 1]).toBe('ROLLBACK');
    });

    it('reports without samples when asked to', async () => {
      const quiet = await check({ sampleLimit: 0 });
      expect(quiet.violations).toBe(17);
      expect(quiet.findings.every((f) => f.sampleKeys.length === 0)).toBe(true);
    });

    it('the CLI exits 1 on violations, prints the summary, and never prints the connection string', async () => {
      const run = promisify(execFile);
      const result = await run(
        'pnpm',
        [
          '--filter',
          '@mocha-house/database',
          '-s',
          'integrity:check',
          '--samples',
          '0',
        ],
        { cwd: repoRoot, env: { ...process.env, DATABASE_URL: scratch.url } },
      ).then(
        (r) => ({ code: 0, out: r.stdout }),
        (e: { code: number; stdout: string }) => ({
          code: e.code,
          out: e.stdout,
        }),
      );
      expect(result.code).toBe(1);
      expect(result.out).toContain('17 violation(s), 2 warning(s)');
      expect(result.out).toContain('Order.locationId cross-tenant: 1');
      const url = new URL(scratch.url);
      expect(result.out).not.toContain(scratch.url);
      expect(result.out).not.toContain(`${url.username}:${url.password}@`);
      expect(result.out).not.toContain(`${url.hostname}:${url.port}`);
      expect(result.out).not.toContain(url.pathname.slice(1));
    });
  });
});
