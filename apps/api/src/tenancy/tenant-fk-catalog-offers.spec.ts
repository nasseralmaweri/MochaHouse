import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { Client } from 'pg';
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
import { dataChecksum } from './historical-state';

// Security 4C-6 — PostgreSQL-enforced tenant isolation for the catalog
// (categories, products, modifiers, menus, location menus and overrides),
// offer definitions (reward, bonus-promotion and promotion eligibility) and
// campaigns, and closure of the product-snapshot finding recorded in 4C-4:
//   - 33 composite foreign keys ("tenantId", <column>) -> parent
//     ("tenantId", "id") — 32 replaced, Campaign.mediaAssetId new;
//   - 19 more tables whose rows can never move to another business;
//   - product snapshots (OrderLine.productId, OrderLoyaltyBonusItem.productId,
//     OrderLoyaltyRewardRedemption.freeItemProductId,
//     OrderPromotionRedemption.freeItemProductId): a new or changed value
//     must name an existing product of the same business; a kept value may
//     outlive its product; a deleted product's id can never be taken by
//     another business while a snapshot of the first names it; and the
//     validation locks the product row, so no race can slip between them.
//
// With three fictional businesses this spec proves: the schema, inventory,
// migration and rollback agree; the configured test database enforces
// everything, and a removed key, trigger or lock is detected; same-business
// catalog and offer writes work; every cross-business reference, move and
// snapshot is rejected by PostgreSQL — by direct SQL and Prisma writes —
// with prices, availability, snapshots and history unchanged; delete
// behaviour is unchanged except the one intended change; the integrity
// checker reports CLEAN; and the migration, run by the REAL
// `prisma migrate deploy`, aborts on mismatched rows before changing
// anything, is atomic, fails fast on locks, leaves no drift, and its
// rollback restores the previous catalog exactly. All data is fictional.

jest.setTimeout(600_000);

const repoRoot = join(__dirname, '../../../..');
const databaseDir = join(repoRoot, 'packages/database');
const migrationsDir = join(databaseDir, 'prisma/migrations');
const MIGRATION = '20261015090000_tenant_fk_catalog_offers_snapshots';
const PREVIOUS = '20261014090000_tenant_fk_staff_authorization';
const FOUR_C_4 = '20261013090000_tenant_fk_loyalty_giftcard_promotion';
const FOUR_C_3 = '20261012090000_tenant_fk_customer_order_payment';
const migrations = listMigrations(migrationsDir);
const targetIndex = migrations.findIndex((m) => m.name === MIGRATION);
const target = migrations[targetIndex];
const rollbackOf = (name: string) =>
  readFileSync(join(databaseDir, `prisma/rollbacks/${name}.down.sql`), 'utf8');
const rollbackSql = rollbackOf(MIGRATION);
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
const id = (tag: Tag, name: string) => `cat-${tag}-${name}`;

type OnDelete = 'CASCADE' | 'RESTRICT';

interface Relationship {
  readonly child: string;
  readonly column: string;
  readonly parent: string;
  readonly onDelete: OnDelete;
  readonly optional: boolean;
}

const rel = (
  child: string,
  column: string,
  parent: string,
  onDelete: OnDelete = 'RESTRICT',
  optional = false,
): Relationship => ({ child, column, parent, onDelete, optional });

const RELATIONSHIPS: readonly Relationship[] = [
  rel('Product', 'categoryId', 'Category'),
  rel('ModifierOption', 'modifierGroupId', 'ModifierGroup'),
  rel('ProductModifierGroup', 'productId', 'Product'),
  rel('ProductModifierGroup', 'modifierGroupId', 'ModifierGroup'),
  rel('MenuProduct', 'menuId', 'Menu'),
  rel('MenuProduct', 'productId', 'Product'),
  rel('LocationMenu', 'locationId', 'Location'),
  rel('LocationMenu', 'menuId', 'Menu'),
  rel('LocationProductPriceOverride', 'locationId', 'Location'),
  rel('LocationProductPriceOverride', 'menuId', 'Menu'),
  rel('LocationProductPriceOverride', 'productId', 'Product'),
  rel('LocationProductAvailabilityOverride', 'locationId', 'Location'),
  rel('LocationProductAvailabilityOverride', 'menuId', 'Menu'),
  rel('LocationProductAvailabilityOverride', 'productId', 'Product'),
  rel('LoyaltyRewardProduct', 'rewardId', 'LoyaltyReward', 'CASCADE'),
  rel('LoyaltyRewardProduct', 'productId', 'Product'),
  rel('LoyaltyRewardCategory', 'rewardId', 'LoyaltyReward', 'CASCADE'),
  rel('LoyaltyRewardCategory', 'categoryId', 'Category'),
  rel(
    'LoyaltyBonusPromotionProduct',
    'promotionId',
    'LoyaltyBonusPromotion',
    'CASCADE',
  ),
  rel('LoyaltyBonusPromotionProduct', 'productId', 'Product'),
  rel(
    'LoyaltyBonusPromotionLocation',
    'promotionId',
    'LoyaltyBonusPromotion',
    'CASCADE',
  ),
  rel('LoyaltyBonusPromotionLocation', 'locationId', 'Location'),
  rel('PromotionProduct', 'promotionId', 'Promotion', 'CASCADE'),
  rel('PromotionProduct', 'productId', 'Product'),
  rel('PromotionCategory', 'promotionId', 'Promotion', 'CASCADE'),
  rel('PromotionCategory', 'categoryId', 'Category'),
  rel('PromotionLocation', 'promotionId', 'Promotion', 'CASCADE'),
  rel('PromotionLocation', 'locationId', 'Location'),
  rel('Campaign', 'promotionId', 'Promotion', 'RESTRICT', true),
  rel(
    'Campaign',
    'loyaltyBonusPromotionId',
    'LoyaltyBonusPromotion',
    'RESTRICT',
    true,
  ),
  rel('CampaignProduct', 'campaignId', 'Campaign', 'CASCADE'),
  rel('CampaignProduct', 'productId', 'Product'),
  // New: had no foreign key before 4C-6.
  rel('Campaign', 'mediaAssetId', 'MediaAsset', 'RESTRICT', true),
];

const relationshipId = (r: Relationship) => `${r.child}.${r.column}`;
const constraintName = (r: Relationship) =>
  `${r.child}_tenantId_${r.column}_fkey`;

// The fixture's unused parent of each type (pointing a row at it can trip
// no other unique constraint).
const SPARE: Record<string, string> = {
  Category: 'category-spare',
  Product: 'product-spare',
  ModifierGroup: 'mg-spare',
  Menu: 'menu-spare',
  Location: 'location-spare',
  LoyaltyReward: 'reward-spare',
  LoyaltyBonusPromotion: 'bonus-spare',
  Promotion: 'promo-spare',
  Campaign: 'campaign-spare',
  MediaAsset: 'media-spare',
};

// The single fixture row of each referencing table, per business.
const rowWhere = (child: string, tag: Tag) => {
  switch (child) {
    case 'Product':
      return `id = '${id(tag, 'product')}'`;
    case 'ModifierOption':
      return `id = '${id(tag, 'option')}'`;
    case 'Campaign':
      return `id = '${id(tag, 'campaign')}'`;
    default:
      return `"tenantId" = '${TENANTS[tag]}'`;
  }
};
// Columns a copied row must change to stay unique (beyond its primary key,
// which the changed reference already makes unique for join tables).
const COPY_OVERRIDES: Record<string, (from: Tag) => Record<string, string>> = {
  Product: (from) => ({
    id: `copy-${from}-product`,
    slug: `copy-${from}-product`,
  }),
  ModifierOption: (from) => ({ id: `copy-${from}-option` }),
  Campaign: (from) => ({ id: `copy-${from}-campaign` }),
};
const insertCopy = (r: Relationship, from: Tag, parentId: string) => {
  const overrides = {
    ...(COPY_OVERRIDES[r.child]?.(from) ?? {}),
    [r.column]: parentId,
  };
  return `INSERT INTO "${r.child}"
    SELECT (jsonb_populate_record(NULL::"${r.child}", to_jsonb(t) || '${JSON.stringify(overrides)}'::jsonb)).*
      FROM "${r.child}" t WHERE ${rowWhere(r.child, from)}`;
};

// Tables whose rows can never move to another business once 4C-6 is
// applied (the 19 it adds).
const PROTECTED_TABLES = [
  'Campaign',
  'CampaignProduct',
  'Category',
  'LocationMenu',
  'LocationProductAvailabilityOverride',
  'LocationProductPriceOverride',
  'LoyaltyBonusPromotionLocation',
  'LoyaltyBonusPromotionProduct',
  'LoyaltyRewardCategory',
  'LoyaltyRewardProduct',
  'Menu',
  'MenuProduct',
  'ModifierGroup',
  'ModifierOption',
  'Product',
  'ProductModifierGroup',
  'PromotionCategory',
  'PromotionLocation',
  'PromotionProduct',
];

// The product snapshots and the column each is kept in.
const SNAPSHOTS: ReadonlyArray<{ table: string; column: string; row: string }> =
  [
    { table: 'OrderLine', column: 'productId', row: 'line' },
    { table: 'OrderLoyaltyBonusItem', column: 'productId', row: 'bonus-item' },
    {
      table: 'OrderLoyaltyRewardRedemption',
      column: 'freeItemProductId',
      row: 'reward-redemption',
    },
    {
      table: 'OrderPromotionRedemption',
      column: 'freeItemProductId',
      row: 'promo-redemption',
    },
  ];

const immutabilityTrigger = (t: string) =>
  `trigger: CREATE TRIGGER "${t}_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON public."${t}" FOR EACH ROW WHEN ((old."tenantId" IS DISTINCT FROM new."tenantId")) EXECUTE FUNCTION reject_tenant_reassignment()`;
const ORDER_LINE_SNAPSHOT_TRIGGER =
  'trigger: CREATE TRIGGER "OrderLine_productId_same_tenant" BEFORE INSERT OR UPDATE OF "productId" ON public."OrderLine" FOR EACH ROW EXECUTE FUNCTION reject_cross_tenant_snapshot(\'productId\', \'Product\')';
const PRODUCT_REUSE_TRIGGER = `trigger: CREATE TRIGGER "Product_id_not_reused" BEFORE INSERT OR UPDATE OF id ON public."Product" FOR EACH ROW EXECUTE FUNCTION reject_reused_snapshot_source(${SNAPSHOTS.map((s) => `'${s.table}', '${s.column}'`).join(', ')})`;
const INDEXES = [
  'index: CREATE INDEX "Campaign_mediaAssetId_idx" ON public."Campaign" USING btree ("mediaAssetId")',
  ...SNAPSHOTS.map(
    (s) =>
      `index: CREATE INDEX "${s.table}_${s.column}_idx" ON public."${s.table}" USING btree ("${s.column}")`,
  ),
].sort();
const FUNCTION_TRAITS = [
  'function reject_cross_tenant_snapshot: locks its source (FOR KEY SHARE)',
  'function reject_reused_snapshot_source: checks every (table, column) pair',
];

const EXPECTED_FOREIGN_KEYS = RELATIONSHIPS.map(
  (r) =>
    `${constraintName(r)}: FOREIGN KEY ("tenantId", "${r.column}") REFERENCES "${r.parent}"("tenantId", id) ON UPDATE RESTRICT ON DELETE ${r.onDelete}`,
).sort();
const EXPECTED_IMMUTABILITY = PROTECTED_TABLES.map(immutabilityTrigger).sort();
const EXPECTED_ENFORCEMENT = [
  ...EXPECTED_FOREIGN_KEYS,
  ...EXPECTED_IMMUTABILITY,
  ORDER_LINE_SNAPSHOT_TRIGGER,
  PRODUCT_REUSE_TRIGGER,
  ...INDEXES,
  ...FUNCTION_TRAITS,
];

// Every foreign key on the 33 referencing columns, the ownership triggers
// of the 19 tables, the two product-snapshot triggers, the five indexes and
// the two traits of the shared snapshot functions — as PostgreSQL defines
// them.
async function tenantEnforcement(client: Client): Promise<string[]> {
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
  const immutable = await client.query<{ d: string }>(
    `SELECT 'trigger: ' || pg_get_triggerdef(t.oid) AS d
       FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND p.proname = 'reject_tenant_reassignment'
        AND t.tgrelid::regclass::text IN (${PROTECTED_TABLES.map((t) => `'"${t}"'`).join(', ')})
      ORDER BY t.tgname COLLATE "C"`,
  );
  const snapshot = await client.query<{ d: string }>(
    `SELECT 'trigger: ' || pg_get_triggerdef(oid) AS d FROM pg_trigger
      WHERE tgname IN ('OrderLine_productId_same_tenant', 'Product_id_not_reused')
      ORDER BY tgname COLLATE "C"`,
  );
  const indexes = await client.query<{ d: string }>(
    `SELECT 'index: ' || indexdef AS d FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN (${['Campaign_mediaAssetId_idx', ...SNAPSHOTS.map((s) => `${s.table}_${s.column}_idx`)].map((n) => `'${n}'`).join(', ')})
      ORDER BY indexdef COLLATE "C"`,
  );
  const fns = await client.query<{ name: string; src: string }>(
    `SELECT proname AS name, prosrc AS src FROM pg_proc
      WHERE proname IN ('reject_cross_tenant_snapshot', 'reject_reused_snapshot_source')`,
  );
  const src = (n: string) => fns.rows.find((r) => r.name === n)?.src ?? '';
  const traits: string[] = [];
  if (/FOR KEY SHARE/.test(src('reject_cross_tenant_snapshot')))
    traits.push(FUNCTION_TRAITS[0]);
  if (/TG_NARGS/.test(src('reject_reused_snapshot_source')))
    traits.push(FUNCTION_TRAITS[1]);
  return [
    ...keys.rows.map((r) => r.d),
    ...immutable.rows.map((r) => r.d),
    // The OrderLine trigger sorts before the Product one.
    ...snapshot.rows.map((r) => r.d),
    ...indexes.rows.map((r) => r.d),
    ...traits,
  ];
}

// Fictional data for one business: every relationship in use, plus unused
// "spare" parents, and orders whose snapshots name a dedicated product
// ('snap-product') that nothing else references, so it can be deleted.
async function loadBusiness(prisma: PrismaClient, tag: Tag) {
  const tenantId = TENANTS[tag];
  const i = (name: string) => id(tag, name);
  await prisma.internalUser.create({
    // Only the id back: an older-migration database lacks later columns.
    select: { id: true },
    data: {
      id: i('staff'),
      tenantId,
      externalProvider: 'dev',
      externalSubject: i('staff'),
      email: `${tag}.cat@example.test`,
    },
  });
  for (const name of ['location', 'location-spare']) {
    await prisma.location.create({
      // Only the id back: an older-migration database lacks later columns.
      select: { id: true },
      data: { id: i(name), tenantId, name: 'Store', slug: i(name) },
    });
  }
  for (const name of ['category', 'category-spare']) {
    await prisma.category.create({
      data: { id: i(name), tenantId, name: 'Drinks', slug: i(name) },
    });
  }
  for (const name of ['product', 'product-spare', 'snap-product']) {
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
  for (const name of ['mg', 'mg-spare']) {
    await prisma.modifierGroup.create({
      data: { id: i(name), tenantId, name: 'Milk' },
    });
  }
  await prisma.modifierOption.create({
    data: { id: i('option'), tenantId, name: 'Oat', modifierGroupId: i('mg') },
  });
  await prisma.productModifierGroup.create({
    data: { tenantId, productId: i('product'), modifierGroupId: i('mg') },
  });
  for (const name of ['menu', 'menu-spare']) {
    await prisma.menu.create({
      data: { id: i(name), tenantId, name: 'All Day', slug: i(name) },
    });
  }
  await prisma.menuProduct.create({
    data: { tenantId, menuId: i('menu'), productId: i('product') },
  });
  await prisma.locationMenu.create({
    data: { tenantId, locationId: i('location'), menuId: i('menu') },
  });
  await prisma.locationProductPriceOverride.create({
    data: {
      tenantId,
      locationId: i('location'),
      menuId: i('menu'),
      productId: i('product'),
      price: 450,
    },
  });
  await prisma.locationProductAvailabilityOverride.create({
    data: {
      tenantId,
      locationId: i('location'),
      menuId: i('menu'),
      productId: i('product'),
      isAvailable: false,
    },
  });
  for (const name of ['reward', 'reward-spare']) {
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
  await prisma.loyaltyRewardProduct.create({
    data: { tenantId, rewardId: i('reward'), productId: i('product') },
  });
  await prisma.loyaltyRewardCategory.create({
    data: { tenantId, rewardId: i('reward'), categoryId: i('category') },
  });
  for (const name of ['bonus', 'bonus-spare']) {
    await prisma.loyaltyBonusPromotion.create({
      data: {
        id: i(name),
        tenantId,
        name: 'Double Points',
        type: 'MULTIPLIER',
        bonusValue: 2,
      },
    });
  }
  await prisma.loyaltyBonusPromotionProduct.create({
    data: { tenantId, promotionId: i('bonus'), productId: i('product') },
  });
  await prisma.loyaltyBonusPromotionLocation.create({
    data: { tenantId, promotionId: i('bonus'), locationId: i('location') },
  });
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
  await prisma.promotionProduct.create({
    data: { tenantId, promotionId: i('promo'), productId: i('product') },
  });
  await prisma.promotionCategory.create({
    data: { tenantId, promotionId: i('promo'), categoryId: i('category') },
  });
  await prisma.promotionLocation.create({
    data: { tenantId, promotionId: i('promo'), locationId: i('location') },
  });
  for (const name of ['media', 'media-spare']) {
    await prisma.mediaAsset.create({
      data: {
        id: i(name),
        tenantId,
        objectKey: i(name),
        fileName: 'hero.png',
        contentType: 'image/png',
        fileSizeBytes: 1,
        uploadedByInternalUserId: i('staff'),
      },
    });
  }
  await prisma.campaign.create({
    data: {
      id: i('campaign'),
      tenantId,
      name: 'Spring',
      promotionId: i('promo'),
      loyaltyBonusPromotionId: i('bonus'),
      mediaAssetId: i('media'),
    },
  });
  await prisma.campaign.create({
    data: { id: i('campaign-spare'), tenantId, name: 'Spare' },
  });
  await prisma.campaignProduct.create({
    data: {
      tenantId,
      campaignId: i('campaign'),
      productId: i('product'),
      displayOrder: 0,
    },
  });
  // Orders and their product snapshots.
  await prisma.paymentAttempt.create({
    select: { id: true },
    data: {
      id: i('pay'),
      tenantId,
      idempotencyKey: i('pay'),
      provider: 'fake',
      amount: 500,
      currency: 'USD',
      locationId: i('location'),
    },
  });
  await prisma.order.create({
    data: {
      id: i('order'),
      tenantId,
      orderNumber: i('order'),
      accessToken: i('order-token'),
      locationId: i('location'),
      paymentAttemptId: i('pay'),
      guestName: 'Fictional Guest',
      guestPhone: '5550000000',
      currency: 'USD',
      subtotal: 500,
    },
  });
  await prisma.orderLine.create({
    data: {
      id: i('line'),
      tenantId,
      orderId: i('order'),
      productId: i('snap-product'),
      productName: 'Fictional Latte',
      unitPrice: 500,
      quantity: 1,
      lineTotal: 500,
      currency: 'USD',
      selections: [],
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
      freeItemProductId: i('snap-product'),
    },
  });
  await prisma.orderLoyaltyBonus.create({
    data: {
      id: i('order-bonus'),
      tenantId,
      orderId: i('order'),
      totalBonusBeans: 10,
    },
  });
  await prisma.orderLoyaltyBonusItem.create({
    data: {
      id: i('bonus-item'),
      tenantId,
      orderLoyaltyBonusId: i('order-bonus'),
      sourcePromotionId: i('bonus'),
      promotionName: 'Double Points',
      promotionType: 'MULTIPLIER',
      bonusValue: 2,
      productId: i('snap-product'),
      productName: 'Fictional Latte',
      qualifyingUnits: 1,
      qualifyingSpendMinorUnits: 500,
      standardBeansForItem: 10,
      bonusBeans: 10,
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
      freeItemProductId: i('snap-product'),
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

// Prices, availability, menus and the product snapshots of every order.
async function catalogState(url: string): Promise<string> {
  return withScratchClient(url, async (client) => {
    const { rows } = await client.query<{ s: string }>(
      `SELECT concat_ws(' | ',
         (SELECT string_agg(concat_ws(':', "tenantId", "locationId", "menuId", "productId", price), ',' ORDER BY "tenantId") FROM "LocationProductPriceOverride"),
         (SELECT string_agg(concat_ws(':', "tenantId", "locationId", "menuId", "productId", "isAvailable"), ',' ORDER BY "tenantId") FROM "LocationProductAvailabilityOverride"),
         (SELECT string_agg(concat_ws(':', "tenantId", "menuId", "productId"), ',' ORDER BY "tenantId") FROM "MenuProduct"),
         (SELECT string_agg(concat_ws(':', id, "productId", "lineTotal"), ',' ORDER BY id) FROM "OrderLine"),
         (SELECT string_agg(concat_ws(':', id, "freeItemProductId", "discountMinorUnits"), ',' ORDER BY id) FROM "OrderPromotionRedemption")
       ) AS s`,
    );
    return rows[0].s;
  });
}

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

const prismaOutcome = (write: Promise<unknown>) =>
  write.then(
    () => 'accepted',
    (e: {
      name?: string;
      code?: string;
      meta?: { driverAdapterError?: { cause?: { originalCode?: string } } };
    }) =>
      // Refused by Prisma before reaching PostgreSQL (an argument the
      // composite relation does not allow).
      e.name === 'PrismaClientValidationError'
        ? 'validation'
        : `${e.code}/${e.meta?.driverAdapterError?.cause?.originalCode ?? '-'}`,
  );

// A move of a protected table's fixture row to business `y` that the
// foreign keys alone would allow (every reference re-pointed to `y`, and a
// row nothing references), so only the ownership trigger stands in its way.
const MOVES: Record<string, (x: Tag, y: Tag) => string> = (() => {
  const Y = (y: Tag, n: string) => `'${id(y, n)}'`;
  const t = (y: Tag) => `"tenantId" = '${TENANTS[y]}'`;
  const join = (table: string, sets: (y: Tag) => string) => (x: Tag, y: Tag) =>
    `UPDATE "${table}" SET ${t(y)}, ${sets(y)} WHERE "tenantId" = '${TENANTS[x]}'`;
  return {
    Campaign: (x, y) =>
      `UPDATE "Campaign" SET ${t(y)} WHERE id = '${id(x, 'campaign-spare')}'`,
    CampaignProduct: join(
      'CampaignProduct',
      (y) =>
        `"campaignId" = ${Y(y, 'campaign-spare')}, "productId" = ${Y(y, 'product-spare')}`,
    ),
    Category: (x, y) =>
      `UPDATE "Category" SET ${t(y)} WHERE id = '${id(x, 'category-spare')}'`,
    LocationMenu: join(
      'LocationMenu',
      (y) =>
        `"locationId" = ${Y(y, 'location-spare')}, "menuId" = ${Y(y, 'menu-spare')}`,
    ),
    LocationProductAvailabilityOverride: join(
      'LocationProductAvailabilityOverride',
      (y) =>
        `"locationId" = ${Y(y, 'location-spare')}, "menuId" = ${Y(y, 'menu-spare')}, "productId" = ${Y(y, 'product-spare')}`,
    ),
    LocationProductPriceOverride: join(
      'LocationProductPriceOverride',
      (y) =>
        `"locationId" = ${Y(y, 'location-spare')}, "menuId" = ${Y(y, 'menu-spare')}, "productId" = ${Y(y, 'product-spare')}`,
    ),
    LoyaltyBonusPromotionLocation: join(
      'LoyaltyBonusPromotionLocation',
      (y) =>
        `"promotionId" = ${Y(y, 'bonus-spare')}, "locationId" = ${Y(y, 'location-spare')}`,
    ),
    LoyaltyBonusPromotionProduct: join(
      'LoyaltyBonusPromotionProduct',
      (y) =>
        `"promotionId" = ${Y(y, 'bonus-spare')}, "productId" = ${Y(y, 'product-spare')}`,
    ),
    LoyaltyRewardCategory: join(
      'LoyaltyRewardCategory',
      (y) =>
        `"rewardId" = ${Y(y, 'reward-spare')}, "categoryId" = ${Y(y, 'category-spare')}`,
    ),
    LoyaltyRewardProduct: join(
      'LoyaltyRewardProduct',
      (y) =>
        `"rewardId" = ${Y(y, 'reward-spare')}, "productId" = ${Y(y, 'product-spare')}`,
    ),
    Menu: (x, y) =>
      `UPDATE "Menu" SET ${t(y)} WHERE id = '${id(x, 'menu-spare')}'`,
    MenuProduct: join(
      'MenuProduct',
      (y) =>
        `"menuId" = ${Y(y, 'menu-spare')}, "productId" = ${Y(y, 'product-spare')}`,
    ),
    ModifierGroup: (x, y) =>
      `UPDATE "ModifierGroup" SET ${t(y)} WHERE id = '${id(x, 'mg-spare')}'`,
    ModifierOption: (x, y) =>
      `UPDATE "ModifierOption" SET ${t(y)}, "modifierGroupId" = ${Y(y, 'mg-spare')} WHERE id = '${id(x, 'option')}'`,
    Product: (x, y) =>
      `UPDATE "Product" SET ${t(y)}, "categoryId" = ${Y(y, 'category-spare')} WHERE id = '${id(x, 'product-spare')}'`,
    ProductModifierGroup: join(
      'ProductModifierGroup',
      (y) =>
        `"productId" = ${Y(y, 'product-spare')}, "modifierGroupId" = ${Y(y, 'mg-spare')}`,
    ),
    PromotionCategory: join(
      'PromotionCategory',
      (y) =>
        `"promotionId" = ${Y(y, 'promo-spare')}, "categoryId" = ${Y(y, 'category-spare')}`,
    ),
    PromotionLocation: join(
      'PromotionLocation',
      (y) =>
        `"promotionId" = ${Y(y, 'promo-spare')}, "locationId" = ${Y(y, 'location-spare')}`,
    ),
    PromotionProduct: join(
      'PromotionProduct',
      (y) =>
        `"promotionId" = ${Y(y, 'promo-spare')}, "productId" = ${Y(y, 'product-spare')}`,
    ),
  };
})();

// The 4C-4 definition of reject_cross_tenant_snapshot (no source lock) —
// used to prove the lock is what closes the race.
const UNLOCKED_SNAPSHOT_FUNCTION = (() => {
  const sql = readFileSync(
    join(migrationsDir, FOUR_C_4, 'migration.sql'),
    'utf8',
  );
  const start = sql.indexOf('CREATE FUNCTION "reject_cross_tenant_snapshot"()');
  const end =
    sql.indexOf('$reject_cross_tenant_snapshot$;', start) +
    '$reject_cross_tenant_snapshot$;'.length;
  return sql
    .slice(start, end)
    .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
})();

describe('Tenant-enforced catalog, offers and product snapshots (Security 4C-6)', () => {
  it('the inventory marks exactly these 33 relationships as tenant-enforced, with matching delete rules; product snapshots stay historical', () => {
    const ids = new Set(RELATIONSHIPS.map(relationshipId));
    const inScope = TENANT_RELATIONSHIPS.filter(
      (r): r is DirectReference =>
        r.kind === 'composite-fk-candidate' && ids.has(r.id),
    );
    const rule = { CASCADE: 'Cascade', RESTRICT: 'Restrict' } as const;
    expect(
      inScope
        .map(
          (r) =>
            `${r.id}->${r.target} ${r.onDelete} ${r.nullable} ${r.hasForeignKey} ${r.tenantEnforced}`,
        )
        .sort(),
    ).toEqual(
      RELATIONSHIPS.map(
        (r) =>
          `${relationshipId(r)}->${r.parent} ${rule[r.onDelete]} ${r.optional} true true`,
      ).sort(),
    );
    expect(
      TENANT_RELATIONSHIPS.filter(
        (r) =>
          r.kind === 'historical-snapshot' &&
          SNAPSHOTS.some((s) => r.id === `${s.table}.${s.column}`),
      )
        .map((r) => `${r.id}->${(r as DirectReference).target}`)
        .sort(),
    ).toEqual(SNAPSHOTS.map((s) => `${s.table}.${s.column}->Product`).sort());
    // Every catalog/offer table's references to catalog/offer parents are
    // now enforced; none is left behind.
    const catalog = new Set(PROTECTED_TABLES);
    expect(
      TENANT_RELATIONSHIPS.filter(
        (r): r is DirectReference =>
          r.kind === 'composite-fk-candidate' &&
          catalog.has(r.model) &&
          !r.tenantEnforced,
      ).map((r) => r.id),
    ).toEqual([]);
  });

  it('schema.prisma declares each as a (tenantId, column) -> (tenantId, id) relation with ON UPDATE RESTRICT', () => {
    const models = new Map(
      [...schema.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    const rule = { CASCADE: 'Cascade', RESTRICT: 'Restrict' } as const;
    for (const r of RELATIONSHIPS) {
      const relation = new RegExp(
        `^\\s+\\w+\\s+${r.parent}\\??\\s+@relation\\((?:"\\w+", )?fields: \\[tenantId, ${r.column}\\], references: \\[tenantId, id\\], onDelete: (\\w+), onUpdate: Restrict\\)`,
        'm',
      ).exec(models.get(r.child) ?? '');
      expect([relationshipId(r), relation?.[1]]).toEqual([
        relationshipId(r),
        rule[r.onDelete],
      ]);
    }
    for (const s of SNAPSHOTS) {
      expect(models.get(s.table)).toMatch(
        new RegExp(`@@index\\(\\[${s.column}\\]\\)`),
      );
    }
  });

  it('the migration is ONE DO block: version and 4C-3/4C-4 checks, read-only preflight of every relationship and product snapshot, lock_timeout, then the keys, indexes, functions and triggers', () => {
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
      /^DO \$tenant_fk_catalog_offers_snapshots\$[\s\S]*\$tenant_fk_catalog_offers_snapshots\$;$/,
    );
    const order = [
      "set_config('lock_timeout', '5s', true)",
      "current_setting('server_version_num')::int < 150000",
      "to_regprocedure('public.reject_tenant_reassignment()') IS NULL",
      "to_regprocedure('public.reject_cross_tenant_snapshot()') IS NULL",
      ...RELATIONSHIPS.map(
        (r) => `('${r.child}', '${r.column}', '${r.parent}')`,
      ),
      ...SNAPSHOTS.map((s) => `('${s.table}', '${s.column}')`),
      'Security 4C-6 aborted',
      'DROP CONSTRAINT',
      'ADD CONSTRAINT',
      'CREATE INDEX',
      'CREATE OR REPLACE FUNCTION "reject_cross_tenant_snapshot"()',
      'CREATE OR REPLACE FUNCTION "reject_reused_snapshot_source"()',
      'CREATE TRIGGER "OrderLine_productId_same_tenant"',
      'CREATE TRIGGER "Product_id_not_reused"',
      'CREATE TRIGGER "Campaign_tenantId_immutable"',
    ].map((s) => code.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    for (const r of RELATIONSHIPS) {
      expect(code).toContain(
        `ADD CONSTRAINT "${constraintName(r)}" FOREIGN KEY ("tenantId", "${r.column}") REFERENCES "${r.parent}"("tenantId", "id") ON DELETE ${r.onDelete} ON UPDATE RESTRICT;`,
      );
    }
    expect(code.match(/ADD CONSTRAINT/g)).toHaveLength(33);
    expect(code.match(/DROP CONSTRAINT/g)).toHaveLength(32);
    expect(code.match(/CREATE INDEX/g)).toHaveLength(5);
    expect(code.match(/CREATE TRIGGER/g)).toHaveLength(19 + 2);
    expect(code).toContain('FOR KEY SHARE');
    // It replaces 4C-4's two snapshot functions (never drops them) and
    // never touches 4C-3's; it never repairs, reassigns or deletes data.
    expect(code).not.toMatch(
      /DROP FUNCTION|"reject_tenant_reassignment"\(\) RETURNS/,
    );
    expect(code).not.toMatch(
      /\bUPDATE\s+"|\bDELETE\s+FROM\b|\bINSERT\s+INTO\b|\bTRUNCATE\b/i,
    );
  });

  it('the rollback is ONE DO block that removes only what 4C-6 added, restores the 32 original keys and the exact 4C-4 snapshot functions — keeping 4C-3’s function', () => {
    expect(isAppliedAtomically(rollbackSql)).toBe(true);
    expect(rollbackSql.match(/DROP TRIGGER/g)).toHaveLength(19 + 2);
    for (const t of PROTECTED_TABLES) {
      expect(rollbackSql).toContain(
        `DROP TRIGGER "${t}_tenantId_immutable" ON "${t}";`,
      );
    }
    for (const r of RELATIONSHIPS)
      expect(rollbackSql).toContain(`DROP CONSTRAINT "${constraintName(r)}"`);
    expect(rollbackSql.match(/ADD CONSTRAINT "\w+_fkey"/g)).toHaveLength(32);
    expect(rollbackSql).not.toContain('Campaign_mediaAssetId_fkey');
    expect(rollbackSql.match(/DROP INDEX/g)).toHaveLength(5);
    // The 4C-4 bodies, verbatim (no source lock; one pair per trigger).
    const fourC4 = readFileSync(
      join(migrationsDir, FOUR_C_4, 'migration.sql'),
      'utf8',
    );
    for (const fn of [
      'reject_cross_tenant_snapshot',
      'reject_reused_snapshot_source',
    ]) {
      const start = fourC4.indexOf(`CREATE FUNCTION "${fn}"()`);
      const end = fourC4.indexOf(`$${fn}$;`, start) + `$${fn}$;`.length;
      expect(rollbackSql).toContain(
        fourC4
          .slice(start, end)
          .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'),
      );
    }
    expect(rollbackSql.replace(/--.*$/gm, '')).not.toMatch(
      /DROP FUNCTION|reject_tenant_reassignment/,
    );
    expect(rollbackSql).not.toMatch(
      /\bUPDATE\s+"|\bDELETE\s+FROM\b|\bINSERT\s+INTO\b|\bTRUNCATE\b/i,
    );
  });

  it('the migrated test database enforces every relationship, ownership, product snapshot and lock (catalog regression guard)', async () => {
    expect(
      await withScratchClient(baseUrl, (client) => tenantEnforcement(client)),
    ).toEqual(EXPECTED_ENFORCEMENT);
  });

  describe('on a scratch database with three fictional businesses', () => {
    let scratch: ScratchDatabase;
    let prisma: PrismaClient;
    let beforeData: string;
    let beforeCatalog: string;
    const sql = <T>(fn: (client: Client) => Promise<T>) =>
      withScratchClient(scratch.url, fn);

    beforeAll(async () => {
      scratch = await createScratchDatabase(baseUrl, 'fk_catalog');
      await applyMigrations(scratch.url, migrations);
      await loadFixture(scratch.url);
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: scratch.url }),
      });
      beforeData = await dataChecksum(scratch.url);
      beforeCatalog = await catalogState(scratch.url);
    });

    afterAll(async () => {
      await prisma?.$disconnect();
      await scratch?.drop();
    });

    it('carries exactly the expected keys, triggers, indexes and function traits', async () => {
      expect(await sql(tenantEnforcement)).toEqual(EXPECTED_ENFORCEMENT);
    });

    it('accepts same-business references, by UPDATE and by INSERT, for every relationship and business', async () => {
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const r of RELATIONSHIPS) {
          for (const x of TAGS) {
            const parent = id(x, SPARE[r.parent]);
            out.push(
              `${relationshipId(r)} ${x} update ${await attempt(client, `UPDATE "${r.child}" SET "${r.column}" = '${parent}' WHERE ${rowWhere(r.child, x)}`)}`,
              `${relationshipId(r)} ${x} insert ${await attempt(client, insertCopy(r, x, parent))}`,
            );
          }
        }
        return out;
      });
      expect(results.filter((s) => !s.endsWith(' ok'))).toEqual([]);
      expect(results).toHaveLength(33 * 3 * 2);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('rejects every cross-business reference by direct SQL — every relationship, every ordered pair, UPDATE and INSERT', async () => {
      const results = await sql(async (client) => {
        const out: Record<string, string> = {};
        for (const r of RELATIONSHIPS) {
          for (const [x, y] of PAIRS) {
            const foreign = id(y, SPARE[r.parent]);
            out[`${relationshipId(r)} ${x}->${y} update`] = await attempt(
              client,
              `UPDATE "${r.child}" SET "${r.column}" = '${foreign}' WHERE ${rowWhere(r.child, x)}`,
            );
            out[`${relationshipId(r)} ${x}->${y} insert`] = await attempt(
              client,
              insertCopy(r, x, foreign),
            );
          }
        }
        return out;
      });
      const expected: Record<string, string> = {};
      for (const r of RELATIONSHIPS) {
        for (const [x, y] of PAIRS) {
          for (const op of ['update', 'insert']) {
            expected[`${relationshipId(r)} ${x}->${y} ${op}`] =
              `23503 ${constraintName(r)}`;
          }
        }
      }
      expect(results).toEqual(expected);
      expect(Object.keys(results)).toHaveLength(33 * 6 * 2);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('rejects a reference to a catalog or offer record that does not exist; optional campaign links may be cleared', async () => {
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const r of RELATIONSHIPS) {
          out.push(
            `${relationshipId(r)} missing ${await attempt(client, `UPDATE "${r.child}" SET "${r.column}" = 'cat-missing' WHERE ${rowWhere(r.child, 'a')}`)}`,
          );
          if (r.optional) {
            out.push(
              `${relationshipId(r)} null ${await attempt(client, `UPDATE "${r.child}" SET "${r.column}" = NULL WHERE ${rowWhere(r.child, 'b')}`)}`,
            );
          }
        }
        return out;
      });
      expect(results).toEqual(
        RELATIONSHIPS.flatMap((r) => [
          `${relationshipId(r)} missing 23503 ${constraintName(r)}`,
          ...(r.optional ? [`${relationshipId(r)} null ok`] : []),
        ]),
      );
    });

    it('rejects moving any row of the 19 protected tables to another business (immutable tenantId), referenced or not', async () => {
      const results = await sql(async (client) => {
        const out: Record<string, string> = {};
        for (const t of PROTECTED_TABLES) {
          for (const [x, y] of PAIRS) {
            out[`${t} ${x}->${y}`] = (
              await attempt(
                client,
                `UPDATE "${t}" SET "tenantId" = '${TENANTS[y]}' WHERE "tenantId" = '${TENANTS[x]}'`,
              )
            ).split(' ')[0];
          }
        }
        return out;
      });
      expect(Object.values(results).filter((v) => v !== '23001')).toEqual([]);
      expect(Object.keys(results)).toHaveLength(19 * 6);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('cross-business Prisma writes cannot attach, re-point, nest or move catalog and offer records — and prices, menus and snapshots stay unchanged', async () => {
      const outcomes: Record<string, string> = {};
      for (const [x, y] of PAIRS) {
        const X = (n: string) => id(x, n);
        const Y = (n: string) => id(y, n);
        const writes: Record<string, () => Promise<unknown>> = {
          productCategoryConnect: () =>
            prisma.product.update({
              where: { id: X('product') },
              data: { category: { connect: { id: Y('category') } } },
            }),
          productCategoryUnchecked: () =>
            prisma.product.update({
              where: { id: X('product') },
              data: { categoryId: Y('category') },
            }),
          productCreateForeignCategory: () =>
            prisma.product.create({
              data: {
                tenantId: TENANTS[x],
                name: 'x',
                slug: `x-${x}${y}`,
                categoryId: Y('category'),
              },
            }),
          categoryNestedProductCreate: () =>
            prisma.category.update({
              where: { id: Y('category') },
              data: {
                products: {
                  create: {
                    tenantId: TENANTS[x],
                    name: 'x',
                    slug: `n-${x}${y}`,
                  } as never,
                },
              },
            }),
          categoryStealsProduct: () =>
            prisma.category.update({
              where: { id: X('category-spare') },
              data: { products: { connect: { id: Y('product-spare') } } },
            }),
          modifierGroupStealsOption: () =>
            prisma.modifierGroup.update({
              where: { id: X('mg-spare') },
              data: { options: { connect: { id: Y('option') } } },
            }),
          productNestedForeignModifier: () =>
            prisma.product.update({
              where: { id: X('product-spare') },
              data: {
                modifierGroups: { create: { modifierGroupId: Y('mg') } },
              },
            }),
          menuNestedForeignProduct: () =>
            prisma.menu.update({
              where: { id: X('menu-spare') },
              data: { products: { create: { productId: Y('product') } } },
            }),
          menuProductUncheckedForeign: () =>
            prisma.menuProduct.updateMany({
              where: { tenantId: TENANTS[x] },
              data: { productId: Y('product-spare') },
            }),
          locationMenuForeignMenu: () =>
            prisma.locationMenu.create({
              data: {
                tenantId: TENANTS[x],
                locationId: X('location-spare'),
                menuId: Y('menu'),
              },
            }),
          priceOverrideUpsertForeignProduct: () =>
            prisma.locationProductPriceOverride.upsert({
              where: {
                locationId_menuId_productId: {
                  locationId: X('location'),
                  menuId: X('menu'),
                  productId: Y('product'),
                },
              },
              create: {
                tenantId: TENANTS[x],
                locationId: X('location'),
                menuId: X('menu'),
                productId: Y('product'),
                price: 1,
              },
              update: { price: 1 },
            }),
          availabilityOverrideForeignLocation: () =>
            prisma.locationProductAvailabilityOverride.create({
              data: {
                tenantId: TENANTS[x],
                locationId: Y('location'),
                menuId: X('menu'),
                productId: X('product'),
                isAvailable: true,
              },
            }),
          rewardNestedForeignProduct: () =>
            prisma.loyaltyReward.update({
              where: { id: X('reward-spare') },
              data: {
                eligibleProducts: { create: { productId: Y('product') } },
              },
            }),
          rewardNestedForeignCategory: () =>
            prisma.loyaltyReward.update({
              where: { id: X('reward-spare') },
              data: {
                eligibleCategories: { create: { categoryId: Y('category') } },
              },
            }),
          bonusNestedForeignProduct: () =>
            prisma.loyaltyBonusPromotion.update({
              where: { id: X('bonus-spare') },
              data: {
                eligibleProducts: { create: { productId: Y('product') } },
              },
            }),
          bonusNestedForeignLocation: () =>
            prisma.loyaltyBonusPromotion.update({
              where: { id: X('bonus-spare') },
              data: {
                eligibleLocations: { create: { locationId: Y('location') } },
              },
            }),
          promotionNestedForeignProduct: () =>
            prisma.promotion.update({
              where: { id: X('promo-spare') },
              data: {
                eligibleProducts: { create: { productId: Y('product') } },
              },
            }),
          promotionNestedForeignCategory: () =>
            prisma.promotion.update({
              where: { id: X('promo-spare') },
              data: {
                eligibleCategories: { create: { categoryId: Y('category') } },
              },
            }),
          promotionNestedForeignLocation: () =>
            prisma.promotion.update({
              where: { id: X('promo-spare') },
              data: {
                eligibleLocations: { create: { locationId: Y('location') } },
              },
            }),
          promotionStealsEligibility: () =>
            prisma.promotionProduct.updateMany({
              where: { tenantId: TENANTS[y] },
              data: { promotionId: X('promo-spare') },
            }),
          campaignPromotionConnect: () =>
            prisma.campaign.update({
              where: { id: X('campaign') },
              data: { promotion: { connect: { id: Y('promo') } } },
            }),
          campaignBonusUnchecked: () =>
            prisma.campaign.update({
              where: { id: X('campaign') },
              data: { loyaltyBonusPromotionId: Y('bonus') },
            }),
          campaignMediaUnchecked: () =>
            prisma.campaign.update({
              where: { id: X('campaign') },
              data: { mediaAssetId: Y('media') },
            }),
          campaignMediaConnect: () =>
            prisma.campaign.update({
              where: { id: X('campaign') },
              data: { mediaAsset: { connect: { id: Y('media') } } },
            }),
          campaignCreateForeignMedia: () =>
            prisma.campaign.create({
              data: {
                tenantId: TENANTS[x],
                name: 'x',
                mediaAssetId: Y('media-spare'),
              },
            }),
          campaignNestedForeignFeatured: () =>
            prisma.campaign.update({
              where: { id: X('campaign-spare') },
              data: {
                featuredProducts: {
                  create: { productId: Y('product'), displayOrder: 0 },
                },
              },
            }),
          campaignStealsFeatured: () =>
            prisma.campaign.update({
              where: { id: X('campaign-spare') },
              data: {
                featuredProducts: {
                  connect: {
                    campaignId_productId: {
                      campaignId: Y('campaign'),
                      productId: Y('product'),
                    },
                  },
                },
              },
            }),
          productMoveUpdateMany: () =>
            prisma.product.updateMany({
              where: { id: X('product-spare') },
              data: { tenantId: TENANTS[y] },
            }),
          campaignMoveUpdateMany: () =>
            prisma.campaign.updateMany({
              where: { id: X('campaign-spare') },
              data: { tenantId: TENANTS[y] },
            }),
          orderLineForeignProduct: () =>
            prisma.orderLine.update({
              where: { id: X('line') },
              data: { productId: Y('product') },
            }),
          bonusItemForeignProduct: () =>
            prisma.orderLoyaltyBonusItem.update({
              where: { id: X('bonus-item') },
              data: { productId: Y('product') },
            }),
          productCreateReusedSnapshotId: () =>
            prisma.product.create({
              // An id only business x's snapshots name, offered to business y.
              data: {
                id: `reuse-${x}${y}`,
                tenantId: TENANTS[y],
                name: 'x',
                slug: `r-${x}${y}`,
                categoryId: Y('category'),
              },
            }),
        };
        for (const [name, write] of Object.entries(writes)) {
          outcomes[`${name} ${x}->${y}`] = await prismaOutcome(write());
        }
      }
      expect(
        Object.entries(outcomes)
          .filter(([, o]) => o === 'accepted')
          .map(([k]) => k),
      ).toEqual(
        // Only the reuse probe is "accepted": no snapshot names `reuse-xy` yet
        // (proved properly in the snapshot tests below), so creating it is
        // legitimate — it is listed here to keep the matrix honest.
        PAIRS.map(([x, y]) => `productCreateReusedSnapshotId ${x}->${y}`),
      );
      expect(
        Object.entries(outcomes).filter(
          ([k, o]) =>
            !k.startsWith('productCreateReusedSnapshotId') &&
            !['P2003/23503', 'P2039/23001', 'validation'].includes(o),
        ),
      ).toEqual([]);
      // A nested product cannot even name a business: Prisma takes tenantId
      // from the category (composite relation) and refuses the argument.
      expect(
        Object.entries(outcomes)
          .filter(([, o]) => o === 'validation')
          .map(([k]) => k),
      ).toEqual(
        PAIRS.map(([x, y]) => `categoryNestedProductCreate ${x}->${y}`),
      );
      expect(Object.keys(outcomes)).toHaveLength(32 * 6);
      // Remove the six legitimate products, then everything is as before.
      await prisma.product.deleteMany({
        where: { id: { startsWith: 'reuse-' } },
      });
      expect(await catalogState(scratch.url)).toBe(beforeCatalog);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('same-business catalog, menu, override, offer and campaign workflows keep working (nested creates, connects, upserts, clearing campaign links)', async () => {
      const rollback = new Error('rollback');
      await prisma
        .$transaction(async (tx) => {
          for (const x of TAGS) {
            const X = (n: string) => id(x, n);
            const tenantId = TENANTS[x];
            const group = await tx.modifierGroup.create({
              data: {
                tenantId,
                name: 'Syrup',
                options: { create: [{ name: 'Vanilla' }, { name: 'Caramel' }] },
              },
              include: { options: true },
            });
            expect(group.options.map((o) => o.tenantId)).toEqual([
              tenantId,
              tenantId,
            ]);
            const product = await tx.product.create({
              data: {
                tenantId,
                name: 'New Drink',
                slug: `new-${x}`,
                categoryId: X('category'),
                modifierGroups: { create: [{ modifierGroupId: group.id }] },
              },
            });
            await tx.menu.update({
              where: { id: X('menu') },
              data: { products: { create: { productId: product.id } } },
            });
            await tx.locationProductPriceOverride.upsert({
              where: {
                locationId_menuId_productId: {
                  locationId: X('location'),
                  menuId: X('menu'),
                  productId: product.id,
                },
              },
              create: {
                tenantId,
                locationId: X('location'),
                menuId: X('menu'),
                productId: product.id,
                price: 525,
              },
              update: { price: 525 },
            });
            await tx.promotion.update({
              where: { id: X('promo-spare') },
              data: {
                eligibleProducts: { create: { productId: product.id } },
                eligibleCategories: { create: { categoryId: X('category') } },
                eligibleLocations: { create: { locationId: X('location') } },
              },
            });
            await tx.loyaltyReward.update({
              where: { id: X('reward-spare') },
              data: { eligibleProducts: { create: { productId: product.id } } },
            });
            await tx.loyaltyBonusPromotion.update({
              where: { id: X('bonus-spare') },
              data: {
                eligibleProducts: { create: { productId: product.id } },
                eligibleLocations: { create: { locationId: X('location') } },
              },
            });
            const campaign = await tx.campaign.create({
              data: {
                tenantId,
                name: 'Launch',
                promotionId: X('promo-spare'),
                mediaAssetId: X('media-spare'),
                featuredProducts: {
                  create: [{ productId: product.id, displayOrder: 0 }],
                },
              },
              include: { featuredProducts: true },
            });
            expect(campaign.featuredProducts[0].tenantId).toBe(tenantId);
            // Connect within the business; then clear each link by its column.
            await tx.campaign.update({
              where: { id: campaign.id },
              data: {
                loyaltyBonusPromotion: { connect: { id: X('bonus-spare') } },
              },
            });
            await tx.campaign.update({
              where: { id: campaign.id },
              data: {
                promotionId: null,
                loyaltyBonusPromotionId: null,
                mediaAssetId: null,
              },
            });
            // A product snapshot of the same business.
            await tx.orderLine.update({
              where: { id: X('line') },
              data: { productId: product.id },
            });
          }
          throw rollback;
        })
        .catch((e: unknown) => {
          if (e !== rollback) throw e;
        });
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('Prisma `disconnect` of an optional composite campaign link is refused (it would clear tenantId); clearing the column works', async () => {
      const outcomes = [
        await prismaOutcome(
          prisma.campaign.update({
            where: { id: id('a', 'campaign') },
            data: { promotion: { disconnect: true } },
          }),
        ),
        await prismaOutcome(
          prisma.campaign.update({
            where: { id: id('b', 'campaign') },
            data: { mediaAsset: { disconnect: true } },
          }),
        ),
      ];
      expect(outcomes).toEqual(['P2039/23001', 'P2039/23001']);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    describe('product snapshots', () => {
      it('a new or changed product snapshot must name an existing product of the SAME business — every snapshot, every pair; same-business values are accepted', async () => {
        const results = await sql(async (client) => {
          const out: string[] = [];
          for (const s of SNAPSHOTS) {
            for (const [x, y] of PAIRS) {
              out.push(
                `${s.table} ${x}->${y} ${await attempt(client, `UPDATE "${s.table}" SET "${s.column}" = '${id(y, 'product')}' WHERE id = '${id(x, s.row)}'`)}`,
              );
            }
            out.push(
              `${s.table} missing ${await attempt(client, `UPDATE "${s.table}" SET "${s.column}" = 'cat-missing' WHERE id = '${id('a', s.row)}'`)}`,
            );
            out.push(
              `${s.table} same ${await attempt(client, `UPDATE "${s.table}" SET "${s.column}" = '${id('a', 'product')}' WHERE id = '${id('a', s.row)}'`)}`,
            );
          }
          return out;
        });
        expect(results).toEqual(
          SNAPSHOTS.flatMap((s) => [
            ...PAIRS.map(([x, y]) => `${s.table} ${x}->${y} 23503`),
            `${s.table} missing 23503`,
            `${s.table} same ok`,
          ]),
        );
      });

      it('an unchanged snapshot outlives its deleted product (history kept); re-pointing it then needs an existing same-business product', async () => {
        const results = await sql(async (client) => {
          await client.query('BEGIN');
          try {
            await client.query(
              `DELETE FROM "Product" WHERE id = '${id('a', 'snap-product')}'`,
            );
            const kept = await client.query<{ n: number }>(
              `SELECT (SELECT count(*) FROM "OrderLine" WHERE "productId" = $1)
                    + (SELECT count(*) FROM "OrderLoyaltyBonusItem" WHERE "productId" = $1)
                    + (SELECT count(*) FROM "OrderLoyaltyRewardRedemption" WHERE "freeItemProductId" = $1)
                    + (SELECT count(*) FROM "OrderPromotionRedemption" WHERE "freeItemProductId" = $1) AS n`,
              [id('a', 'snap-product')],
            );
            // Unrelated changes to the row are fine.
            await client.query(
              `UPDATE "OrderLine" SET "productName" = 'Renamed' WHERE id = '${id('a', 'line')}'`,
            );
            await client.query('SAVEPOINT p');
            let repoint = 'ok';
            try {
              await client.query(
                `UPDATE "OrderLine" SET "productId" = 'cat-missing' WHERE id = '${id('a', 'line')}'`,
              );
            } catch (e) {
              repoint = String((e as { code?: string }).code);
              await client.query('ROLLBACK TO SAVEPOINT p');
            }
            return { kept: Number(kept.rows[0].n), repoint };
          } finally {
            await client.query('ROLLBACK');
          }
        });
        expect(results).toEqual({ kept: 4, repoint: '23503' });
      });

      it('another business can never take a deleted product’s id while a kept snapshot names it (INSERT and id UPDATE, each snapshot alone); the same business can', async () => {
        const results = await sql(async (client) => {
          const out: string[] = [];
          for (const s of SNAPSHOTS) {
            const pid = id('a', 'snap-product');
            const probe = async (statement: string) => {
              await client.query('BEGIN');
              try {
                // Only this snapshot names the product; then delete it.
                for (const other of SNAPSHOTS.filter((o) => o !== s)) {
                  await client.query(
                    `SET LOCAL session_replication_role = replica`,
                  );
                  // Re-point (not null: two of the columns are required) to
                  // another product of the same business.
                  await client.query(
                    `UPDATE "${other.table}" SET "${other.column}" = '${id('a', 'product')}' WHERE "${other.column}" = '${pid}'`,
                  );
                  await client.query(
                    `SET LOCAL session_replication_role = origin`,
                  );
                }
                await client.query(`DELETE FROM "Product" WHERE id = '${pid}'`);
                await client.query('SAVEPOINT p');
                try {
                  await client.query(statement);
                  return 'ok';
                } catch (e) {
                  return String((e as { code?: string }).code);
                }
              } finally {
                await client.query('ROLLBACK');
              }
            };
            for (const y of ['b', 'c'] as const) {
              out.push(
                `${s.table} insert by ${y}: ${await probe(`INSERT INTO "Product" ("id", "tenantId", "name", "slug", "categoryId", "updatedAt") VALUES ('${pid}', '${TENANTS[y]}', 'Taken', 'taken', '${id(y, 'category')}', now())`)}`,
              );
              out.push(
                `${s.table} id update by ${y}: ${await probe(`UPDATE "Product" SET id = '${pid}' WHERE id = '${id(y, 'product-spare')}'`)}`,
              );
            }
            out.push(
              `${s.table} insert by a: ${await probe(`INSERT INTO "Product" ("id", "tenantId", "name", "slug", "categoryId", "updatedAt") VALUES ('${pid}', '${TENANTS.a}', 'Back', 'back', '${id('a', 'category')}', now())`)}`,
            );
          }
          return out;
        });
        expect(results).toEqual(
          SNAPSHOTS.flatMap((s) => [
            `${s.table} insert by b: 23505`,
            `${s.table} id update by b: 23505`,
            `${s.table} insert by c: 23505`,
            `${s.table} id update by c: 23505`,
            `${s.table} insert by a: ok`,
          ]),
        );
        expect(await dataChecksum(scratch.url)).toBe(beforeData);
      });

      it('closes the race: a snapshot being written locks its product, so it cannot be deleted and re-created by another business before the snapshot commits — and without the lock it could', async () => {
        const pid = id('a', 'product-spare');
        // Three sessions: T2 writes a snapshot of business A's product; T3
        // deletes that product; T1 creates the same id for business B.
        const race = async () => {
          const t1 = new Client({ connectionString: scratch.url });
          const t2 = new Client({ connectionString: scratch.url });
          const t3 = new Client({ connectionString: scratch.url });
          await Promise.all([t1.connect(), t2.connect(), t3.connect()]);
          try {
            await t2.query('BEGIN');
            await t2.query(
              `INSERT INTO "OrderLine" (id, "tenantId", "orderId", "productId", "productName", "unitPrice", quantity, "lineTotal", currency, selections)
               VALUES ('race-line', '${TENANTS.a}', '${id('a', 'order')}', '${pid}', 'Spare', 1, 1, 1, 'USD', '[]')`,
            );
            await t3.query('BEGIN');
            await t3.query(`SET LOCAL lock_timeout = '500ms'`);
            let deleteWhileSnapshotOpen = 'ok';
            try {
              await t3.query(`DELETE FROM "Product" WHERE id = '${pid}'`);
            } catch (e) {
              deleteWhileSnapshotOpen = String((e as { code?: string }).code);
            }
            await t3.query('ROLLBACK');
            let reuseBeforeCommit = 'not attempted';
            if (deleteWhileSnapshotOpen === 'ok') {
              // Unlocked: the delete went through (uncommitted); commit it and
              // let business B take the id while T2 is still open.
              await t3.query('BEGIN');
              await t3.query(`DELETE FROM "Product" WHERE id = '${pid}'`);
              await t3.query('COMMIT');
              try {
                await t1.query(
                  `INSERT INTO "Product" ("id", "tenantId", "name", "slug", "categoryId", "updatedAt")
                   VALUES ('${pid}', '${TENANTS.b}', 'Taken', 'race-taken', '${id('b', 'category')}', now())`,
                );
                reuseBeforeCommit = 'ok';
              } catch (e) {
                reuseBeforeCommit = String((e as { code?: string }).code);
              }
            }
            await t2.query('COMMIT');
            const cross = await t1.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM "OrderLine" l JOIN "Product" p ON p.id = l."productId" WHERE p."tenantId" <> l."tenantId"`,
            );
            return {
              deleteWhileSnapshotOpen,
              reuseBeforeCommit,
              crossBusinessSnapshots: cross.rows[0].n,
            };
          } finally {
            await Promise.all([t1.end(), t2.end(), t3.end()]);
          }
        };
        const cleanup = () =>
          sql(async (client) => {
            await client.query(`SET session_replication_role = replica`);
            await client.query(
              `DELETE FROM "OrderLine" WHERE id = 'race-line'`,
            );
            await client.query(
              `DELETE FROM "Product" WHERE id = '${pid}' AND "tenantId" = '${TENANTS.b}'`,
            );
            await client.query(`SET session_replication_role = origin`);
          });
        // The product row exactly as it is now, to put back after a race
        // deleted it (the data checksum must not move).
        const saved = await sql(
          async (c) =>
            (
              await c.query<{ r: unknown }>(
                `SELECT to_jsonb(p) AS r FROM "Product" p WHERE id = '${pid}'`,
              )
            ).rows[0].r,
        );
        const restore = async () => {
          await cleanup();
          await sql((c) =>
            c.query(
              `INSERT INTO "Product" SELECT * FROM jsonb_populate_record(NULL::"Product", $1::jsonb) ON CONFLICT ("id") DO NOTHING`,
              [JSON.stringify(saved)],
            ),
          );
        };

        const locked = await race();
        await restore();
        expect(locked).toEqual({
          deleteWhileSnapshotOpen: '55P03',
          reuseBeforeCommit: 'not attempted',
          crossBusinessSnapshots: 0,
        });

        // The 4C-4 function (no lock): the race succeeds — this is the
        // weakness the lock closes.
        const original = await sql(
          async (c) =>
            (
              await c.query<{ d: string }>(
                `SELECT pg_get_functiondef('reject_cross_tenant_snapshot'::regproc) AS d`,
              )
            ).rows[0].d,
        );
        await sql((c) => c.query(UNLOCKED_SNAPSHOT_FUNCTION));
        try {
          const unlocked = await race();
          expect(unlocked).toEqual({
            deleteWhileSnapshotOpen: 'ok',
            reuseBeforeCommit: 'ok',
            crossBusinessSnapshots: 1,
          });
        } finally {
          await sql((c) => c.query(original));
          await restore();
        }
        expect(await dataChecksum(scratch.url)).toBe(beforeData);
        expect(await sql(tenantEnforcement)).toEqual(EXPECTED_ENFORCEMENT);
      });
    });

    it('the integrity checker reports CLEAN with zero unchecked rows', async () => {
      const report = await sql((client) => checkTenantIntegrity(client));
      expect([report.verdict, report.violations, report.uncheckedRows]).toEqual(
        ['clean', 0, 0],
      );
    });

    it('deliberately removing ANY key, ownership trigger or product-snapshot guard is detected by the catalog guard, and lets the write it stopped through', async () => {
      type Mutation = {
        drop: string;
        missing: string[];
        write: string;
        blocked: string;
      };
      const mutations: Mutation[] = [
        ...RELATIONSHIPS.map((r) => ({
          drop: `ALTER TABLE "${r.child}" DROP CONSTRAINT "${constraintName(r)}"`,
          missing: [
            EXPECTED_FOREIGN_KEYS.find((k) =>
              k.startsWith(`${constraintName(r)}:`),
            )!,
          ],
          write: `UPDATE "${r.child}" SET "${r.column}" = '${id('b', SPARE[r.parent])}' WHERE ${rowWhere(r.child, 'a')}`,
          blocked: '23503',
        })),
        ...PROTECTED_TABLES.map((t) => ({
          drop: `DROP TRIGGER "${t}_tenantId_immutable" ON "${t}"`,
          missing: [immutabilityTrigger(t)],
          write: MOVES[t]('a', 'b'),
          blocked: '23001',
        })),
        {
          drop: `DROP TRIGGER "OrderLine_productId_same_tenant" ON "OrderLine"`,
          missing: [ORDER_LINE_SNAPSHOT_TRIGGER],
          write: `UPDATE "OrderLine" SET "productId" = '${id('b', 'product')}' WHERE id = '${id('a', 'line')}'`,
          blocked: '23503',
        },
        {
          drop: `DROP TRIGGER "Product_id_not_reused" ON "Product"`,
          missing: [PRODUCT_REUSE_TRIGGER],
          // Delete A's snapshot product, then give its id to business B.
          write: `DELETE FROM "Product" WHERE id = '${id('a', 'snap-product')}';
                  INSERT INTO "Product" ("id", "tenantId", "name", "slug", "categoryId", "updatedAt")
                  VALUES ('${id('a', 'snap-product')}', '${TENANTS.b}', 'Taken', 'taken', '${id('b', 'category')}', now())`,
          blocked: '23505',
        },
      ];
      const results = await sql(async (client) => {
        const out: Array<{
          missing: string[];
          withIt: string;
          without: string;
        }> = [];
        for (const m of mutations) {
          const withIt = (await attempt(client, m.write)).split(' ')[0];
          await client.query('BEGIN');
          try {
            await client.query(m.drop);
            const enforcement = await tenantEnforcement(client);
            let without = 'ok';
            await client.query('SAVEPOINT w');
            try {
              await client.query(m.write);
            } catch (error) {
              without = String((error as { code?: string }).code);
              await client.query('ROLLBACK TO SAVEPOINT w');
            }
            out.push({
              missing: EXPECTED_ENFORCEMENT.filter(
                (k) => !enforcement.includes(k),
              ),
              withIt,
              without,
            });
          } finally {
            await client.query('ROLLBACK');
          }
        }
        return out;
      });
      expect(results).toEqual(
        mutations.map((m) => ({
          missing: m.missing,
          withIt: m.blocked,
          without: 'ok',
        })),
      );
      expect(mutations).toHaveLength(33 + 19 + 2);
      expect(await sql(tenantEnforcement)).toEqual(EXPECTED_ENFORCEMENT);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });
  });

  // Delete behaviour is compared against a database migrated to just
  // before 4C-6 holding the identical fictional rows.
  describe('deletion behaviour is unchanged', () => {
    let before: ScratchDatabase;
    let after: ScratchDatabase;
    const deletes: Record<string, string> = {
      'category in use (Restrict)': `DELETE FROM "Category" WHERE id = '${id('a', 'category')}'`,
      'unused category': `DELETE FROM "Category" WHERE id = '${id('a', 'category-spare')}'`,
      'product in use (Restrict)': `DELETE FROM "Product" WHERE id = '${id('b', 'product')}'`,
      'product named only by snapshots (history kept)': `DELETE FROM "Product" WHERE id = '${id('b', 'snap-product')}'`,
      'modifier group in use (Restrict)': `DELETE FROM "ModifierGroup" WHERE id = '${id('a', 'mg')}'`,
      'menu in use (Restrict)': `DELETE FROM "Menu" WHERE id = '${id('c', 'menu')}'`,
      'location in use (Restrict)': `DELETE FROM "Location" WHERE id = '${id('a', 'location')}'`,
      'reward (eligibility cascades)': `DELETE FROM "LoyaltyReward" WHERE id = '${id('a', 'reward-spare')}'`,
      'promotion in use by campaign (Restrict)': `DELETE FROM "Promotion" WHERE id = '${id('b', 'promo')}'`,
      'unused promotion (eligibility cascades)': `DELETE FROM "Promotion" WHERE id = '${id('b', 'promo-spare')}'`,
      'bonus promotion in use by campaign (Restrict)': `DELETE FROM "LoyaltyBonusPromotion" WHERE id = '${id('c', 'bonus')}'`,
      'campaign (featured products cascade)': `DELETE FROM "Campaign" WHERE id = '${id('a', 'campaign')}'`,
      'unused media asset': `DELETE FROM "MediaAsset" WHERE id = '${id('a', 'media-spare')}'`,
    };
    const counts = `SELECT concat_ws(',',
        (SELECT count(*) FROM "Product"), (SELECT count(*) FROM "Category"), (SELECT count(*) FROM "MenuProduct"),
        (SELECT count(*) FROM "LoyaltyRewardProduct"), (SELECT count(*) FROM "LoyaltyRewardCategory"),
        (SELECT count(*) FROM "PromotionProduct"), (SELECT count(*) FROM "PromotionCategory"), (SELECT count(*) FROM "PromotionLocation"),
        (SELECT count(*) FROM "CampaignProduct"), (SELECT count(*) FROM "Campaign"), (SELECT count(*) FROM "MediaAsset"),
        (SELECT count(*) FROM "OrderLine")) AS c`;
    const outcomes = (url: string, statements: Record<string, string>) =>
      withScratchClient(url, async (client) => {
        const out: Record<string, string> = {};
        for (const [name, statement] of Object.entries(statements)) {
          await client.query('BEGIN');
          try {
            await client.query(statement);
            out[name] =
              `ok ${(await client.query<{ c: string }>(counts)).rows[0].c}`;
          } catch (error) {
            out[name] = String((error as { code?: string }).code);
          } finally {
            await client.query('ROLLBACK');
          }
        }
        return out;
      });

    beforeAll(async () => {
      before = await createScratchDatabase(baseUrl, 'fk_catalog_del_before');
      after = await createScratchDatabase(baseUrl, 'fk_catalog_del_after');
      await applyMigrations(before.url, migrations.slice(0, targetIndex));
      await applyMigrations(after.url, migrations);
      await loadFixture(before.url);
      await loadFixture(after.url);
    });

    afterAll(async () => {
      await before?.drop();
      await after?.drop();
    });

    it('every delete has the same outcome before and after 4C-6', async () => {
      const was = await outcomes(before.url, deletes);
      const is = await outcomes(after.url, deletes);
      expect(is).toEqual(was);
      expect(is['product in use (Restrict)']).toBe('23503');
      expect(is['product named only by snapshots (history kept)']).toMatch(
        /^ok /,
      );
      expect(is['campaign (featured products cascade)']).toMatch(/^ok /);
    });

    it('the one intended change: a media asset a campaign shows can no longer be deleted out from under it (was: the campaign was left pointing at nothing)', async () => {
      const statement = {
        media: `DELETE FROM "MediaAsset" WHERE id = '${id('a', 'media')}'`,
      };
      expect((await outcomes(before.url, statement)).media).toMatch(/^ok /);
      expect((await outcomes(after.url, statement)).media).toBe('23503');
    });
  });

  // Real `prisma migrate deploy`, exactly as CI and every environment run
  // it, against newly created guarded scratch databases.
  describe('applied by real prisma migrate deploy', () => {
    const prisma = prismaCli(databaseDir);
    const projects: MigrationProject[] = [];
    const scratches: ScratchDatabase[] = [];
    const beforeNames = migrations.slice(0, targetIndex).map((m) => m.name);
    const throughNames = migrations
      .slice(0, targetIndex + 1)
      .map((m) => m.name);

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
    const beforeFourC6 = async (label: string) => {
      const scratch = await fresh(label);
      expect(
        (await prisma(scratch.url, ['migrate', 'deploy'], project(beforeNames)))
          .code,
      ).toBe(0);
      await loadFixture(scratch.url);
      return scratch;
    };
    const deploy = (url: string) =>
      prisma(url, ['migrate', 'deploy'], project(throughNames));
    const run = (url: string, statement: string) =>
      withScratchClient(url, (client) => client.query(statement));
    const migrationRow = async (url: string, name = MIGRATION) =>
      (
        await withScratchClient(url, (client) =>
          client.query<{ finished: boolean; rolled_back: boolean }>(
            `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
               FROM _prisma_migrations WHERE migration_name = '${name}' ORDER BY started_at`,
          ),
        )
      ).rows.map(
        (r) =>
          `${r.finished ? 'finished' : 'unfinished'}${r.rolled_back ? '+rolled-back' : ''}`,
      );
    // schema.prisma describes the newest migration, so the later ones
    // (Security 4C-7 onwards) are applied first, by the real runner.
    const noDrift = async (url: string) => {
      const later = await prisma(url, ['migrate', 'deploy']);
      if (later.code !== 0) return later.code;
      return (
        await prisma(url, [
          'migrate',
          'diff',
          '--from-config-datasource',
          '--to-schema',
          'prisma/schema.prisma',
          '--exit-code',
        ])
      ).code;
    };
    const enforcement = (url: string) =>
      withScratchClient(url, tenantEnforcement);

    it('succeeds on clean data: everything enforced, data, prices and snapshots unchanged, no drift, integrity CLEAN', async () => {
      const scratch = await beforeFourC6('fk_catalog_ok');
      const data = await dataChecksum(scratch.url);
      const state = await catalogState(scratch.url);
      expect((await deploy(scratch.url)).code).toBe(0);
      expect(await migrationRow(scratch.url)).toEqual(['finished']);
      expect(await enforcement(scratch.url)).toEqual(EXPECTED_ENFORCEMENT);
      expect(await dataChecksum(scratch.url)).toBe(data);
      expect(await catalogState(scratch.url)).toBe(state);
      expect(await noDrift(scratch.url)).toBe(0);
      const report = await withScratchClient(scratch.url, (client) =>
        checkTenantIntegrity(client),
      );
      expect([report.verdict, report.violations, report.uncheckedRows]).toEqual(
        ['clean', 0, 0],
      );
    });

    it('mismatched rows — cross-business catalog, offer and campaign links, a missing parent, and product snapshots naming another business — abort it before any change, all listed; never repaired; recovery only after an explicit fix', async () => {
      const scratch = await beforeFourC6('fk_catalog_cross');
      const bad = `
        UPDATE "MenuProduct" SET "productId" = '${id('b', 'product-spare')}' WHERE "tenantId" = '${TENANTS.a}';
        UPDATE "PromotionCategory" SET "categoryId" = '${id('c', 'category-spare')}' WHERE "tenantId" = '${TENANTS.b}';
        UPDATE "Campaign" SET "mediaAssetId" = '${id('a', 'media-spare')}' WHERE id = '${id('c', 'campaign')}';
        UPDATE "Campaign" SET "mediaAssetId" = 'cat-missing-media' WHERE id = '${id('b', 'campaign')}';
        UPDATE "Product" SET "categoryId" = '${id('b', 'category')}' WHERE id = '${id('a', 'product-spare')}';
        UPDATE "OrderLine" SET "productId" = '${id('b', 'product')}' WHERE id = '${id('a', 'line')}';
        UPDATE "OrderPromotionRedemption" SET "freeItemProductId" = '${id('a', 'product')}' WHERE id = '${id('c', 'promo-redemption')}';`;
      // Legacy-style data the single-column keys (and no product-snapshot
      // guard) allowed; planted with triggers suspended, as history would be.
      await run(
        scratch.url,
        `SET session_replication_role = replica; ${bad} SET session_replication_role = origin;`,
      );
      const catalog = await databaseCatalog(scratch.url);
      const data = await dataChecksum(scratch.url);

      const failed = await deploy(scratch.url);
      expect(failed.code).not.toBe(0);
      expect(failed.out).toContain('P3018');
      expect(failed.out).toContain('Security 4C-6 aborted');
      for (const line of [
        'MenuProduct.productId -> Product: 1 row(s)',
        'PromotionCategory.categoryId -> Category: 1 row(s)',
        'Campaign.mediaAssetId -> MediaAsset: 2 row(s)',
        'Product.categoryId -> Category: 1 row(s)',
        'OrderLine.productId -> Product (snapshot of another business): 1 row(s)',
        'OrderPromotionRedemption.freeItemProductId -> Product (snapshot of another business): 1 row(s)',
      ]) {
        expect(failed.out).toContain(line);
      }
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);
      expect(await dataChecksum(scratch.url)).toBe(data);
      expect(await migrationRow(scratch.url)).toEqual(['unfinished']);
      expect((await deploy(scratch.url)).out).toContain('P3009');

      await run(
        scratch.url,
        `SET session_replication_role = replica;
         UPDATE "MenuProduct" SET "productId" = '${id('a', 'product')}' WHERE "tenantId" = '${TENANTS.a}';
         UPDATE "PromotionCategory" SET "categoryId" = '${id('b', 'category')}' WHERE "tenantId" = '${TENANTS.b}';
         UPDATE "Campaign" SET "mediaAssetId" = '${id('c', 'media')}' WHERE id = '${id('c', 'campaign')}';
         UPDATE "Campaign" SET "mediaAssetId" = '${id('b', 'media')}' WHERE id = '${id('b', 'campaign')}';
         UPDATE "Product" SET "categoryId" = '${id('a', 'category')}' WHERE id = '${id('a', 'product-spare')}';
         UPDATE "OrderLine" SET "productId" = '${id('a', 'snap-product')}' WHERE id = '${id('a', 'line')}';
         UPDATE "OrderPromotionRedemption" SET "freeItemProductId" = '${id('c', 'snap-product')}' WHERE id = '${id('c', 'promo-redemption')}';
         SET session_replication_role = origin;`,
      );
      expect(
        (
          await prisma(
            scratch.url,
            ['migrate', 'resolve', '--rolled-back', MIGRATION],
            project(throughNames),
          )
        ).code,
      ).toBe(0);
      expect((await deploy(scratch.url)).code).toBe(0);
      expect(await migrationRow(scratch.url)).toEqual([
        'unfinished+rolled-back',
        'finished',
      ]);
      expect(await enforcement(scratch.url)).toEqual(EXPECTED_ENFORCEMENT);
      expect(await noDrift(scratch.url)).toBe(0);
    });

    it('refuses to run without Security 4C-3’s or 4C-4’s functions, changing nothing', async () => {
      for (const fn of [
        'reject_tenant_reassignment',
        'reject_reused_snapshot_source',
      ]) {
        const scratch = await beforeFourC6(`fk_catalog_no_${fn.slice(7, 13)}`);
        await run(
          scratch.url,
          `ALTER FUNCTION "${fn}"() RENAME TO "renamed_for_test"`,
        );
        const catalog = await databaseCatalog(scratch.url);
        const failed = await deploy(scratch.url);
        expect(failed.code).not.toBe(0);
        expect(failed.out).toMatch(
          fn === 'reject_tenant_reassignment'
            ? /requires Security 4C-3/
            : /requires Security 4C-4/,
        );
        expect(await databaseCatalog(scratch.url)).toEqual(catalog);
      }
    });

    it('a failure at its LAST statement leaves no partial change (keys, functions, triggers)', async () => {
      const scratch = await beforeFourC6('fk_catalog_late');
      await run(
        scratch.url,
        `CREATE TRIGGER "ProductModifierGroup_tenantId_immutable" BEFORE UPDATE ON "ProductModifierGroup"
           FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`,
      );
      const catalog = await databaseCatalog(scratch.url);
      const data = await dataChecksum(scratch.url);
      const failed = await deploy(scratch.url);
      expect(failed.code).not.toBe(0);
      expect(failed.out).toMatch(/already exists/);
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);
      expect(await dataChecksum(scratch.url)).toBe(data);
      expect(await migrationRow(scratch.url)).toEqual(['unfinished']);
    });

    it('a lock it cannot get makes it fail fast (lock_timeout) and atomically', async () => {
      const scratch = await beforeFourC6('fk_catalog_lock');
      const catalog = await databaseCatalog(scratch.url);
      const held = await withScratchClient(scratch.url, async (client) => {
        await client.query('BEGIN');
        await client.query(`LOCK TABLE "MenuProduct" IN ROW EXCLUSIVE MODE`);
        const started = Date.now();
        const result = await deploy(scratch.url);
        await client.query('ROLLBACK');
        return { result, seconds: (Date.now() - started) / 1000 };
      });
      expect(held.result.code).not.toBe(0);
      expect(held.result.out).toMatch(/lock timeout/i);
      expect(held.seconds).toBeLessThan(60);
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);
      expect(await migrationRow(scratch.url)).toEqual(['unfinished']);
    });

    it('while 4C-6 is applied, rolling back 4C-4 (or 4C-3) first is refused atomically — their functions are still in use', async () => {
      const scratch = await beforeFourC6('fk_catalog_order');
      expect((await deploy(scratch.url)).code).toBe(0);
      const rollback5 = {
        name: '20261016090000_rollback_tenant_fk_staff_authorization',
        sql: rollbackOf(PREVIOUS),
      };
      // 4C-5 shares nothing with 4C-6 except 4C-3's function; roll it back
      // first so only 4C-6 holds the 4C-4 functions.
      expect(
        (
          await prisma(
            scratch.url,
            ['migrate', 'deploy'],
            project(throughNames, rollback5),
          )
        ).code,
      ).toBe(0);
      const catalog = await databaseCatalog(scratch.url);
      for (const [name, source] of [
        [
          '20261016100000_rollback_tenant_fk_loyalty_giftcard_promotion',
          FOUR_C_4,
        ],
        ['20261016100000_rollback_tenant_fk_customer_order_payment', FOUR_C_3],
      ] as const) {
        const failed = await prisma(
          scratch.url,
          ['migrate', 'deploy'],
          project(throughNames, [rollback5, { name, sql: rollbackOf(source) }]),
        );
        expect(failed.code).not.toBe(0);
        expect(failed.out).toMatch(/depend/);
        expect(await databaseCatalog(scratch.url)).toEqual(catalog);
        await prisma(
          scratch.url,
          ['migrate', 'resolve', '--rolled-back', name],
          project(throughNames, [rollback5, { name, sql: rollbackOf(source) }]),
        );
      }
    });

    it('the documented rollback — shipped as a new forward migration — restores the pre-4C-6 catalog exactly (keys, indexes, triggers and both 4C-4 functions), keeps the data, and 4C-6 re-applies; then 4C-5, 4C-4 and 4C-3 roll back in order to the pre-4C-3 catalog', async () => {
      const scratch = await beforeFourC6('fk_catalog_rollback');
      const data = await dataChecksum(scratch.url);
      expect((await deploy(scratch.url)).code).toBe(0);
      const rollback = {
        name: '20261016090000_rollback_tenant_fk_catalog_offers_snapshots',
        sql: rollbackSql,
      };
      expect(
        (
          await prisma(
            scratch.url,
            ['migrate', 'deploy'],
            project(throughNames, rollback),
          )
        ).code,
      ).toBe(0);
      const reference = await fresh('fk_catalog_rollback_ref');
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
        name: '20261016100000_reapply_tenant_fk_catalog_offers_snapshots',
        sql: target.sql,
      };
      expect(
        (
          await prisma(
            scratch.url,
            ['migrate', 'deploy'],
            project(throughNames, [rollback, reapply]),
          )
        ).code,
      ).toBe(0);
      expect(await enforcement(scratch.url)).toEqual(EXPECTED_ENFORCEMENT);
      expect(await dataChecksum(scratch.url)).toBe(data);

      const chain = await beforeFourC6('fk_catalog_chain');
      const chainData = await dataChecksum(chain.url);
      expect((await deploy(chain.url)).code).toBe(0);
      const steps = [
        rollback,
        {
          name: '20261016110000_rollback_tenant_fk_staff_authorization',
          sql: rollbackOf(PREVIOUS),
        },
        {
          name: '20261016120000_rollback_tenant_fk_loyalty_giftcard_promotion',
          sql: rollbackOf(FOUR_C_4),
        },
        {
          name: '20261016130000_rollback_tenant_fk_customer_order_payment',
          sql: rollbackOf(FOUR_C_3),
        },
      ];
      expect(
        (
          await prisma(
            chain.url,
            ['migrate', 'deploy'],
            project(throughNames, steps),
          )
        ).code,
      ).toBe(0);
      const preFourC3 = await fresh('fk_catalog_chain_ref');
      const preNames = migrations
        .slice(
          0,
          migrations.findIndex((m) => m.name === FOUR_C_3),
        )
        .map((m) => m.name);
      expect(
        (await prisma(preFourC3.url, ['migrate', 'deploy'], project(preNames)))
          .code,
      ).toBe(0);
      expect(await databaseCatalog(chain.url)).toEqual(
        await databaseCatalog(preFourC3.url),
      );
      expect(await dataChecksum(chain.url)).toBe(chainData);
    });
  });
});
