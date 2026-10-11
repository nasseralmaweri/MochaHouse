import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Client } from 'pg';
import {
  PrismaClient,
  TENANT_1_MOCHA_HOUSE_ID,
  TENANT_RELATIONSHIPS,
  checkTenantIntegrity,
  type DirectReference,
} from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  TEST_TENANT_C_ID,
  applyMigrations,
  createMigrationProject,
  createScratchDatabase,
  databaseCatalog,
  isAppliedAtomically,
  listMigrations,
  prismaCli,
  withScratchClient,
  type ExtraMigration,
  type MigrationProject,
  type ScratchDatabase,
} from '@mocha-house/testing';

// Security 4C-4 — PostgreSQL-enforced tenant isolation for loyalty, gift
// cards and promotions:
//   - seventeen composite foreign keys ("tenantId", <column>) -> parent
//     ("tenantId", "id") (sixteen replaced, OrderPromotionRedemption.customerId
//     new), with every SET NULL clearing only its column;
//   - seven historical snapshots: a new or changed value must name an
//     existing record of the same business; a value kept unchanged may
//     outlive its deleted source, whose id another business can then never
//     take (gift card, promotion, reward and bonus-promotion sources);
//   - fourteen tables whose rows can never move to another business.
//
// With three fictional businesses (A = Mocha House, B and C = test
// businesses) this spec proves: the schema, inventory, migration and
// rollback agree; the configured test database enforces everything, and a
// removed key or trigger is detected; same-business writes work; every
// cross-business reference, snapshot and move is rejected by PostgreSQL —
// by direct SQL and by Prisma writes (nested connect / set / disconnect /
// connectOrCreate, upsert, updateMany) — without changing any balance,
// ledger or transaction history; delete behaviour is unchanged; the
// integrity checker reports CLEAN; and the migration, run by the REAL
// `prisma migrate deploy`, aborts on mismatched rows before changing
// anything, is atomic, fails fast on locks, leaves no drift, and its
// rollback restores the previous catalog exactly. All data is fictional.

jest.setTimeout(600_000);

const repoRoot = join(__dirname, '../../../..');
const databaseDir = join(repoRoot, 'packages/database');
const migrationsDir = join(databaseDir, 'prisma/migrations');
const MIGRATION = '20261013090000_tenant_fk_loyalty_giftcard_promotion';
const PREVIOUS = '20261012090000_tenant_fk_customer_order_payment';
const migrations = listMigrations(migrationsDir);
const targetIndex = migrations.findIndex((m) => m.name === MIGRATION);
const target = migrations[targetIndex];
const rollbackSql = readFileSync(
  join(databaseDir, `prisma/rollbacks/${MIGRATION}.down.sql`),
  'utf8',
);
const previousRollbackSql = readFileSync(
  join(databaseDir, `prisma/rollbacks/${PREVIOUS}.down.sql`),
  'utf8',
);
const schema = readFileSync(join(databaseDir, 'prisma/schema.prisma'), 'utf8');
const baseUrl = process.env.DATABASE_URL!;

type Tag = 'a' | 'b' | 'c';
const TAGS: Tag[] = ['a', 'b', 'c'];
const TENANTS: Record<Tag, string> = {
  a: TENANT_1_MOCHA_HOUSE_ID,
  b: TEST_TENANT_B_ID,
  c: TEST_TENANT_C_ID,
};
const PAIRS: Array<[Tag, Tag]> = TAGS.flatMap((x) =>
  TAGS.filter((y) => y !== x).map((y) => [x, y] as [Tag, Tag]),
);

// Deterministic fictional ids, so two databases hold identical rows.
const id = (tag: Tag, name: string) => `lg-${tag}-${name}`;

type OnDelete = 'CASCADE' | 'RESTRICT' | 'SET NULL';

interface Relationship {
  readonly child: string;
  readonly column: string;
  readonly parent: string;
  readonly onDelete: OnDelete;
  readonly optional: boolean;
  // The fixture row of the child, and the unused parent of each business it
  // is pointed at (so no other unique constraint can fire first).
  readonly childRow: string;
  readonly spareParent: string;
  // Other columns a copied row must change to stay unique (values are
  // fixture names of the SAME business, '=literal' values, or null).
  readonly copy?: Readonly<Record<string, string | null>>;
}

const RELATIONSHIPS: readonly Relationship[] = [
  {
    child: 'CustomerLoyaltyAccount',
    column: 'customerId',
    parent: 'Customer',
    onDelete: 'CASCADE',
    optional: false,
    childRow: 'loyalty',
    spareParent: 'customer-spare',
  },
  {
    child: 'MochaBeanLedgerEntry',
    column: 'loyaltyAccountId',
    parent: 'CustomerLoyaltyAccount',
    onDelete: 'CASCADE',
    optional: false,
    childRow: 'ledger',
    spareParent: 'loyalty-2',
    copy: { orderId: null },
  },
  {
    child: 'MochaBeanLedgerEntry',
    column: 'orderId',
    parent: 'Order',
    onDelete: 'SET NULL',
    optional: true,
    childRow: 'ledger',
    spareParent: 'order-2',
  },
  {
    child: 'OrderLoyaltyRewardRedemption',
    column: 'orderId',
    parent: 'Order',
    onDelete: 'RESTRICT',
    optional: false,
    childRow: 'reward-redemption',
    spareParent: 'order-2',
  },
  {
    child: 'OrderLoyaltyBonus',
    column: 'orderId',
    parent: 'Order',
    onDelete: 'RESTRICT',
    optional: false,
    childRow: 'bonus',
    spareParent: 'order-2',
  },
  {
    child: 'OrderLoyaltyBonusItem',
    column: 'orderLoyaltyBonusId',
    parent: 'OrderLoyaltyBonus',
    onDelete: 'CASCADE',
    optional: false,
    childRow: 'bonus-item',
    spareParent: 'bonus-2',
  },
  {
    child: 'PromotionCustomerUsage',
    column: 'promotionId',
    parent: 'Promotion',
    onDelete: 'CASCADE',
    optional: false,
    childRow: 'usage',
    spareParent: 'promo-spare',
  },
  {
    child: 'PromotionCustomerUsage',
    column: 'customerId',
    parent: 'Customer',
    onDelete: 'CASCADE',
    optional: false,
    childRow: 'usage',
    spareParent: 'customer-spare',
  },
  {
    child: 'OrderPromotionRedemption',
    column: 'orderId',
    parent: 'Order',
    onDelete: 'RESTRICT',
    optional: false,
    childRow: 'promo-redemption',
    spareParent: 'order-2',
  },
  {
    child: 'OrderPromotionRedemption',
    column: 'customerId',
    parent: 'Customer',
    onDelete: 'SET NULL',
    optional: true,
    childRow: 'promo-redemption',
    spareParent: 'customer-spare',
    copy: { orderId: 'order-2' },
  },
  {
    child: 'GiftCardTransaction',
    column: 'giftCardId',
    parent: 'GiftCard',
    onDelete: 'RESTRICT',
    optional: false,
    childRow: 'gc-tx',
    spareParent: 'card-spare',
    // One ISSUANCE per card: copies are adjustments.
    copy: { type: '=ADJUSTMENT' },
  },
  {
    child: 'GiftCardTransaction',
    column: 'orderId',
    parent: 'Order',
    onDelete: 'SET NULL',
    optional: true,
    childRow: 'gc-tx',
    spareParent: 'order-2',
    // One ISSUANCE per card: copies are adjustments.
    copy: { type: '=ADJUSTMENT' },
  },
  {
    child: 'GiftCardTransaction',
    column: 'giftCardPurchaseId',
    parent: 'GiftCardPurchase',
    onDelete: 'SET NULL',
    optional: true,
    childRow: 'gc-tx',
    spareParent: 'purchase-2',
    // One ISSUANCE per card: copies are adjustments.
    copy: { type: '=ADJUSTMENT' },
  },
  {
    child: 'OrderGiftCardRedemption',
    column: 'orderId',
    parent: 'Order',
    onDelete: 'RESTRICT',
    optional: false,
    childRow: 'gc-redemption',
    spareParent: 'order-2',
  },
  {
    child: 'GiftCardPurchase',
    column: 'paymentAttemptId',
    parent: 'PaymentAttempt',
    onDelete: 'RESTRICT',
    optional: false,
    childRow: 'purchase',
    spareParent: 'pay-gc-spare',
    copy: { giftCardId: null },
  },
  {
    child: 'GiftCardPurchase',
    column: 'giftCardId',
    parent: 'GiftCard',
    onDelete: 'RESTRICT',
    optional: true,
    childRow: 'purchase',
    spareParent: 'card-spare',
    copy: { paymentAttemptId: 'pay-gc-spare' },
  },
  {
    child: 'GiftCardPurchase',
    column: 'customerId',
    parent: 'Customer',
    onDelete: 'SET NULL',
    optional: true,
    childRow: 'purchase',
    spareParent: 'customer-spare',
    copy: { paymentAttemptId: 'pay-gc-spare', giftCardId: null },
  },
];
const relationshipId = (r: Relationship) => `${r.child}.${r.column}`;
const constraintName = (r: Relationship) =>
  `${r.child}_tenantId_${r.column}_fkey`;
const deleteRule = (r: Relationship) =>
  r.onDelete === 'SET NULL' ? `SET NULL ("${r.column}")` : r.onDelete;

// Historical snapshots: no foreign key (the source may later be deleted),
// but a written value may never name another business's record.
interface Snapshot {
  readonly child: string;
  readonly column: string;
  readonly target: string;
  readonly childRow: string;
  readonly spareTarget: string;
}
const SNAPSHOTS: readonly Snapshot[] = [
  {
    child: 'OrderLoyaltyRewardRedemption',
    column: 'sourceRewardId',
    target: 'LoyaltyReward',
    childRow: 'reward-redemption',
    spareTarget: 'reward-2',
  },
  {
    child: 'OrderLoyaltyRewardRedemption',
    column: 'freeItemProductId',
    target: 'Product',
    childRow: 'reward-redemption',
    spareTarget: 'product-2',
  },
  {
    child: 'OrderLoyaltyBonusItem',
    column: 'sourcePromotionId',
    target: 'LoyaltyBonusPromotion',
    childRow: 'bonus-item',
    spareTarget: 'bonus-promo-2',
  },
  {
    child: 'OrderLoyaltyBonusItem',
    column: 'productId',
    target: 'Product',
    childRow: 'bonus-item',
    spareTarget: 'product-2',
  },
  {
    child: 'OrderPromotionRedemption',
    column: 'sourcePromotionId',
    target: 'Promotion',
    childRow: 'promo-redemption',
    spareTarget: 'promo-spare',
  },
  {
    child: 'OrderPromotionRedemption',
    column: 'freeItemProductId',
    target: 'Product',
    childRow: 'promo-redemption',
    spareTarget: 'product-2',
  },
  {
    child: 'OrderGiftCardRedemption',
    column: 'sourceGiftCardId',
    target: 'GiftCard',
    childRow: 'gc-redemption',
    spareTarget: 'card-spare',
  },
];

// Tables whose rows never change business: the referencing tables plus the
// gift card, promotion, reward and bonus-promotion parents (customers,
// orders and payment attempts are protected since Security 4C-3).
const PROTECTED_TABLES = [
  ...new Set([
    ...RELATIONSHIPS.map((r) => r.child),
    'GiftCard',
    'Promotion',
    'LoyaltyReward',
    'LoyaltyBonusPromotion',
  ]),
].sort();

const EXPECTED_FOREIGN_KEYS = RELATIONSHIPS.map(
  (r) =>
    `${constraintName(r)}: FOREIGN KEY ("tenantId", "${r.column}") REFERENCES "${r.parent}"("tenantId", id) ON UPDATE RESTRICT ON DELETE ${deleteRule(r)}`,
).sort();
const EXPECTED_IMMUTABILITY = PROTECTED_TABLES.map(
  (t) =>
    `trigger: CREATE TRIGGER "${t}_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON public."${t}" FOR EACH ROW WHEN ((old."tenantId" IS DISTINCT FROM new."tenantId")) EXECUTE FUNCTION reject_tenant_reassignment()`,
).sort();
const snapshotTrigger = (s: Snapshot) => `${s.child}_${s.column}_same_tenant`;
const EXPECTED_SNAPSHOT_TRIGGERS = [...SNAPSHOTS]
  .sort((x, y) =>
    snapshotTrigger(x) < snapshotTrigger(y)
      ? -1
      : snapshotTrigger(x) > snapshotTrigger(y)
        ? 1
        : 0,
  )
  .map(
    (s) =>
      `trigger: CREATE TRIGGER "${snapshotTrigger(s)}" BEFORE INSERT OR UPDATE OF "${s.column}" ON public."${s.child}" FOR EACH ROW EXECUTE FUNCTION reject_cross_tenant_snapshot('${s.column}', '${s.target}')`,
  );
// Snapshot sources whose deleted id another business can never take while
// a kept snapshot still names it (Product follows with the catalog, 4C-6).
const REUSE_GUARDED = SNAPSHOTS.filter((s) => s.target !== 'Product');
const EXPECTED_REUSE_TRIGGERS = [...REUSE_GUARDED]
  .sort((x, y) => (x.target < y.target ? -1 : x.target > y.target ? 1 : 0))
  .map(
    (s) =>
      `trigger: CREATE TRIGGER "${s.target}_id_not_reused" BEFORE INSERT OR UPDATE OF id ON public."${s.target}" FOR EACH ROW EXECUTE FUNCTION reject_reused_snapshot_source('${s.child}', '${s.column}')`,
  );
const EXPECTED_ENFORCEMENT = [
  ...EXPECTED_FOREIGN_KEYS,
  ...EXPECTED_IMMUTABILITY,
  ...EXPECTED_SNAPSHOT_TRIGGERS,
  ...EXPECTED_REUSE_TRIGGERS,
];

// A new source row of business `tag` with the given id, by direct SQL.
const insertSource = (target: string, sourceId: string, tag: Tag) => {
  const t = TENANTS[tag];
  const columns: Record<string, string> = {
    GiftCard: `("id", "tenantId", "codeHash", "last4", "originalValueMinorUnits", "updatedAt") VALUES ('${sourceId}', '${t}', 'reuse-${tag}-${sourceId}', '0000', 1, now())`,
    LoyaltyReward: `("id", "tenantId", "name", "type", "beanCost", "updatedAt") VALUES ('${sourceId}', '${t}', 'Reused', 'FIXED_AMOUNT', 1, now())`,
    LoyaltyBonusPromotion: `("id", "tenantId", "name", "type", "bonusValue", "updatedAt") VALUES ('${sourceId}', '${t}', 'Reused', 'EXTRA_BEANS', 1, now())`,
    Promotion: `("id", "tenantId", "name", "kind", "discountType", "updatedAt") VALUES ('${sourceId}', '${t}', 'Reused', 'AUTOMATIC', 'PERCENTAGE_OFF', now())`,
    Product: `("id", "tenantId", "name", "slug", "categoryId", "updatedAt") VALUES ('${sourceId}', '${t}', 'Reused', 'reuse-${tag}-${sourceId}', '${id(tag, 'category')}', now())`,
  };
  return `INSERT INTO "${target}" ${columns[target]}`;
};

// Every foreign key on the seventeen referencing columns, every ownership
// trigger on the fourteen protected tables, then every snapshot and id-reuse
// trigger — as PostgreSQL defines them. Exactly EXPECTED_ENFORCEMENT means: composite,
// on the right parent key, the right delete action, no single-column key
// left behind, no row can move, and no snapshot can name another business.
async function tenantEnforcement(client: Client): Promise<string[]> {
  const tables = PROTECTED_TABLES.map((t) => `'"${t}"'`).join(', ');
  const keys = await client.query<{ d: string }>(
    `SELECT c.conname || ': ' || pg_get_constraintdef(c.oid) AS d
       FROM pg_constraint c
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
        AND EXISTS (
          SELECT 1 FROM unnest(c.conkey) k(n)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n
           WHERE (c.conrelid::regclass::text, a.attname::text) IN (${RELATIONSHIPS.map(
             (r) => `('"${r.child}"', '${r.column}')`,
           ).join(', ')})
        )
      ORDER BY c.conname COLLATE "C"`,
  );
  const triggers = async (fn: string) =>
    client.query<{ d: string }>(
      `SELECT 'trigger: ' || pg_get_triggerdef(t.oid) AS d
         FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal AND p.proname = '${fn}'
          AND t.tgrelid::regclass::text IN (${tables})
        ORDER BY t.tgname COLLATE "C"`,
    );
  const immutable = await triggers('reject_tenant_reassignment');
  const snapshots = await triggers('reject_cross_tenant_snapshot');
  const reuse = await triggers('reject_reused_snapshot_source');
  return [
    ...keys.rows,
    ...immutable.rows,
    ...snapshots.rows,
    ...reuse.rows,
  ].map((r) => r.d);
}

// Fictional data for one business: every relationship and snapshot in
// use, plus unused "spare" parents to point rows at. Unchecked creates with
// explicit ids, so the same rows load into a pre-4C-4 database too.
async function loadBusiness(prisma: PrismaClient, tag: Tag) {
  const tenantId = TENANTS[tag];
  const i = (name: string) => id(tag, name);
  await prisma.internalUser.create({
    data: {
      id: i('staff'),
      tenantId,
      externalProvider: 'dev',
      externalSubject: i('staff'),
      email: `${tag}.lg.staff@example.test`,
    },
  });
  await prisma.location.create({
    data: { id: i('location'), tenantId, name: 'Store', slug: i('location') },
  });
  await prisma.category.create({
    data: { id: i('category'), tenantId, name: 'Drinks', slug: i('category') },
  });
  for (const name of ['product', 'product-2']) {
    await prisma.product.create({
      data: {
        id: i(name),
        tenantId,
        name: 'Fictional Latte',
        slug: i(name),
        categoryId: i('category'),
      },
    });
  }
  for (const name of ['customer', 'customer-2', 'customer-spare']) {
    await prisma.customer.create({
      data: {
        id: i(name),
        tenantId,
        externalProvider: 'dev',
        externalSubject: i(name),
      },
    });
  }
  await prisma.customerLoyaltyAccount.create({
    data: {
      id: i('loyalty'),
      tenantId,
      customerId: i('customer'),
      balance: 250,
    },
  });
  await prisma.customerLoyaltyAccount.create({
    data: {
      id: i('loyalty-2'),
      tenantId,
      customerId: i('customer-2'),
      balance: 40,
    },
  });
  for (const name of [
    'pay',
    'pay-2',
    'pay-3',
    'pay-4',
    'pay-gc',
    'pay-gc-2',
    'pay-gc-spare',
  ]) {
    await prisma.paymentAttempt.create({
      data: {
        id: i(name),
        tenantId,
        idempotencyKey: i(name),
        provider: 'fake',
        amount: 500,
        currency: 'USD',
        locationId: name.startsWith('pay-gc') ? null : i('location'),
      },
    });
  }
  const orders: Array<[string, string, string | null]> = [
    ['order', 'pay', 'customer'],
    ['order-2', 'pay-2', null],
    ['order-3', 'pay-3', null],
    ['order-4', 'pay-4', null],
  ];
  for (const [name, pay, customer] of orders) {
    await prisma.order.create({
      data: {
        id: i(name),
        tenantId,
        orderNumber: i(name),
        accessToken: i(`${name}-token`),
        locationId: i('location'),
        customerId: customer ? i(customer) : null,
        paymentAttemptId: i(pay),
        guestName: 'Fictional Guest',
        guestPhone: '5550000000',
        currency: 'USD',
        subtotal: 500,
      },
    });
  }
  for (const name of ['reward', 'reward-2']) {
    await prisma.loyaltyReward.create({
      data: {
        id: i(name),
        tenantId,
        name: 'Free Latte',
        type: 'FREE_ITEM',
        beanCost: 100,
      },
    });
  }
  for (const name of ['bonus-promo', 'bonus-promo-2']) {
    await prisma.loyaltyBonusPromotion.create({
      data: {
        id: i(name),
        tenantId,
        name: 'Double Beans',
        type: 'MULTIPLIER',
        bonusValue: 2,
      },
    });
  }
  for (const name of ['promo', 'promo-spare']) {
    await prisma.promotion.create({
      data: {
        id: i(name),
        tenantId,
        name: 'Ten Off',
        kind: 'AUTOMATIC',
        discountType: 'PERCENTAGE_OFF',
      },
    });
  }
  await prisma.mochaBeanLedgerEntry.create({
    data: {
      id: i('ledger'),
      tenantId,
      loyaltyAccountId: i('loyalty'),
      type: 'EARN',
      amount: 50,
      orderId: i('order'),
    },
  });
  await prisma.mochaBeanLedgerEntry.create({
    data: {
      id: i('ledger-2'),
      tenantId,
      loyaltyAccountId: i('loyalty'),
      type: 'MANUAL_ADJUSTMENT',
      amount: 200,
      orderId: i('order-4'),
      operationKey: i('ledger-2'),
    },
  });
  await prisma.orderLoyaltyRewardRedemption.create({
    data: {
      id: i('reward-redemption'),
      tenantId,
      orderId: i('order'),
      sourceRewardId: i('reward'),
      rewardName: 'Free Latte',
      rewardType: 'FREE_ITEM',
      beanCost: 100,
      discountMinorUnits: 500,
      freeItemProductId: i('product'),
    },
  });
  for (const [name, order] of [
    ['bonus', 'order'],
    ['bonus-2', 'order-3'],
  ]) {
    await prisma.orderLoyaltyBonus.create({
      data: { id: i(name), tenantId, orderId: i(order), totalBonusBeans: 10 },
    });
  }
  await prisma.orderLoyaltyBonusItem.create({
    data: {
      id: i('bonus-item'),
      tenantId,
      orderLoyaltyBonusId: i('bonus'),
      sourcePromotionId: i('bonus-promo'),
      promotionName: 'Double Beans',
      promotionType: 'MULTIPLIER',
      bonusValue: 2,
      productId: i('product'),
      productName: 'Fictional Latte',
      qualifyingUnits: 1,
      qualifyingSpendMinorUnits: 500,
      standardBeansForItem: 10,
      bonusBeans: 10,
    },
  });
  await prisma.promotionCustomerUsage.create({
    data: {
      tenantId,
      promotionId: i('promo'),
      customerId: i('customer'),
      usedCount: 1,
    },
  });
  await prisma.orderPromotionRedemption.create({
    data: {
      id: i('promo-redemption'),
      tenantId,
      orderId: i('order'),
      sourcePromotionId: i('promo'),
      promotionName: 'Ten Off',
      promotionKind: 'AUTOMATIC',
      discountType: 'PERCENTAGE_OFF',
      discountValue: 10,
      discountMinorUnits: 50,
      freeItemProductId: i('product'),
      customerId: i('customer'),
    },
  });
  for (const name of ['card', 'card-2', 'card-spare']) {
    await prisma.giftCard.create({
      data: {
        id: i(name),
        tenantId,
        codeHash: i(name),
        last4: '1234',
        originalValueMinorUnits: 1000,
        balanceMinorUnits: 1000,
      },
    });
  }
  await prisma.giftCardPurchase.create({
    data: {
      id: i('purchase'),
      tenantId,
      amountMinorUnits: 1000,
      paymentAttemptId: i('pay-gc'),
      giftCardId: i('card'),
      customerId: i('customer'),
      purchaserEmail: `${tag}.buyer@example.test`,
      status: 'ISSUED',
    },
  });
  await prisma.giftCardPurchase.create({
    data: {
      id: i('purchase-2'),
      tenantId,
      amountMinorUnits: 1000,
      paymentAttemptId: i('pay-gc-2'),
      purchaserEmail: `${tag}.buyer2@example.test`,
    },
  });
  await prisma.giftCardTransaction.create({
    data: {
      id: i('gc-tx'),
      tenantId,
      giftCardId: i('card'),
      type: 'ISSUANCE',
      amountMinorUnits: 1000,
      balanceAfterMinorUnits: 1000,
      orderId: i('order'),
      giftCardPurchaseId: i('purchase'),
    },
  });
  await prisma.giftCardTransaction.create({
    data: {
      id: i('gc-tx-2'),
      tenantId,
      giftCardId: i('card'),
      type: 'ADJUSTMENT',
      amountMinorUnits: 0,
      balanceAfterMinorUnits: 1000,
      orderId: i('order-4'),
    },
  });
  await prisma.orderGiftCardRedemption.create({
    data: {
      id: i('gc-redemption'),
      tenantId,
      orderId: i('order'),
      sourceGiftCardId: i('card'),
      last4: '1234',
      amountMinorUnits: 300,
      currency: 'USD',
    },
  });
}

async function loadFixture(url: string) {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  try {
    for (const tag of ['b', 'c'] as const) {
      await prisma.tenant.create({
        data: {
          id: TENANTS[tag],
          slug: `test-tenant-${tag}`,
          name: `Test Tenant ${tag.toUpperCase()}`,
          status: 'ACTIVE',
        },
      });
    }
    for (const tag of TAGS) await loadBusiness(prisma, tag);
  } finally {
    await prisma.$disconnect();
  }
}

// A checksum of every row of every table (excluding Prisma's own history).
async function dataChecksum(url: string): Promise<string> {
  return withScratchClient(url, async (client) => {
    const { rows: tables } = await client.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY 1`,
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

// Balances, points ledgers and money histories, for asserting nothing moved.
async function financialState(url: string): Promise<string> {
  return withScratchClient(url, async (client) => {
    const { rows } = await client.query<{ s: string }>(
      `SELECT concat_ws(' | ',
         (SELECT string_agg(id || '=' || balance, ',' ORDER BY id) FROM "CustomerLoyaltyAccount"),
         (SELECT string_agg(id || '=' || "balanceMinorUnits", ',' ORDER BY id) FROM "GiftCard"),
         (SELECT count(*) || '/' || coalesce(sum(amount), 0) FROM "MochaBeanLedgerEntry"),
         (SELECT count(*) || '/' || coalesce(sum("amountMinorUnits"), 0) FROM "GiftCardTransaction"),
         (SELECT string_agg("promotionId" || ':' || "customerId" || '=' || "usedCount", ',' ORDER BY "promotionId", "customerId") FROM "PromotionCustomerUsage")
       ) AS s`,
    );
    return rows[0].s;
  });
}

// Runs `sql` in a transaction that is always rolled back; returns 'ok' or
// the PostgreSQL error code and constraint.
async function attempt(client: Client, sql: string): Promise<string> {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    return 'ok';
  } catch (error) {
    const e = error as { code?: string; constraint?: string };
    return `${e.code}${e.constraint ? ` ${e.constraint}` : ''}`;
  } finally {
    await client.query('ROLLBACK');
  }
}

// Runs `setup` (which must succeed), then each probe in its own savepoint,
// all inside a transaction that is always rolled back; returns 'ok' or the
// SQLSTATE per probe (a successful probe stays applied for the next one).
async function scenario(
  client: Client,
  setup: readonly string[],
  probes: readonly string[],
): Promise<string[]> {
  await client.query('BEGIN');
  try {
    for (const statement of setup) await client.query(statement);
    const out: string[] = [];
    for (const probe of probes) {
      await client.query('SAVEPOINT probe');
      try {
        await client.query(probe);
        await client.query('RELEASE SAVEPOINT probe');
        out.push('ok');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT probe');
        out.push(String((error as { code?: string }).code));
      }
    }
    return out;
  } finally {
    await client.query('ROLLBACK');
  }
}

// A rejected Prisma write as `<Prisma code>/<SQLSTATE>` — or 'accepted'.
const prismaOutcome = (write: Promise<unknown>) =>
  write.then(
    () => 'accepted',
    (e: {
      code?: string;
      meta?: { driverAdapterError?: { cause?: { originalCode?: string } } };
    }) => `${e.code}/${e.meta?.driverAdapterError?.cause?.originalCode ?? '-'}`,
  );

// The WHERE clause selecting a fixture row of business `tag`.
const rowWhere = (child: string, row: string, tag: Tag) =>
  child === 'PromotionCustomerUsage'
    ? `"promotionId" = '${id(tag, 'promo')}' AND "customerId" = '${id(tag, 'customer')}'`
    : `id = '${id(tag, row)}'`;

// A copy of the child row with a new id and the referencing column set to
// `parentId` — a direct-SQL INSERT whose only possible failure is the
// foreign key under test.
const insertCopy = (r: Relationship, from: Tag, parentId: string | null) => {
  const overrides: Record<string, string | null> = {
    id: `copy-${from}-${r.childRow}`,
    [r.column]: parentId,
  };
  for (const [column, value] of Object.entries(r.copy ?? {})) {
    overrides[column] =
      value === null
        ? null
        : value.startsWith('=')
          ? value.slice(1)
          : id(from, value);
  }
  return `INSERT INTO "${r.child}"
    SELECT (jsonb_populate_record(NULL::"${r.child}", to_jsonb(t) || '${JSON.stringify(overrides)}'::jsonb)).*
      FROM "${r.child}" t WHERE ${rowWhere(r.child, r.childRow, from)}`;
};

describe('Tenant-enforced loyalty, gift cards and promotions (Security 4C-4)', () => {
  it('the inventory marks exactly these seventeen relationships of the domain as tenant-enforced, with matching delete rules', () => {
    const ids = new Set(RELATIONSHIPS.map(relationshipId));
    const inScope = TENANT_RELATIONSHIPS.filter(
      (r): r is DirectReference =>
        r.kind === 'composite-fk-candidate' && ids.has(r.id),
    );
    const rule = {
      CASCADE: 'Cascade',
      RESTRICT: 'Restrict',
      'SET NULL': 'SetNull',
    } as const;
    expect(
      inScope
        .map(
          (r) =>
            `${r.id}->${r.target} ${r.onDelete} ${r.hasForeignKey} ${r.tenantEnforced}`,
        )
        .sort(),
    ).toEqual(
      RELATIONSHIPS.map(
        (r) =>
          `${relationshipId(r)}->${r.parent} ${rule[r.onDelete]} true true`,
      ).sort(),
    );
    // The snapshots stay historical (no foreign key) in the inventory.
    const snapshots = new Set(SNAPSHOTS.map((s) => `${s.child}.${s.column}`));
    expect(
      TENANT_RELATIONSHIPS.filter(
        (r) => r.kind === 'historical-snapshot' && snapshots.has(r.id),
      ).map((r) => `${r.id}->${(r as DirectReference).target}`),
    ).toEqual(
      expect.arrayContaining(
        SNAPSHOTS.map((s) => `${s.child}.${s.column}->${s.target}`),
      ),
    );
    expect(snapshots.size).toBe(7);
  });

  it('schema.prisma declares each as a (tenantId, column) -> (tenantId, id) relation with ON UPDATE RESTRICT', () => {
    const models = new Map(
      [...schema.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    const rule = {
      CASCADE: 'Cascade',
      RESTRICT: 'Restrict',
      'SET NULL': 'SetNull',
    } as const;
    for (const r of RELATIONSHIPS) {
      const relation = new RegExp(
        `^\\s+\\w+\\s+${r.parent}\\??\\s+@relation\\(fields: \\[tenantId, ${r.column}\\], references: \\[tenantId, id\\], onDelete: (\\w+), onUpdate: Restrict\\)`,
        'm',
      ).exec(models.get(r.child) ?? '');
      expect([relationshipId(r), relation?.[1]]).toEqual([
        relationshipId(r),
        rule[r.onDelete],
      ]);
    }
  });

  it('the migration is ONE DO block: version and 4C-3 checks, read-only preflight of every relationship and snapshot, lock_timeout, then the keys and triggers', () => {
    expect(targetIndex).toBeGreaterThan(0);
    expect(migrations[targetIndex - 1].name).toBe(PREVIOUS);
    const sql = target.sql;
    expect(isAppliedAtomically(sql)).toBe(true);
    const code = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .trim();
    expect(code).toMatch(
      /^DO \$tenant_fk_loyalty_giftcard_promotion\$[\s\S]*\$tenant_fk_loyalty_giftcard_promotion\$;$/,
    );
    const order = [
      "set_config('lock_timeout', '5s', true)",
      "current_setting('server_version_num')::int < 150000",
      "to_regprocedure('public.reject_tenant_reassignment()') IS NULL",
      ...RELATIONSHIPS.map(
        (r) => `('${r.child}', '${r.column}', '${r.parent}')`,
      ),
      ...SNAPSHOTS.map((s) => `('${s.child}', '${s.column}', '${s.target}')`),
      'Security 4C-4 aborted',
      'DROP CONSTRAINT',
      'CREATE UNIQUE INDEX',
      'ADD CONSTRAINT',
      'CREATE FUNCTION "reject_cross_tenant_snapshot"()',
      'CREATE TRIGGER',
      'CREATE FUNCTION "reject_reused_snapshot_source"()',
    ].map((s) => code.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    for (const r of RELATIONSHIPS) {
      expect(code).toContain(
        `ADD CONSTRAINT "${constraintName(r)}" FOREIGN KEY ("tenantId", "${r.column}") REFERENCES "${r.parent}"("tenantId", "id") ON DELETE ${deleteRule(r)} ON UPDATE RESTRICT;`,
      );
    }
    expect(code.match(/ADD CONSTRAINT/g)).toHaveLength(17);
    expect(code.match(/DROP CONSTRAINT/g)).toHaveLength(16);
    for (const t of PROTECTED_TABLES) {
      expect(code).toContain(
        `CREATE TRIGGER "${t}_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "${t}"`,
      );
    }
    for (const s of SNAPSHOTS) {
      expect(code).toContain(
        `CREATE TRIGGER "${snapshotTrigger(s)}" BEFORE INSERT OR UPDATE OF "${s.column}" ON "${s.child}"`,
      );
    }
    for (const s of REUSE_GUARDED) {
      expect(code).toContain(
        `CREATE TRIGGER "${s.target}_id_not_reused" BEFORE INSERT OR UPDATE OF "id" ON "${s.target}"`,
      );
    }
    expect(code.match(/CREATE TRIGGER/g)).toHaveLength(14 + 7 + 4);
    // A new or changed snapshot value needs an existing same-business
    // source; an unchanged one is kept.
    expect(code).toContain('must name an existing');
    expect(code).toContain(
      "TG_OP = 'UPDATE' AND ref IS NOT DISTINCT FROM to_jsonb(OLD) ->> TG_ARGV[0]",
    );
    // It reuses 4C-3's function and never creates or drops it.
    expect(code).not.toMatch(
      /(CREATE|DROP) FUNCTION "reject_tenant_reassignment"/,
    );
    expect(code).not.toMatch(
      /\bUPDATE\s+"|\bDELETE\s+FROM\b|\bINSERT\s+INTO\b|\bTRUNCATE\b/i,
    );
  });

  it('the rollback is ONE DO block that removes only what 4C-4 added and restores the sixteen original keys — keeping 4C-3’s function', () => {
    expect(isAppliedAtomically(rollbackSql)).toBe(true);
    expect(rollbackSql.match(/DROP TRIGGER/g)).toHaveLength(14 + 7 + 4);
    for (const t of PROTECTED_TABLES) {
      expect(rollbackSql).toContain(
        `DROP TRIGGER "${t}_tenantId_immutable" ON "${t}";`,
      );
    }
    for (const r of RELATIONSHIPS) {
      expect(rollbackSql).toContain(`DROP CONSTRAINT "${constraintName(r)}"`);
    }
    expect(rollbackSql.match(/ADD CONSTRAINT "\w+_fkey"/g)).toHaveLength(16);
    expect(rollbackSql).toContain(
      'DROP FUNCTION "reject_cross_tenant_snapshot"();',
    );
    expect(rollbackSql).toContain(
      'DROP FUNCTION "reject_reused_snapshot_source"();',
    );
    expect(rollbackSql).not.toMatch(
      /DROP FUNCTION "reject_tenant_reassignment"/,
    );
    expect(rollbackSql).not.toMatch(
      /\bUPDATE\s+"|\bDELETE\s+FROM\b|\bINSERT\s+INTO\b|\bTRUNCATE\b/i,
    );
  });

  it('the migrated test database enforces every relationship, ownership and snapshot (catalog regression guard)', async () => {
    expect(
      await withScratchClient(baseUrl, (client) => tenantEnforcement(client)),
    ).toEqual(EXPECTED_ENFORCEMENT);
  });

  describe('on a scratch database with three fictional businesses', () => {
    let scratch: ScratchDatabase;
    let prisma: PrismaClient;
    let beforeData: string;
    let beforeMoney: string;
    const sql = <T>(fn: (client: Client) => Promise<T>) =>
      withScratchClient(scratch.url, fn);

    beforeAll(async () => {
      scratch = await createScratchDatabase(baseUrl, 'fk_lgp');
      await applyMigrations(scratch.url, migrations);
      await loadFixture(scratch.url);
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: scratch.url }),
      });
      beforeData = await dataChecksum(scratch.url);
      beforeMoney = await financialState(scratch.url);
    });
    afterAll(async () => {
      await prisma?.$disconnect();
      await scratch?.drop();
    });

    it('carries exactly the expected keys and triggers', async () => {
      expect(await sql(tenantEnforcement)).toEqual(EXPECTED_ENFORCEMENT);
    });

    it('accepts same-business references, by UPDATE and by INSERT, for every relationship and business', async () => {
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const r of RELATIONSHIPS) {
          for (const x of TAGS) {
            const update = await attempt(
              client,
              `UPDATE "${r.child}" SET "${r.column}" = '${id(x, r.spareParent)}' WHERE ${rowWhere(r.child, r.childRow, x)}`,
            );
            const insert = await attempt(
              client,
              insertCopy(r, x, id(x, r.spareParent)),
            );
            out.push(`${relationshipId(r)} ${x}: ${update}/${insert}`);
          }
        }
        return out;
      });
      expect(results.filter((s) => !s.endsWith(': ok/ok'))).toEqual([]);
      expect(results).toHaveLength(17 * 3);
    });

    it('rejects every cross-business reference by direct SQL — every relationship, every ordered pair, UPDATE and INSERT', async () => {
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const r of RELATIONSHIPS) {
          for (const [x, y] of PAIRS) {
            const expected = `23503 ${constraintName(r)}`;
            const update = await attempt(
              client,
              `UPDATE "${r.child}" SET "${r.column}" = '${id(y, r.spareParent)}' WHERE ${rowWhere(r.child, r.childRow, x)}`,
            );
            const insert = await attempt(
              client,
              insertCopy(r, x, id(y, r.spareParent)),
            );
            if (update !== expected || insert !== expected) {
              out.push(`${relationshipId(r)} ${x}->${y}: ${update}/${insert}`);
            }
          }
        }
        return out;
      });
      expect(results).toEqual([]);
    });

    it('rejects a reference to a record that does not exist', async () => {
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const r of RELATIONSHIPS) {
          out.push(
            await attempt(
              client,
              `UPDATE "${r.child}" SET "${r.column}" = 'lg-missing' WHERE ${rowWhere(r.child, r.childRow, 'b')}`,
            ),
          );
        }
        return out;
      });
      expect(results).toEqual(
        RELATIONSHIPS.map((r) => `23503 ${constraintName(r)}`),
      );
    });

    it('optional references may be NULL; required ones still may not', async () => {
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const r of RELATIONSHIPS) {
          const result = await attempt(
            client,
            `UPDATE "${r.child}" SET "${r.column}" = NULL WHERE ${rowWhere(r.child, r.childRow, 'c')}`,
          );
          out.push(`${relationshipId(r)}: ${result.split(' ')[0]}`);
        }
        return out;
      });
      expect(results).toEqual(
        RELATIONSHIPS.map(
          (r) => `${relationshipId(r)}: ${r.optional ? 'ok' : '23502'}`,
        ),
      );
    });

    // A copy of a snapshot row (new id, own order-2 where the order is
    // unique) with the snapshot column set to `value`.
    const snapshotCopy = (s: Snapshot, x: Tag, value: string) =>
      `INSERT INTO "${s.child}"
         SELECT (jsonb_populate_record(NULL::"${s.child}", to_jsonb(t) || '${JSON.stringify(
           {
             id: `copy-${x}-${s.childRow}`,
             [s.column]: value,
             ...(s.child === 'OrderLoyaltyBonusItem'
               ? {}
               : { orderId: id(x, 'order-2') }),
           },
         )}'::jsonb)).*
         FROM "${s.child}" t WHERE id = '${id(x, s.childRow)}'`;
    const setSnapshot = (s: Snapshot, x: Tag, value: string | null) =>
      `UPDATE "${s.child}" SET "${s.column}" = ${value === null ? 'NULL' : `'${value}'`} WHERE id = '${id(x, s.childRow)}'`;

    it('a new or changed snapshot must name an existing record of the same business (INSERT and UPDATE, every business and pair)', async () => {
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const s of SNAPSHOTS) {
          for (const x of TAGS) {
            const outcomes = [
              await attempt(client, setSnapshot(s, x, id(x, s.spareTarget))),
              await attempt(client, snapshotCopy(s, x, id(x, s.spareTarget))),
              await attempt(client, setSnapshot(s, x, 'lg-missing')),
              await attempt(client, snapshotCopy(s, x, 'lg-missing')),
              s.column === 'productId'
                ? 'ok'
                : await attempt(client, setSnapshot(s, x, null)),
            ];
            const expected = ['ok', 'ok', '23503', '23503', 'ok'];
            if (outcomes.join() !== expected.join()) {
              out.push(`${s.child}.${s.column} ${x}: ${outcomes.join('/')}`);
            }
          }
          for (const [x, y] of PAIRS) {
            const update = await attempt(
              client,
              setSnapshot(s, x, id(y, s.spareTarget)),
            );
            const insert = await attempt(
              client,
              snapshotCopy(s, x, id(y, s.spareTarget)),
            );
            if (update !== '23503' || insert !== '23503') {
              out.push(
                `${s.child}.${s.column} ${x}->${y}: ${update}/${insert}`,
              );
            }
          }
        }
        return out;
      });
      expect(results).toEqual([]);
    });

    it('a snapshot kept unchanged outlives its deleted source; changing or re-pointing it does not', async () => {
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const s of SNAPSHOTS) {
          for (const [x, y] of PAIRS) {
            const deleted = id(x, s.spareTarget);
            const outcomes = await scenario(
              client,
              [
                // A valid same-business snapshot, then its source deleted.
                setSnapshot(s, x, deleted),
                `DELETE FROM "${s.target}" WHERE id = '${deleted}'`,
              ],
              [
                // Kept unchanged: rewriting the row or the same value.
                `UPDATE "${s.child}" SET "tenantId" = "tenantId" WHERE id = '${id(x, s.childRow)}'`,
                `UPDATE "${s.child}" SET "${s.column}" = "${s.column}" WHERE id = '${id(x, s.childRow)}'`,
                // Changed: to another missing id, to another business.
                setSnapshot(s, x, 'lg-missing'),
                setSnapshot(s, x, id(y, s.spareTarget)),
                // A new row naming the deleted source.
                snapshotCopy(s, x, deleted),
                // Cleared, then pointed back at the deleted source.
                ...(s.column === 'productId'
                  ? []
                  : [setSnapshot(s, x, null), setSnapshot(s, x, deleted)]),
              ],
            );
            const expected = [
              'ok',
              'ok',
              '23503',
              '23503',
              '23503',
              ...(s.column === 'productId' ? [] : ['ok', '23503']),
            ];
            if (outcomes.join() !== expected.join()) {
              out.push(
                `${s.child}.${s.column} ${x}/${y}: ${outcomes.join('/')}`,
              );
            }
          }
        }
        return out;
      });
      expect(results).toEqual([]);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('another business can never take a deleted source’s id while a kept snapshot names it (INSERT and id UPDATE); the same business can', async () => {
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const s of REUSE_GUARDED) {
          for (const [x, y] of PAIRS) {
            const deleted = id(x, s.spareTarget);
            const outcomes = await scenario(
              client,
              [
                setSnapshot(s, x, deleted),
                `DELETE FROM "${s.target}" WHERE id = '${deleted}'`,
              ],
              [
                insertSource(s.target, deleted, y),
                `UPDATE "${s.target}" SET id = '${deleted}' WHERE id = '${id(y, s.spareTarget)}'`,
                insertSource(s.target, deleted, x),
                `SELECT 1 FROM "${s.child}" c JOIN "${s.target}" p ON p.id = c."${s.column}"
                  WHERE c.id = '${id(x, s.childRow)}' AND p."tenantId" = '${TENANTS[x]}'`,
              ],
            );
            if (outcomes.join() !== '23505,23505,ok,ok') {
              out.push(`${s.target} ${x}->${y}: ${outcomes.join('/')}`);
            }
          }
          // An id no snapshot names is free to any business.
          const free = await scenario(
            client,
            [
              `DELETE FROM "${s.target}" WHERE id = '${id('a', s.spareTarget)}'`,
            ],
            [insertSource(s.target, id('a', s.spareTarget), 'b')],
          );
          if (free.join() !== 'ok')
            out.push(`${s.target} free id: ${free.join()}`);
        }
        return out;
      });
      expect(results).toEqual([]);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('Prisma writes naming a missing or foreign snapshot source are rejected, nested or not, and leave balances, ledgers, card transactions and usage counters unchanged', async () => {
      const outcomes: Record<string, string> = {};
      for (const [x, y] of PAIRS) {
        const X = (name: string) => id(x, name);
        const Y = (name: string) => id(y, name);
        for (const [label, source] of [
          ['missing', 'lg-missing'],
          ['foreign', ''],
        ] as const) {
          const pick = (foreign: string) =>
            label === 'missing' ? source : foreign;
          const writes: Record<string, () => Promise<unknown>> = {
            nestedPromotionRedemption: () =>
              prisma.order.update({
                where: { id: X('order-2') },
                data: {
                  promotionRedemption: {
                    create: {
                      sourcePromotionId: pick(Y('promo')),
                      promotionName: 'x',
                      promotionKind: 'COUPON',
                      discountType: 'FIXED_AMOUNT',
                      discountValue: 1,
                      discountMinorUnits: 1,
                    },
                  },
                },
              }),
            nestedBonusItem: () =>
              prisma.orderLoyaltyBonus.create({
                data: {
                  tenantId: TENANTS[x],
                  orderId: X('order-2'),
                  totalBonusBeans: 1,
                  items: {
                    create: {
                      sourcePromotionId: pick(Y('bonus-promo')),
                      promotionName: 'x',
                      promotionType: 'EXTRA_BEANS',
                      bonusValue: 1,
                      productId: X('product'),
                      productName: 'x',
                      qualifyingUnits: 1,
                      qualifyingSpendMinorUnits: 1,
                      standardBeansForItem: 1,
                      bonusBeans: 1,
                    },
                  },
                },
              }),
            nestedFreeItemProduct: () =>
              prisma.order.update({
                where: { id: X('order-2') },
                data: {
                  loyaltyRewardRedemption: {
                    create: {
                      sourceRewardId: X('reward'),
                      freeItemProductId: pick(Y('product')),
                      rewardName: 'x',
                      rewardType: 'FREE_ITEM',
                      beanCost: 1,
                      discountMinorUnits: 1,
                    },
                  },
                },
              }),
            giftCardRedemptionUpdate: () =>
              prisma.orderGiftCardRedemption.update({
                where: { id: X('gc-redemption') },
                data: { sourceGiftCardId: pick(Y('card')) },
              }),
            // A whole points/gift-card movement in one transaction whose
            // snapshot write fails: nothing of it may stay.
            pointsAndCardMovement: () =>
              prisma.$transaction(async (tx) => {
                await tx.customerLoyaltyAccount.update({
                  where: { id: X('loyalty') },
                  data: {
                    balance: { decrement: 100 },
                    entries: { create: { type: 'REDEEM', amount: -100 } },
                  },
                });
                await tx.giftCard.update({
                  where: { id: X('card') },
                  data: {
                    balanceMinorUnits: { decrement: 300 },
                    transactions: {
                      create: {
                        type: 'REDEMPTION',
                        amountMinorUnits: -300,
                        balanceAfterMinorUnits: 700,
                        orderId: X('order-2'),
                      },
                    },
                  },
                });
                await tx.promotionCustomerUsage.updateMany({
                  where: { promotionId: X('promo'), customerId: X('customer') },
                  data: { usedCount: { increment: 1 } },
                });
                await tx.orderGiftCardRedemption.create({
                  data: {
                    tenantId: TENANTS[x],
                    orderId: X('order-2'),
                    sourceGiftCardId: pick(Y('card')),
                    last4: '1234',
                    amountMinorUnits: 300,
                    currency: 'USD',
                  },
                });
              }),
          };
          for (const [name, write] of Object.entries(writes)) {
            outcomes[`${name} ${label} ${x}->${y}`] =
              await prismaOutcome(write());
          }
        }
      }
      expect(
        Object.entries(outcomes).filter(([, o]) => o !== 'P2003/23503'),
      ).toEqual([]);
      expect(Object.keys(outcomes)).toHaveLength(5 * 2 * 6);
      expect(await financialState(scratch.url)).toBe(beforeMoney);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('rejects moving any row of the fourteen protected tables to another business (immutable tenantId), referenced or not', async () => {
      const rows: Array<[string, string]> = [
        ['CustomerLoyaltyAccount', 'loyalty'],
        ['CustomerLoyaltyAccount', 'loyalty-2'],
        ['MochaBeanLedgerEntry', 'ledger'],
        ['OrderLoyaltyRewardRedemption', 'reward-redemption'],
        ['OrderLoyaltyBonus', 'bonus'],
        ['OrderLoyaltyBonus', 'bonus-2'],
        ['OrderLoyaltyBonusItem', 'bonus-item'],
        ['PromotionCustomerUsage', 'usage'],
        ['OrderPromotionRedemption', 'promo-redemption'],
        ['GiftCardTransaction', 'gc-tx'],
        ['OrderGiftCardRedemption', 'gc-redemption'],
        ['GiftCardPurchase', 'purchase'],
        ['GiftCardPurchase', 'purchase-2'],
        ['GiftCard', 'card'],
        ['GiftCard', 'card-spare'],
        ['Promotion', 'promo'],
        ['Promotion', 'promo-spare'],
        ['LoyaltyReward', 'reward'],
        ['LoyaltyReward', 'reward-2'],
        ['LoyaltyBonusPromotion', 'bonus-promo'],
        ['LoyaltyBonusPromotion', 'bonus-promo-2'],
      ];
      expect([...new Set(rows.map(([t]) => t))].sort()).toEqual(
        PROTECTED_TABLES,
      );
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const [table, row] of rows) {
          for (const [x, y] of PAIRS) {
            const result = await attempt(
              client,
              `UPDATE "${table}" SET "tenantId" = '${TENANTS[y]}' WHERE ${rowWhere(table, row, x)}`,
            );
            if (result !== '23001')
              out.push(`${table} ${row} ${x}->${y}: ${result}`);
          }
        }
        return out;
      });
      expect(results).toEqual([]);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('cross-business Prisma writes cannot attach, redeem, record or transfer anything — and no balance, ledger or transaction changes', async () => {
      const outcomes: Record<string, string> = {};
      for (const [x, y] of PAIRS) {
        const X = (name: string) => id(x, name);
        const Y = (name: string) => id(y, name);
        const tenantX = TENANTS[x];
        const writes: Record<string, () => Promise<unknown>> = {
          // Loyalty account / reward / bonus attached to another business.
          loyaltyAccountForForeignCustomer: () =>
            prisma.customerLoyaltyAccount.create({
              data: { tenantId: tenantX, customerId: Y('customer-spare') },
            }),
          loyaltyAccountConnectFromForeignCustomer: () =>
            prisma.customer.update({
              where: { id: Y('customer-spare') },
              data: { loyaltyAccount: { connect: { id: X('loyalty-2') } } },
            }),
          ledgerEntryOnForeignAccount: () =>
            prisma.mochaBeanLedgerEntry.create({
              data: {
                tenantId: tenantX,
                loyaltyAccountId: Y('loyalty'),
                type: 'MANUAL_ADJUSTMENT',
                amount: 1000,
              },
            }),
          ledgerEntryForForeignOrder: () =>
            prisma.mochaBeanLedgerEntry.create({
              data: {
                tenantId: tenantX,
                loyaltyAccountId: X('loyalty'),
                type: 'EARN',
                amount: 1000,
                orderId: Y('order-2'),
              },
            }),
          ledgerEntriesConnectedToForeignAccount: () =>
            prisma.customerLoyaltyAccount.update({
              where: { id: Y('loyalty') },
              data: { entries: { connect: { id: X('ledger') } } },
            }),
          rewardRedemptionOfForeignReward: () =>
            prisma.orderLoyaltyRewardRedemption.create({
              data: {
                tenantId: tenantX,
                orderId: X('order-2'),
                sourceRewardId: Y('reward'),
                rewardName: 'x',
                rewardType: 'FIXED_AMOUNT',
                beanCost: 1,
                discountMinorUnits: 1,
              },
            }),
          bonusItemOfForeignBonusPromotion: () =>
            prisma.orderLoyaltyBonusItem.create({
              data: {
                tenantId: tenantX,
                orderLoyaltyBonusId: X('bonus-2'),
                sourcePromotionId: Y('bonus-promo'),
                promotionName: 'x',
                promotionType: 'EXTRA_BEANS',
                bonusValue: 1,
                productId: X('product'),
                productName: 'x',
                qualifyingUnits: 1,
                qualifyingSpendMinorUnits: 1,
                standardBeansForItem: 1,
                bonusBeans: 1,
              },
            }),
          bonusForForeignOrder: () =>
            prisma.orderLoyaltyBonus.create({
              data: {
                tenantId: tenantX,
                orderId: Y('order-2'),
                totalBonusBeans: 1,
              },
            }),
          bonusItemsSetOnForeignBonus: () =>
            prisma.orderLoyaltyBonus.update({
              where: { id: Y('bonus-2') },
              data: { items: { set: [{ id: X('bonus-item') }] } },
            }),
          // Gift-card purchases and transactions.
          purchaseForForeignCustomer: () =>
            prisma.giftCardPurchase.create({
              data: {
                tenantId: tenantX,
                amountMinorUnits: 1,
                paymentAttemptId: X('pay-gc-spare'),
                customerId: Y('customer-spare'),
                purchaserEmail: 'x@example.test',
              },
            }),
          purchaseWithForeignPayment: () =>
            prisma.giftCardPurchase.create({
              data: {
                tenantId: tenantX,
                amountMinorUnits: 1,
                paymentAttemptId: Y('pay-gc-spare'),
                purchaserEmail: 'x@example.test',
              },
            }),
          purchaseConnectsForeignCard: () =>
            prisma.giftCardPurchase.update({
              where: { id: X('purchase-2') },
              data: { giftCard: { connect: { id: Y('card-spare') } } },
            }),
          purchaseCardConnectOrCreate: () =>
            prisma.giftCardPurchase.update({
              where: { id: X('purchase-2') },
              data: {
                giftCard: {
                  connectOrCreate: {
                    where: { id: Y('card-spare') },
                    create: {
                      tenantId: tenantX,
                      codeHash: `coc-${x}${y}`,
                      last4: '0000',
                      originalValueMinorUnits: 1,
                    },
                  },
                },
              },
            }),
          transactionOnForeignCard: () =>
            prisma.giftCardTransaction.create({
              data: {
                tenantId: tenantX,
                giftCardId: Y('card'),
                type: 'ADJUSTMENT',
                amountMinorUnits: 5000,
                balanceAfterMinorUnits: 6000,
              },
            }),
          transactionForForeignOrderAndPurchase: () =>
            prisma.giftCardTransaction.create({
              data: {
                tenantId: tenantX,
                giftCardId: X('card'),
                type: 'REDEMPTION',
                amountMinorUnits: -1,
                balanceAfterMinorUnits: 999,
                orderId: Y('order-2'),
                giftCardPurchaseId: Y('purchase-2'),
              },
            }),
          foreignCardClaimsTransactions: () =>
            prisma.giftCard.update({
              where: { id: Y('card-spare') },
              data: { transactions: { connect: { id: X('gc-tx') } } },
            }),
          transactionOrderDisconnect: () =>
            prisma.giftCardTransaction.update({
              where: { id: X('gc-tx') },
              data: { order: { disconnect: true } },
            }),
          redemptionOfForeignGiftCard: () =>
            prisma.orderGiftCardRedemption.create({
              data: {
                tenantId: tenantX,
                orderId: X('order-2'),
                sourceGiftCardId: Y('card'),
                last4: '1234',
                amountMinorUnits: 1,
                currency: 'USD',
              },
            }),
          // Promotions.
          redemptionOfForeignPromotion: () =>
            prisma.orderPromotionRedemption.create({
              data: {
                tenantId: tenantX,
                orderId: X('order-2'),
                sourcePromotionId: Y('promo'),
                promotionName: 'x',
                promotionKind: 'COUPON',
                discountType: 'FIXED_AMOUNT',
                discountValue: 1,
                discountMinorUnits: 1,
              },
            }),
          redemptionCountedAgainstForeignCustomer: () =>
            prisma.orderPromotionRedemption.create({
              data: {
                tenantId: tenantX,
                orderId: X('order-2'),
                promotionName: 'x',
                promotionKind: 'COUPON',
                discountType: 'FIXED_AMOUNT',
                discountValue: 1,
                discountMinorUnits: 1,
                customerId: Y('customer-spare'),
              },
            }),
          usageOfForeignPromotion: () =>
            prisma.promotionCustomerUsage.upsert({
              where: {
                promotionId_customerId: {
                  promotionId: Y('promo-spare'),
                  customerId: X('customer'),
                },
              },
              create: {
                tenantId: tenantX,
                promotionId: Y('promo-spare'),
                customerId: X('customer'),
                usedCount: 0,
              },
              update: {},
            }),
          usageMovedByUpdateMany: () =>
            prisma.promotionCustomerUsage.updateMany({
              where: { tenantId: tenantX },
              data: { tenantId: TENANTS[y] },
            }),
          foreignPromotionClaimsUsage: () =>
            prisma.promotion.update({
              where: { id: Y('promo-spare') },
              data: {
                customerUsage: {
                  connect: {
                    promotionId_customerId: {
                      promotionId: X('promo'),
                      customerId: X('customer'),
                    },
                  },
                },
              },
            }),
          redemptionConnectedToForeignOrder: () =>
            prisma.order.update({
              where: { id: Y('order-2') },
              data: {
                promotionRedemption: { connect: { id: X('promo-redemption') } },
              },
            }),
          redemptionUpsertToForeignCustomer: () =>
            prisma.orderPromotionRedemption.upsert({
              where: { id: X('promo-redemption') },
              create: {
                tenantId: tenantX,
                orderId: X('order-2'),
                promotionName: 'x',
                promotionKind: 'COUPON',
                discountType: 'FIXED_AMOUNT',
                discountValue: 1,
                discountMinorUnits: 1,
              },
              update: { customer: { connect: { id: Y('customer-spare') } } },
            }),
          // Reassigning history by manipulating tenantId.
          ledgerTenantRewrite: () =>
            prisma.mochaBeanLedgerEntry.updateMany({
              where: { id: X('ledger') },
              data: { tenantId: TENANTS[y] },
            }),
          giftCardTenantRewrite: () =>
            prisma.giftCard.update({
              where: { id: X('card-spare') },
              data: { tenant: { connect: { id: TENANTS[y] } } },
            }),
          promotionTenantRewrite: () =>
            prisma.promotion.update({
              where: { id: X('promo-spare') },
              data: { tenantId: TENANTS[y] },
            }),
        };
        for (const [name, write] of Object.entries(writes)) {
          outcomes[`${name} ${x}->${y}`] = await prismaOutcome(write());
        }
      }
      const accepted = Object.entries(outcomes).filter(
        ([, o]) => !['P2003/23503', 'P2039/23001'].includes(o),
      );
      expect(accepted).toEqual([]);
      expect(Object.keys(outcomes)).toHaveLength(28 * 6);
      // Nothing changed: rows, balances, points ledgers, card transactions and
      // promotion usage counters.
      expect(await financialState(scratch.url)).toBe(beforeMoney);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('same-business loyalty, gift-card and promotion writes keep working', async () => {
      await prisma
        .$transaction(async (tx) => {
          for (const x of TAGS) {
            const tenantId = TENANTS[x];
            const X = (name: string) => id(x, name);
            await tx.customerLoyaltyAccount.create({
              data: { tenantId, customerId: X('customer-spare') },
            });
            await tx.mochaBeanLedgerEntry.create({
              data: {
                tenantId,
                loyaltyAccountId: X('loyalty'),
                type: 'EARN',
                amount: 5,
                orderId: X('order-2'),
              },
            });
            await tx.customerLoyaltyAccount.update({
              where: { id: X('loyalty') },
              data: { balance: { increment: 5 } },
            });
            await tx.orderLoyaltyBonus.create({
              data: {
                tenantId,
                orderId: X('order-2'),
                totalBonusBeans: 3,
                items: {
                  create: {
                    sourcePromotionId: X('bonus-promo'),
                    promotionName: 'Double Beans',
                    promotionType: 'MULTIPLIER',
                    bonusValue: 2,
                    productId: X('product'),
                    productName: 'Fictional Latte',
                    qualifyingUnits: 1,
                    qualifyingSpendMinorUnits: 500,
                    standardBeansForItem: 3,
                    bonusBeans: 3,
                  },
                },
              },
            });
            await tx.giftCard.update({
              where: { id: X('card-spare') },
              data: {
                balanceMinorUnits: { increment: 100 },
                transactions: {
                  create: {
                    type: 'ADJUSTMENT',
                    amountMinorUnits: 100,
                    balanceAfterMinorUnits: 1100,
                  },
                },
              },
            });
            await tx.giftCardPurchase.update({
              where: { id: X('purchase-2') },
              data: { giftCard: { connect: { id: X('card-spare') } } },
            });
            await tx.promotionCustomerUsage.upsert({
              where: {
                promotionId_customerId: {
                  promotionId: X('promo-spare'),
                  customerId: X('customer'),
                },
              },
              create: {
                tenantId,
                promotionId: X('promo-spare'),
                customerId: X('customer'),
                usedCount: 0,
              },
              update: {},
            });
            const counted = await tx.promotionCustomerUsage.updateMany({
              where: {
                tenantId,
                promotionId: X('promo-spare'),
                usedCount: { lt: 1 },
              },
              data: { usedCount: { increment: 1 } },
            });
            expect(counted.count).toBe(1);
            await tx.orderPromotionRedemption.create({
              data: {
                tenantId,
                orderId: X('order-2'),
                sourcePromotionId: X('promo-spare'),
                promotionName: 'Ten Off',
                promotionKind: 'AUTOMATIC',
                discountType: 'PERCENTAGE_OFF',
                discountValue: 10,
                discountMinorUnits: 50,
                customerId: X('customer'),
              },
            });
            // Clearing an optional composite reference: the column, never a
            // relation disconnect (which would null tenantId too).
            await tx.giftCardTransaction.update({
              where: { id: X('gc-tx') },
              data: { orderId: null },
            });
            const card = await tx.giftCard.findUniqueOrThrow({
              where: { id: X('card-spare') },
              include: { transactions: true, purchase: true },
            });
            expect([
              card.tenantId,
              card.balanceMinorUnits,
              card.transactions.map((t) => t.tenantId),
              card.purchase?.id,
            ]).toEqual([tenantId, 1100, [tenantId], X('purchase-2')]);
          }
          throw new Error('roll back');
        })
        .catch((e: Error) => expect(e.message).toBe('roll back'));
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('the integrity checker reports CLEAN with zero unchecked rows', async () => {
      const report = await sql((client) => checkTenantIntegrity(client));
      expect(report.findings).toEqual([]);
      expect([report.verdict, report.violations, report.uncheckedRows]).toEqual(
        ['clean', 0, 0],
      );
    });

    it('deliberately removing ANY key or trigger (foreign key, snapshot, id reuse, ownership) is detected by the catalog guard, and lets the cross-business write it stopped through', async () => {
      const a = (name: string) => id('a', name);
      const b = (name: string) => id('b', name);
      const removals: Array<{ drop: string; write: string; missing: string }> =
        [
          ...RELATIONSHIPS.map((r) => ({
            drop: `ALTER TABLE "${r.child}" DROP CONSTRAINT "${constraintName(r)}"`,
            write: `UPDATE "${r.child}" SET "${r.column}" = '${b(r.spareParent)}' WHERE ${rowWhere(r.child, r.childRow, 'a')}`,
            missing: EXPECTED_FOREIGN_KEYS.find((k) =>
              k.startsWith(`${constraintName(r)}:`),
            )!,
          })),
          ...SNAPSHOTS.map((s) => ({
            drop: `DROP TRIGGER "${snapshotTrigger(s)}" ON "${s.child}"`,
            write: `UPDATE "${s.child}" SET "${s.column}" = '${b(s.spareTarget)}' WHERE id = '${a(s.childRow)}'`,
            missing: EXPECTED_SNAPSHOT_TRIGGERS.find((t) =>
              t.includes(`"${snapshotTrigger(s)}"`),
            )!,
          })),
          ...REUSE_GUARDED.map((s) => ({
            drop: `DROP TRIGGER "${s.target}_id_not_reused" ON "${s.target}"`,
            // Keep a snapshot, delete its source, let B take the id.
            write: `UPDATE "${s.child}" SET "${s.column}" = '${a(s.spareTarget)}' WHERE id = '${a(s.childRow)}';
                    DELETE FROM "${s.target}" WHERE id = '${a(s.spareTarget)}';
                    ${insertSource(s.target, a(s.spareTarget), 'b')}`,
            missing: EXPECTED_REUSE_TRIGGERS.find((t) =>
              t.includes(`"${s.target}_id_not_reused"`),
            )!,
          })),
          ...Object.entries(MOVES).map(([table, move]) => ({
            drop: `DROP TRIGGER "${table}_tenantId_immutable" ON "${table}"`,
            write: move(a, b, TENANTS.b),
            missing: EXPECTED_IMMUTABILITY.find((t) =>
              t.includes(`"${table}_tenantId_immutable"`),
            )!,
          })),
        ];
      expect(removals).toHaveLength(17 + 7 + 4 + 14);
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const { drop, write, missing } of removals) {
          const withIt = await attempt(client, write);
          await client.query('BEGIN');
          try {
            await client.query(drop);
            const enforcement = await tenantEnforcement(client);
            const lost = EXPECTED_ENFORCEMENT.filter(
              (k) => !enforcement.includes(k),
            );
            let without = 'ok';
            await client.query('SAVEPOINT w');
            try {
              await client.query(write);
            } catch (error) {
              without = String((error as { code?: string }).code);
              await client.query('ROLLBACK TO SAVEPOINT w');
            }
            if (
              withIt === 'ok' ||
              without !== 'ok' ||
              lost.length !== 1 ||
              lost[0] !== missing
            ) {
              out.push(
                `${drop}: with=${withIt} without=${without} lost=${lost.join(';')}`,
              );
            }
          } finally {
            await client.query('ROLLBACK');
          }
        }
        return out;
      });
      expect(results).toEqual([]);
      expect(await sql(tenantEnforcement)).toEqual(EXPECTED_ENFORCEMENT);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });
  });

  // Delete behaviour is compared against a database migrated to just before
  // 4C-4 holding the identical fictional rows.
  describe('deletion and SET NULL behaviour is unchanged', () => {
    let before: ScratchDatabase;
    let after: ScratchDatabase;

    beforeAll(async () => {
      before = await createScratchDatabase(baseUrl, 'fk_lgp_del_before');
      after = await createScratchDatabase(baseUrl, 'fk_lgp_del_after');
      await applyMigrations(before.url, migrations.slice(0, targetIndex));
      await applyMigrations(after.url, migrations);
      await loadFixture(before.url);
      await loadFixture(after.url);
    });
    afterAll(async () => {
      await before?.drop();
      await after?.drop();
    });

    const STATE_COLUMNS: Record<string, string> = {
      Customer: 'id, "tenantId"',
      Order: 'id, "tenantId", "customerId"',
      PaymentAttempt: 'id, "tenantId"',
      CustomerLoyaltyAccount: 'id, "tenantId", "customerId", balance',
      MochaBeanLedgerEntry:
        'id, "tenantId", "loyaltyAccountId", "orderId", amount',
      LoyaltyReward: 'id, "tenantId"',
      LoyaltyBonusPromotion: 'id, "tenantId"',
      OrderLoyaltyRewardRedemption:
        'id, "tenantId", "orderId", "sourceRewardId"',
      OrderLoyaltyBonus: 'id, "tenantId", "orderId"',
      OrderLoyaltyBonusItem:
        'id, "tenantId", "orderLoyaltyBonusId", "sourcePromotionId"',
      Promotion: 'id, "tenantId"',
      PromotionCustomerUsage:
        '"promotionId", "customerId", "tenantId", "usedCount"',
      OrderPromotionRedemption:
        'id, "tenantId", "orderId", "customerId", "sourcePromotionId"',
      GiftCard: 'id, "tenantId", "balanceMinorUnits"',
      GiftCardPurchase:
        'id, "tenantId", "paymentAttemptId", "giftCardId", "customerId"',
      GiftCardTransaction:
        'id, "tenantId", "giftCardId", "orderId", "giftCardPurchaseId"',
      OrderGiftCardRedemption: 'id, "tenantId", "orderId", "sourceGiftCardId"',
    };

    // The affected rows after `statement` ran — or its error code — inside
    // a rolled-back transaction.
    const outcome = (url: string, statement: string) =>
      withScratchClient(url, async (client) => {
        await client.query('BEGIN');
        try {
          await client.query(statement);
          const parts: string[] = [];
          for (const [table, columns] of Object.entries(STATE_COLUMNS)) {
            const { rows } = await client.query<{ r: string }>(
              `SELECT string_agg(row_to_json(x)::text, '|' ORDER BY row_to_json(x)::text) AS r
                 FROM (SELECT ${columns} FROM "${table}") x`,
            );
            parts.push(`${table}:${rows[0].r}`);
          }
          return parts.join('\n');
        } catch (error) {
          return String((error as { code?: string }).code);
        } finally {
          await client.query('ROLLBACK');
        }
      });

    const deletes = TAGS.flatMap((t) =>
      (
        [
          // CASCADE account+ledger and usage; SET NULL only the customer of
          // purchases, promotion redemptions and orders.
          ['Customer', 'customer'],
          ['Customer', 'customer-2'],
          // RESTRICT: redemptions, bonus and transactions reference it.
          ['Order', 'order'],
          // SET NULL only orderId of a ledger entry and a card transaction.
          ['Order', 'order-4'],
          ['Order', 'order-2'],
          ['CustomerLoyaltyAccount', 'loyalty'],
          ['OrderLoyaltyBonus', 'bonus'],
          ['Promotion', 'promo'],
          ['LoyaltyReward', 'reward'],
          ['LoyaltyBonusPromotion', 'bonus-promo'],
          ['GiftCard', 'card'],
          ['GiftCard', 'card-spare'],
          // SET NULL only giftCardPurchaseId of its transaction.
          ['GiftCardPurchase', 'purchase'],
          ['PaymentAttempt', 'pay-gc'],
        ] as const
      ).map(
        ([table, row]) =>
          [
            `${table} ${row} ${t}`,
            `DELETE FROM "${table}" WHERE id = '${id(t, row)}'`,
          ] as const,
      ),
    );

    it('every delete has the same outcome before and after 4C-4', async () => {
      const differences: string[] = [];
      for (const [label, statement] of deletes) {
        const was = await outcome(before.url, statement);
        const is = await outcome(after.url, statement);
        if (was !== is) differences.push(label);
      }
      // The one intended difference: OrderPromotionRedemption.customerId had
      // no foreign key, so deleting the customer left it dangling; it is now
      // SET NULL (see below). Everything else is identical.
      expect(differences).toEqual(TAGS.map((t) => `Customer customer ${t}`));
      expect(deletes).toHaveLength(14 * 3);
    });

    it('the one intended change: deleting a customer now clears OrderPromotionRedemption.customerId instead of leaving it dangling', async () => {
      const statement = `DELETE FROM "Customer" WHERE id = '${id('c', 'customer')}'`;
      const row = (customerId: string) =>
        `{"id":"${id('c', 'promo-redemption')}","tenantId":"${TENANTS.c}","orderId":"${id('c', 'order')}","customerId":${customerId},"sourcePromotionId":"${id('c', 'promo')}"}`;
      expect(await outcome(before.url, statement)).toContain(
        row(`"${id('c', 'customer')}"`),
      );
      expect(await outcome(after.url, statement)).toContain(row('null'));
    });

    it('every SET NULL clears only its column — the rows keep their business and history', async () => {
      const customer = await outcome(
        after.url,
        `DELETE FROM "Customer" WHERE id = '${id('b', 'customer')}'`,
      );
      expect(customer).toContain(
        `{"id":"${id('b', 'promo-redemption')}","tenantId":"${TENANTS.b}","orderId":"${id('b', 'order')}","customerId":null,"sourcePromotionId":"${id('b', 'promo')}"}`,
      );
      expect(customer).toContain(
        `{"id":"${id('b', 'purchase')}","tenantId":"${TENANTS.b}","paymentAttemptId":"${id('b', 'pay-gc')}","giftCardId":"${id('b', 'card')}","customerId":null}`,
      );
      const order = await outcome(
        after.url,
        `DELETE FROM "Order" WHERE id = '${id('b', 'order-4')}'`,
      );
      expect(order).toContain(
        `{"id":"${id('b', 'ledger-2')}","tenantId":"${TENANTS.b}","loyaltyAccountId":"${id('b', 'loyalty')}","orderId":null,"amount":200}`,
      );
      expect(order).toContain(
        `{"id":"${id('b', 'gc-tx-2')}","tenantId":"${TENANTS.b}","giftCardId":"${id('b', 'card')}","orderId":null,"giftCardPurchaseId":null}`,
      );
      const purchase = await outcome(
        after.url,
        `DELETE FROM "GiftCardPurchase" WHERE id = '${id('b', 'purchase')}'`,
      );
      expect(purchase).toContain(
        `{"id":"${id('b', 'gc-tx')}","tenantId":"${TENANTS.b}","giftCardId":"${id('b', 'card')}","orderId":"${id('b', 'order')}","giftCardPurchaseId":null}`,
      );
    });
  });

  // Real `prisma migrate deploy`, exactly as CI and every environment run
  // it, against newly created guarded scratch databases.
  describe('applied by real prisma migrate deploy', () => {
    const prisma = prismaCli(databaseDir);
    const projects: MigrationProject[] = [];
    const scratches: ScratchDatabase[] = [];
    const beforeNames = migrations.slice(0, targetIndex).map((m) => m.name);
    const allNames = migrations.map((m) => m.name);

    afterAll(async () => {
      for (const scratch of scratches) await scratch.drop();
      for (const p of projects) p.remove();
    });

    const project = (
      names: string[],
      extra?: ExtraMigration | ExtraMigration[],
    ) => {
      const created = createMigrationProject(migrationsDir, names, extra);
      projects.push(created);
      return created.config;
    };
    const fresh = async (label: string) => {
      const scratch = await createScratchDatabase(baseUrl, label);
      scratches.push(scratch);
      return scratch;
    };
    // A database at the migration before 4C-4, holding the fixture.
    const beforeFourC4 = async (label: string) => {
      const scratch = await fresh(label);
      expect(
        (await prisma(scratch.url, ['migrate', 'deploy'], project(beforeNames)))
          .code,
      ).toBe(0);
      await loadFixture(scratch.url);
      return scratch;
    };
    const run = (url: string, statement: string) =>
      withScratchClient(url, (client) => client.query(statement));
    const migrationRow = async (url: string, name = MIGRATION) =>
      (
        await withScratchClient(url, (client) =>
          client.query<{ finished: boolean; rolled_back: boolean }>(
            `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
               FROM _prisma_migrations WHERE migration_name = '${name}'
              ORDER BY started_at`,
          ),
        )
      ).rows.map(
        (r) =>
          `${r.finished ? 'finished' : 'unfinished'}${r.rolled_back ? '+rolled-back' : ''}`,
      );
    const noDrift = async (url: string) =>
      (
        await prisma(url, [
          'migrate',
          'diff',
          '--from-config-datasource',
          '--to-schema',
          'prisma/schema.prisma',
          '--exit-code',
        ])
      ).code;
    const enforcement = (url: string) =>
      withScratchClient(url, tenantEnforcement);

    it('succeeds on clean data: everything enforced, data and balances unchanged, no drift, integrity CLEAN', async () => {
      const scratch = await beforeFourC4('fk_lgp_ok');
      const data = await dataChecksum(scratch.url);
      const money = await financialState(scratch.url);
      const result = await prisma(scratch.url, ['migrate', 'deploy']);
      expect(result.code).toBe(0);
      expect(await migrationRow(scratch.url)).toEqual(['finished']);
      expect(await enforcement(scratch.url)).toEqual(EXPECTED_ENFORCEMENT);
      expect(await dataChecksum(scratch.url)).toBe(data);
      expect(await financialState(scratch.url)).toBe(money);
      expect(await noDrift(scratch.url)).toBe(0);
      const report = await withScratchClient(scratch.url, (client) =>
        checkTenantIntegrity(client),
      );
      expect([report.verdict, report.violations, report.uncheckedRows]).toEqual(
        ['clean', 0, 0],
      );
    });

    it('mismatched rows — cross-business, missing and snapshot — abort it before any change, all listed; never repaired or reassigned; recovery only after an explicit fix', async () => {
      const scratch = await beforeFourC4('fk_lgp_cross');
      // Legacy-style bad data the single-column keys allowed.
      await run(
        scratch.url,
        `UPDATE "MochaBeanLedgerEntry" SET "loyaltyAccountId" = '${id('b', 'loyalty-2')}' WHERE id = '${id('a', 'ledger')}';
         UPDATE "OrderPromotionRedemption" SET "customerId" = '${id('c', 'customer-spare')}' WHERE id = '${id('a', 'promo-redemption')}';
         UPDATE "OrderPromotionRedemption" SET "customerId" = 'lg-missing' WHERE id = '${id('b', 'promo-redemption')}';
         UPDATE "OrderGiftCardRedemption" SET "sourceGiftCardId" = '${id('a', 'card')}' WHERE id = '${id('c', 'gc-redemption')}';
         UPDATE "GiftCardTransaction" SET "giftCardId" = '${id('a', 'card-spare')}' WHERE id = '${id('b', 'gc-tx-2')}';`,
      );
      const catalog = await databaseCatalog(scratch.url);
      const data = await dataChecksum(scratch.url);

      const failed = await prisma(scratch.url, ['migrate', 'deploy']);
      expect(failed.code).not.toBe(0);
      expect(failed.out).toContain('P3018');
      expect(failed.out).toContain('Security 4C-4 aborted');
      for (const line of [
        'MochaBeanLedgerEntry.loyaltyAccountId -> CustomerLoyaltyAccount: 1 row(s)',
        'OrderPromotionRedemption.customerId -> Customer: 2 row(s)',
        'GiftCardTransaction.giftCardId -> GiftCard: 1 row(s)',
        'OrderGiftCardRedemption.sourceGiftCardId -> GiftCard (snapshot): 1 row(s)',
      ]) {
        expect(failed.out).toContain(line);
      }
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);
      expect(await dataChecksum(scratch.url)).toBe(data);
      expect(await migrationRow(scratch.url)).toEqual(['unfinished']);

      const retried = await prisma(scratch.url, ['migrate', 'deploy']);
      expect(retried.out).toContain('P3009');
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);

      // Documented recovery: explicit, deliberate fixes of the reported
      // rows (here: restore the fixture's own references), then resolve and
      // deploy again.
      await run(
        scratch.url,
        `UPDATE "MochaBeanLedgerEntry" SET "loyaltyAccountId" = '${id('a', 'loyalty')}' WHERE id = '${id('a', 'ledger')}';
         UPDATE "OrderPromotionRedemption" SET "customerId" = '${id('a', 'customer')}' WHERE id = '${id('a', 'promo-redemption')}';
         UPDATE "OrderPromotionRedemption" SET "customerId" = '${id('b', 'customer')}' WHERE id = '${id('b', 'promo-redemption')}';
         UPDATE "OrderGiftCardRedemption" SET "sourceGiftCardId" = '${id('c', 'card')}' WHERE id = '${id('c', 'gc-redemption')}';
         UPDATE "GiftCardTransaction" SET "giftCardId" = '${id('b', 'card')}' WHERE id = '${id('b', 'gc-tx-2')}';`,
      );
      expect(
        (
          await prisma(scratch.url, [
            'migrate',
            'resolve',
            '--rolled-back',
            MIGRATION,
          ])
        ).code,
      ).toBe(0);
      expect((await prisma(scratch.url, ['migrate', 'deploy'])).code).toBe(0);
      expect(await migrationRow(scratch.url)).toEqual([
        'unfinished+rolled-back',
        'finished',
      ]);
      expect(await enforcement(scratch.url)).toEqual(EXPECTED_ENFORCEMENT);
      expect(await noDrift(scratch.url)).toBe(0);
    });

    it('residual until Security 4C-6: a deleted PRODUCT id taken by another business is not prevented — but the integrity checker reports it', async () => {
      const scratch = await beforeFourC4('fk_lgp_product_reuse');
      expect((await prisma(scratch.url, ['migrate', 'deploy'])).code).toBe(0);
      await run(
        scratch.url,
        `UPDATE "OrderLoyaltyBonusItem" SET "productId" = '${id('a', 'product-2')}' WHERE id = '${id('a', 'bonus-item')}';
         DELETE FROM "Product" WHERE id = '${id('a', 'product-2')}';
         ${insertSource('Product', id('a', 'product-2'), 'b')};`,
      );
      const report = await withScratchClient(scratch.url, (client) =>
        checkTenantIntegrity(client),
      );
      expect(
        report.findings.map(
          (f) =>
            `${f.severity} ${f.relationshipId} ${f.type} ${f.sampleKeys.join()}`,
        ),
      ).toEqual([
        `violation OrderLoyaltyBonusItem.productId cross-tenant ${id('a', 'bonus-item')}`,
      ]);
      expect(report.verdict).toBe('violations');
    });

    it('refuses to run without Security 4C-3’s function, changing nothing', async () => {
      const scratch = await beforeFourC4('fk_lgp_no43');
      await run(
        scratch.url,
        `ALTER FUNCTION "reject_tenant_reassignment"() RENAME TO "renamed_for_test"`,
      );
      const catalog = await databaseCatalog(scratch.url);
      const failed = await prisma(scratch.url, ['migrate', 'deploy']);
      expect(failed.code).not.toBe(0);
      expect(failed.out).toContain('requires Security 4C-3');
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);
    });

    it('a failure at its LAST statement leaves no partial change', async () => {
      const scratch = await beforeFourC4('fk_lgp_late');
      // Occupy the name of the last trigger it creates.
      await run(
        scratch.url,
        `CREATE TRIGGER "PromotionCustomerUsage_tenantId_immutable" BEFORE UPDATE ON "PromotionCustomerUsage"
           FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`,
      );
      const catalog = await databaseCatalog(scratch.url);
      const data = await dataChecksum(scratch.url);
      const failed = await prisma(scratch.url, ['migrate', 'deploy']);
      expect(failed.code).not.toBe(0);
      expect(failed.out).toContain('P3018');
      expect(failed.out).toMatch(/already exists/);
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);
      expect(await dataChecksum(scratch.url)).toBe(data);
      expect(await migrationRow(scratch.url)).toEqual(['unfinished']);
    });

    it('a lock it cannot get makes it fail fast (lock_timeout) and atomically', async () => {
      const scratch = await beforeFourC4('fk_lgp_lock');
      const catalog = await databaseCatalog(scratch.url);
      const held = await withScratchClient(scratch.url, async (client) => {
        await client.query('BEGIN');
        await client.query(
          `LOCK TABLE "PromotionCustomerUsage" IN ROW EXCLUSIVE MODE`,
        );
        const started = Date.now();
        const result = await prisma(scratch.url, ['migrate', 'deploy']);
        await client.query('ROLLBACK');
        return { result, seconds: (Date.now() - started) / 1000 };
      });
      expect(held.result.code).not.toBe(0);
      expect(held.result.out).toMatch(/lock timeout/i);
      expect(held.seconds).toBeLessThan(60);
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);
      expect(await migrationRow(scratch.url)).toEqual(['unfinished']);
    });

    it('while 4C-4 is applied, rolling back 4C-3 first is refused atomically (its function is still in use)', async () => {
      const scratch = await beforeFourC4('fk_lgp_order');
      expect((await prisma(scratch.url, ['migrate', 'deploy'])).code).toBe(0);
      const catalog = await databaseCatalog(scratch.url);
      const name = '20261013100000_rollback_tenant_fk_customer_order_payment';
      const failed = await prisma(
        scratch.url,
        ['migrate', 'deploy'],
        project(allNames, { name, sql: previousRollbackSql }),
      );
      expect(failed.code).not.toBe(0);
      expect(failed.out).toMatch(/depend/);
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);
      expect(await migrationRow(scratch.url, name)).toEqual(['unfinished']);
    });

    it('the documented rollback — shipped as a new forward migration — restores the pre-4C-4 catalog exactly, keeps the data, and 4C-4 re-applies', async () => {
      const scratch = await beforeFourC4('fk_lgp_rollback');
      const data = await dataChecksum(scratch.url);
      expect((await prisma(scratch.url, ['migrate', 'deploy'])).code).toBe(0);
      const rollback = {
        name: '20261013100000_rollback_tenant_fk_loyalty_giftcard_promotion',
        sql: rollbackSql,
      };
      expect(
        (
          await prisma(
            scratch.url,
            ['migrate', 'deploy'],
            project(allNames, rollback),
          )
        ).code,
      ).toBe(0);
      const reference = await fresh('fk_lgp_rollback_ref');
      expect(
        (
          await prisma(
            reference.url,
            ['migrate', 'deploy'],
            project(beforeNames),
          )
        ).code,
      ).toBe(0);
      expect(await databaseCatalog(scratch.url)).toEqual(
        await databaseCatalog(reference.url),
      );
      expect(await dataChecksum(scratch.url)).toBe(data);
      const reapply = {
        name: '20261013110000_reapply_tenant_fk_loyalty_giftcard_promotion',
        sql: target.sql,
      };
      expect(
        (
          await prisma(
            scratch.url,
            ['migrate', 'deploy'],
            project(allNames, [rollback, reapply]),
          )
        ).code,
      ).toBe(0);
      expect(await enforcement(scratch.url)).toEqual(EXPECTED_ENFORCEMENT);
      expect(await dataChecksum(scratch.url)).toBe(data);
    });
  });
});

// Per protected table: a move to business B the foreign keys and snapshot
// triggers alone would allow (every reference re-pointed to B, or cleared),
// so only the ownership trigger stands in its way.
const MOVES: Record<
  string,
  (
    a: (n: string) => string,
    b: (n: string) => string,
    tenantB: string,
  ) => string
> = {
  CustomerLoyaltyAccount: (a, b, t) =>
    `UPDATE "CustomerLoyaltyAccount" SET "tenantId" = '${t}', "customerId" = '${b('customer-spare')}' WHERE id = '${a('loyalty-2')}'`,
  GiftCard: (a, _b, t) =>
    `UPDATE "GiftCard" SET "tenantId" = '${t}' WHERE id = '${a('card-spare')}'`,
  GiftCardPurchase: (a, b, t) =>
    `UPDATE "GiftCardPurchase" SET "tenantId" = '${t}', "paymentAttemptId" = '${b('pay-gc-spare')}' WHERE id = '${a('purchase-2')}'`,
  GiftCardTransaction: (a, b, t) =>
    `UPDATE "GiftCardTransaction" SET "tenantId" = '${t}', "giftCardId" = '${b('card-spare')}', "orderId" = NULL, "giftCardPurchaseId" = NULL WHERE id = '${a('gc-tx-2')}'`,
  LoyaltyBonusPromotion: (a, _b, t) =>
    `UPDATE "LoyaltyBonusPromotion" SET "tenantId" = '${t}' WHERE id = '${a('bonus-promo-2')}'`,
  LoyaltyReward: (a, _b, t) =>
    `UPDATE "LoyaltyReward" SET "tenantId" = '${t}' WHERE id = '${a('reward-2')}'`,
  MochaBeanLedgerEntry: (a, b, t) =>
    `UPDATE "MochaBeanLedgerEntry" SET "tenantId" = '${t}', "loyaltyAccountId" = '${b('loyalty-2')}', "orderId" = NULL WHERE id = '${a('ledger-2')}'`,
  OrderGiftCardRedemption: (a, b, t) =>
    `UPDATE "OrderGiftCardRedemption" SET "tenantId" = '${t}', "orderId" = '${b('order-2')}', "sourceGiftCardId" = NULL WHERE id = '${a('gc-redemption')}'`,
  OrderLoyaltyBonus: (a, b, t) =>
    `UPDATE "OrderLoyaltyBonus" SET "tenantId" = '${t}', "orderId" = '${b('order-2')}' WHERE id = '${a('bonus-2')}'`,
  OrderLoyaltyBonusItem: (a, b, t) =>
    `UPDATE "OrderLoyaltyBonusItem" SET "tenantId" = '${t}', "orderLoyaltyBonusId" = '${b('bonus-2')}', "sourcePromotionId" = NULL, "productId" = '${b('product')}' WHERE id = '${a('bonus-item')}'`,
  OrderLoyaltyRewardRedemption: (a, b, t) =>
    `UPDATE "OrderLoyaltyRewardRedemption" SET "tenantId" = '${t}', "orderId" = '${b('order-2')}', "sourceRewardId" = NULL, "freeItemProductId" = NULL WHERE id = '${a('reward-redemption')}'`,
  OrderPromotionRedemption: (a, b, t) =>
    `UPDATE "OrderPromotionRedemption" SET "tenantId" = '${t}', "orderId" = '${b('order-2')}', "customerId" = NULL, "sourcePromotionId" = NULL, "freeItemProductId" = NULL WHERE id = '${a('promo-redemption')}'`,
  Promotion: (a, _b, t) =>
    `UPDATE "Promotion" SET "tenantId" = '${t}' WHERE id = '${a('promo-spare')}'`,
  PromotionCustomerUsage: (a, b, t) =>
    `UPDATE "PromotionCustomerUsage" SET "tenantId" = '${t}', "promotionId" = '${b('promo-spare')}', "customerId" = '${b('customer-spare')}' WHERE "promotionId" = '${a('promo')}' AND "customerId" = '${a('customer')}'`,
};
