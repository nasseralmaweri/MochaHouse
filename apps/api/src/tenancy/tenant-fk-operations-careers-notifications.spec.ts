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

// Security 4C-7 — PostgreSQL-enforced tenant isolation for the remaining
// operational records (checklists, tasks, careers, franchising and
// notification deliveries), and ownership immutability for every remaining
// business-owned table:
//   - 10 composite foreign keys ("tenantId", <column>) -> parent
//     ("tenantId", "id"), replacing the last single-column keys between
//     business records;
//   - 12 more tables whose rows can never move to another business — after
//     4C-7 every table with a "tenantId" column carries the trigger.
//
// With three fictional businesses this spec proves: the schema, inventory,
// migration and rollback agree; the configured test database enforces
// everything, and a removed key or trigger is detected; same-business
// operational writes work; every cross-business reference and move is
// rejected by PostgreSQL — by direct SQL and by Prisma checked, unchecked
// and nested writes — with the data unchanged; concurrent writes cannot
// slip a cross-business reference in; delete behaviour is unchanged; the
// integrity checker reports CLEAN; and the migration, run by the REAL
// `prisma migrate deploy`, aborts on mismatched rows before changing
// anything, is atomic, fails fast on locks, leaves no drift, and its
// rollback restores the previous catalog exactly. All data is fictional.

jest.setTimeout(600_000);

const repoRoot = join(__dirname, '../../../..');
const databaseDir = join(repoRoot, 'packages/database');
const migrationsDir = join(databaseDir, 'prisma/migrations');
const MIGRATION = '20261016090000_tenant_fk_operations_careers_notifications';
const PREVIOUS = '20261015090000_tenant_fk_catalog_offers_snapshots';
const FOUR_C_5 = '20261014090000_tenant_fk_staff_authorization';
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
const id = (tag: Tag, name: string) => `ops-${tag}-${name}`;

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
  rel('ChecklistTemplateItem', 'templateId', 'ChecklistTemplate', 'CASCADE'),
  rel('ChecklistInstance', 'templateId', 'ChecklistTemplate'),
  rel('ChecklistInstance', 'locationId', 'Location'),
  rel(
    'ChecklistInstanceItem',
    'checklistInstanceId',
    'ChecklistInstance',
    'CASCADE',
  ),
  rel('OperationsTask', 'locationId', 'Location'),
  rel('JobOpening', 'locationId', 'Location', 'RESTRICT', true),
  rel('JobApplication', 'jobOpeningId', 'JobOpening'),
  rel('JobApplicationNote', 'jobApplicationId', 'JobApplication', 'CASCADE'),
  rel(
    'FranchiseInquiryNote',
    'franchiseInquiryId',
    'FranchiseInquiry',
    'CASCADE',
  ),
  rel('NotificationDelivery', 'outboxEventId', 'OutboxEvent'),
];

const relationshipId = (r: Relationship) => `${r.child}.${r.column}`;
const constraintName = (r: Relationship) =>
  `${r.child}_tenantId_${r.column}_fkey`;

// The fixture's unused parent of each type (pointing a row at it can trip
// no other unique constraint).
const SPARE: Record<string, string> = {
  ChecklistTemplate: 'template-spare',
  ChecklistInstance: 'instance-spare',
  Location: 'location-spare',
  JobOpening: 'job-spare',
  JobApplication: 'application-spare',
  FranchiseInquiry: 'inquiry-spare',
  OutboxEvent: 'event-spare',
};

// The fixture row of each referencing table, per business.
const ROW: Record<string, string> = {
  ChecklistTemplateItem: 'template-item',
  ChecklistInstance: 'instance',
  ChecklistInstanceItem: 'instance-item',
  OperationsTask: 'task',
  JobOpening: 'job',
  JobApplication: 'application',
  JobApplicationNote: 'application-note',
  FranchiseInquiryNote: 'inquiry-note',
  NotificationDelivery: 'delivery',
};
const rowWhere = (child: string, tag: Tag) => `id = '${id(tag, ROW[child])}'`;
// A copy of the fixture row with a new id and the given reference (every
// other unique key includes the changed reference or the id).
const insertCopy = (r: Relationship, from: Tag, parentId: string) => {
  const overrides = {
    id: `copy-${from}-${ROW[r.child]}`,
    [r.column]: parentId,
  };
  return `INSERT INTO "${r.child}"
    SELECT (jsonb_populate_record(NULL::"${r.child}", to_jsonb(t) || '${JSON.stringify(overrides)}'::jsonb)).*
      FROM "${r.child}" t WHERE ${rowWhere(r.child, from)}`;
};

// The 12 tables 4C-7 makes immutable — the last business-owned tables
// without the trigger.
const PROTECTED_TABLES = [
  'ChecklistInstance',
  'ChecklistTemplate',
  'ChecklistTemplateItem',
  'CmsPage',
  'FranchiseInquiry',
  'GiftCardConfiguration',
  'JobApplication',
  'JobOpening',
  'LoyaltyConfiguration',
  'NotificationDelivery',
  'NotificationRecipient',
  'OutboxEvent',
];

const immutabilityTrigger = (t: string) =>
  `trigger: CREATE TRIGGER "${t}_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON public."${t}" FOR EACH ROW WHEN ((old."tenantId" IS DISTINCT FROM new."tenantId")) EXECUTE FUNCTION reject_tenant_reassignment()`;
const EXPECTED_FOREIGN_KEYS = RELATIONSHIPS.map(
  (r) =>
    `${constraintName(r)}: FOREIGN KEY ("tenantId", "${r.column}") REFERENCES "${r.parent}"("tenantId", id) ON UPDATE RESTRICT ON DELETE ${r.onDelete}`,
).sort();
const EXPECTED_IMMUTABILITY = PROTECTED_TABLES.map(immutabilityTrigger).sort();
const EXPECTED_ENFORCEMENT = [
  ...EXPECTED_FOREIGN_KEYS,
  ...EXPECTED_IMMUTABILITY,
];

// Every foreign key on the 10 referencing columns and the ownership
// triggers of the 12 tables, as PostgreSQL defines them.
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
  return [...keys.rows.map((r) => r.d), ...immutable.rows.map((r) => r.d)];
}

// Tables allowed WITHOUT a "tenantId" column: the approved global models
// (pinned in tenant-relationship-inventory.spec.ts as APPROVED_GLOBAL_MODELS)
// and Prisma's own migration history, which is not an application model.
// SC1a — plus the CENTERIVO platform-operator tables (no tenant by design;
// their only foreign key is audit event -> operator, which the
// "untenantedReferences" check below still covers).
const GLOBAL_TABLES = [
  'Tenant',
  'PlatformOperator',
  'PlatformAuditEvent',
  // SC1d — business provisioning records (platform-plane; no tenantId, and
  // the business id they hold is a plain value, not a foreign key).
  'TenantProvisioningOperation',
  // SC2a — SaaS plans and subscriptions (platform-plane; no tenantId column —
  // the one link to a business is TenantSubscription.subscriberTenantId).
  'SubscriptionPlan',
  'SubscriptionPlanVersion',
  'TenantSubscription',
  'TenantModuleGrant',
  'TenantSubscriptionEvent',
  // SC3a — SaaS billing (platform data).
  'SubscriptionPlanPrice',
  'BillingPolicy',
  'BillingTrialClaim',
  'BillingProviderEvent',
  'BillingCheckoutSession',
  'BillingReconciliationCase',
  // SC3c-3
  'BillingGraceExtension',
  'BillingNotification',
  // SC3d-1
  'BillingPlanChange',
  // SC3e-1
  'BillingInvoice',
  // SC3e-2
  'PlatformOperatorPermission',
  'BillingComplimentaryGrant',
  'BillingReconciliationCaseAction',
  // SC3e-3 — refunds and credits, their decisions and history.
  'BillingAdjustment',
  'BillingAdjustmentDecision',
  'BillingAdjustmentEvent',
  // SC3e-4 — when billing enforcement ran.
  'BillingEnforcementActivation',
  '_prisma_migrations',
];

// The whole-database guard (Security 4C-7 and its review), against the live
// catalog: business-owned tables (a "tenantId" column) without the
// ownership trigger; single-column foreign keys between business-owned
// tables; any other table without a "tenantId" (created by a migration or by
// raw SQL, outside the approved globals); and any foreign key from a table
// without a "tenantId" into a business-owned table.
async function remainingGaps(client: Client) {
  const unprotected = await client.query<{ t: string }>(
    `SELECT c.relname AS t FROM pg_class c
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenantId'
      WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
        AND NOT EXISTS (SELECT 1 FROM pg_trigger t
                         WHERE t.tgrelid = c.oid AND t.tgname = c.relname || '_tenantId_immutable')
      ORDER BY 1`,
  );
  const singleColumn = await client.query<{ k: string }>(
    `SELECT c.conname AS k FROM pg_constraint c
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
        AND c.confrelid <> '"Tenant"'::regclass
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'tenantId')
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'tenantId')
        AND NOT EXISTS (SELECT 1 FROM unnest(c.conkey) k(n)
                          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n
                         WHERE a.attname = 'tenantId')
      ORDER BY 1`,
  );
  const withoutTenantId = await client.query<{ t: string }>(
    `SELECT c.relname AS t FROM pg_class c
      WHERE c.relkind IN ('r', 'p') AND c.relnamespace = 'public'::regnamespace
        AND c.relname <> ALL ($1::text[])
        AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                         WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped)
      ORDER BY 1`,
    [GLOBAL_TABLES],
  );
  const untenantedReferences = await client.query<{ k: string }>(
    `SELECT c.conname AS k FROM pg_constraint c
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
        AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'tenantId')
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'tenantId')
      ORDER BY 1`,
  );
  return {
    unprotected: unprotected.rows.map((r) => r.t),
    singleColumn: singleColumn.rows.map((r) => r.k),
    withoutTenantId: withoutTenantId.rows.map((r) => r.t),
    untenantedReferences: untenantedReferences.rows.map((r) => r.k),
  };
}
const NO_GAPS = {
  unprotected: [],
  singleColumn: [],
  withoutTenantId: [],
  untenantedReferences: [],
};

// Fictional operational data for one business: every relationship in use,
// plus unused "spare" parents.
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
      email: `${tag}.ops@example.test`,
    },
  });
  for (const name of ['location', 'location-spare']) {
    await prisma.location.create({
      data: { id: i(name), tenantId, name: `${tag} ${name}`, slug: i(name) },
    });
  }
  for (const name of ['template', 'template-spare']) {
    await prisma.checklistTemplate.create({
      data: { id: i(name), tenantId, key: i(name), name: `${tag} ${name}` },
    });
  }
  await prisma.checklistTemplateItem.create({
    data: {
      id: i('template-item'),
      tenantId,
      templateId: i('template'),
      section: 'Open',
      label: 'Unlock doors',
      sortOrder: 1,
    },
  });
  await prisma.checklistInstance.create({
    data: {
      id: i('instance'),
      tenantId,
      templateId: i('template'),
      locationId: i('location'),
      businessDate: new Date('2026-01-01'),
    },
  });
  await prisma.checklistInstance.create({
    data: {
      id: i('instance-spare'),
      tenantId,
      templateId: i('template'),
      locationId: i('location'),
      businessDate: new Date('2026-01-02'),
    },
  });
  await prisma.checklistInstanceItem.create({
    data: {
      id: i('instance-item'),
      tenantId,
      checklistInstanceId: i('instance'),
      section: 'Open',
      label: 'Unlock doors',
      sortOrder: 1,
    },
  });
  await prisma.operationsTask.create({
    data: {
      id: i('task'),
      tenantId,
      locationId: i('location'),
      businessDate: new Date('2026-01-01'),
      title: 'Restock cups',
      createdByInternalUserId: i('staff'),
    },
  });
  const job = {
    tenantId,
    employmentType: 'PART_TIME' as const,
    summary: 'Fictional role',
    description: 'Fictional role',
    responsibilities: 'Fictional',
    qualifications: 'Fictional',
  };
  await prisma.jobOpening.create({
    data: { ...job, id: i('job'), title: 'Barista', locationId: i('location') },
  });
  await prisma.jobOpening.create({
    data: { ...job, id: i('job-spare'), title: 'Shift lead' },
  });
  for (const name of ['application', 'application-spare']) {
    await prisma.jobApplication.create({
      data: {
        id: i(name),
        tenantId,
        jobOpeningId: i('job'),
        jobTitleSnapshot: 'Barista',
        firstName: 'Fictional',
        lastName: tag.toUpperCase(),
        email: `${tag}.${name}@example.test`,
        phone: '555-0100',
        location: 'Fictional City',
        workAuthorized: true,
        availability: 'Weekends',
        message: 'Fictional application',
      },
    });
  }
  await prisma.jobApplicationNote.create({
    data: {
      id: i('application-note'),
      tenantId,
      jobApplicationId: i('application'),
      authorInternalUserId: i('staff'),
      body: 'Fictional note',
    },
  });
  for (const name of ['inquiry', 'inquiry-spare']) {
    await prisma.franchiseInquiry.create({
      data: {
        id: i(name),
        tenantId,
        firstName: 'Fictional',
        lastName: tag.toUpperCase(),
        email: `${tag}.${name}@example.test`,
        phone: '555-0100',
        city: 'Fictional City',
        state: 'FC',
        country: 'Fictionland',
        preferredMarket: 'Fictional Market',
        consentAcknowledged: true,
      },
    });
  }
  await prisma.franchiseInquiryNote.create({
    data: {
      id: i('inquiry-note'),
      tenantId,
      franchiseInquiryId: i('inquiry'),
      authorInternalUserId: i('staff'),
      body: 'Fictional note',
    },
  });
  // S4a: this fixture is loaded into a database migrated only to BEFORE 4C-7,
  // so before the S4a columns exist; a Prisma create() would read back columns
  // that are not there yet. Explicit-column SQL touches only the original ones.
  for (const name of ['event', 'event-spare']) {
    await prisma.$executeRaw`
      INSERT INTO "OutboxEvent" ("id", "tenantId", "aggregateType", "aggregateId", "eventType", "payload", "status")
      VALUES (${i(name)}, ${tenantId}, 'FranchiseInquiry', ${i('inquiry')}, 'franchise_inquiry.submitted', '{}'::jsonb, 'PROCESSED')`;
  }
  await prisma.$executeRaw`
    INSERT INTO "NotificationDelivery" ("id", "tenantId", "outboxEventId", "channel", "recipient", "templateKey", "status", "aggregateType", "aggregateId")
    VALUES (${i('delivery')}, ${tenantId}, ${i('event')}, 'EMAIL', ${`${tag}.ops@example.test`}, 'franchise_inquiry_received', 'SENT', 'FranchiseInquiry', ${i('inquiry')})`;
  await prisma.notificationRecipient.create({
    data: {
      id: i('recipient'),
      tenantId,
      purpose: i('purpose'),
      email: `${tag}.ops@example.test`,
    },
  });
  await prisma.cmsPage.create({
    data: {
      id: i('page'),
      tenantId,
      key: i('page'),
      title: 'Fictional page',
      draftContent: {},
    },
  });
  await prisma.giftCardConfiguration.create({
    data: { id: i('gift-config'), tenantId, key: i('config') },
  });
  await prisma.loyaltyConfiguration.create({
    data: { id: i('loyalty-config'), tenantId, key: i('config') },
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
  const move =
    (table: string, row: string, sets?: (y: Tag) => string) =>
    (x: Tag, y: Tag) =>
      `UPDATE "${table}" SET ${t(y)}${sets ? `, ${sets(y)}` : ''} WHERE id = '${id(x, row)}'`;
  return {
    ChecklistInstance: move(
      'ChecklistInstance',
      'instance-spare',
      (y) =>
        `"templateId" = ${Y(y, 'template-spare')}, "locationId" = ${Y(y, 'location-spare')}`,
    ),
    ChecklistTemplate: move('ChecklistTemplate', 'template-spare'),
    ChecklistTemplateItem: move(
      'ChecklistTemplateItem',
      'template-item',
      (y) => `"templateId" = ${Y(y, 'template-spare')}`,
    ),
    CmsPage: move('CmsPage', 'page'),
    FranchiseInquiry: move('FranchiseInquiry', 'inquiry-spare'),
    GiftCardConfiguration: move('GiftCardConfiguration', 'gift-config'),
    JobApplication: move(
      'JobApplication',
      'application-spare',
      (y) => `"jobOpeningId" = ${Y(y, 'job-spare')}`,
    ),
    JobOpening: move('JobOpening', 'job-spare'),
    LoyaltyConfiguration: move('LoyaltyConfiguration', 'loyalty-config'),
    NotificationDelivery: move(
      'NotificationDelivery',
      'delivery',
      (y) => `"outboxEventId" = ${Y(y, 'event-spare')}`,
    ),
    NotificationRecipient: move('NotificationRecipient', 'recipient'),
    OutboxEvent: move('OutboxEvent', 'event-spare'),
  };
})();

describe('Tenant-enforced operations, careers, franchising and notifications (Security 4C-7)', () => {
  it('the inventory marks exactly these 10 relationships as tenant-enforced, with matching delete rules — and none between business records is left', () => {
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
    // Final milestone: every composite-foreign-key candidate is enforced.
    expect(
      TENANT_RELATIONSHIPS.filter(
        (r) => r.kind === 'composite-fk-candidate' && !r.tenantEnforced,
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
  });

  it('the migration is ONE DO block: version and 4C-3 checks, read-only preflight of every relationship (another business vs missing), lock_timeout, then the keys and triggers', () => {
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
      /^DO \$tenant_fk_operations_careers_notifications\$[\s\S]*\$tenant_fk_operations_careers_notifications\$;$/,
    );
    const order = [
      "set_config('lock_timeout', '5s', true)",
      "current_setting('server_version_num')::int < 150000",
      "to_regprocedure('public.reject_tenant_reassignment()') IS NULL",
      ...RELATIONSHIPS.map(
        (r) => `('${r.child}', '${r.column}', '${r.parent}')`,
      ),
      'Security 4C-7 aborted',
      'DROP CONSTRAINT',
      'ADD CONSTRAINT',
      'CREATE TRIGGER "ChecklistInstance_tenantId_immutable"',
    ].map((s) => code.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    for (const r of RELATIONSHIPS) {
      expect(code).toContain(
        `ALTER TABLE "${r.child}" DROP CONSTRAINT "${r.child}_${r.column}_fkey";`,
      );
      expect(code).toContain(
        `ADD CONSTRAINT "${constraintName(r)}" FOREIGN KEY ("tenantId", "${r.column}") REFERENCES "${r.parent}"("tenantId", "id") ON DELETE ${r.onDelete} ON UPDATE RESTRICT;`,
      );
    }
    expect(code.match(/ADD CONSTRAINT/g)).toHaveLength(10);
    expect(code.match(/DROP CONSTRAINT/g)).toHaveLength(10);
    expect(code.match(/CREATE TRIGGER/g)).toHaveLength(12);
    expect(code).not.toMatch(/CREATE INDEX|CREATE (OR REPLACE )?FUNCTION/);
    // It never repairs, reassigns or deletes data.
    expect(code).not.toMatch(
      /\bUPDATE\s+"|\bDELETE\s+FROM\b|\bINSERT\s+INTO\b|\bTRUNCATE\b/i,
    );
  });

  it('the rollback is ONE DO block that removes only what 4C-7 added and restores the 10 original keys — keeping 4C-3’s function', () => {
    expect(isAppliedAtomically(rollbackSql)).toBe(true);
    expect(rollbackSql.match(/DROP TRIGGER/g)).toHaveLength(12);
    for (const t of PROTECTED_TABLES) {
      expect(rollbackSql).toContain(
        `DROP TRIGGER "${t}_tenantId_immutable" ON "${t}";`,
      );
    }
    for (const r of RELATIONSHIPS) {
      expect(rollbackSql).toContain(
        `ALTER TABLE "${r.child}" DROP CONSTRAINT "${constraintName(r)}";`,
      );
      expect(rollbackSql).toContain(
        `ADD CONSTRAINT "${r.child}_${r.column}_fkey" FOREIGN KEY ("${r.column}") REFERENCES "${r.parent}"("id") ON DELETE ${r.onDelete} ON UPDATE CASCADE;`,
      );
    }
    expect(rollbackSql.match(/ADD CONSTRAINT/g)).toHaveLength(10);
    expect(rollbackSql.replace(/--.*$/gm, '')).not.toMatch(
      /DROP FUNCTION|reject_tenant_reassignment/,
    );
    expect(rollbackSql).not.toMatch(
      /\bUPDATE\s+"|\bDELETE\s+FROM\b|\bINSERT\s+INTO\b|\bTRUNCATE\b/i,
    );
  });

  it('the migrated test database enforces every relationship and ownership — and no business-owned table or relation is left unprotected, and no table outside the approved globals lacks a tenantId (catalog regression guard)', async () => {
    const [enforcement, gaps] = await withScratchClient(baseUrl, (client) =>
      Promise.all([tenantEnforcement(client), remainingGaps(client)]),
    );
    expect(enforcement).toEqual(EXPECTED_ENFORCEMENT);
    expect(gaps).toEqual(NO_GAPS);
  });

  describe('on a scratch database with three fictional businesses', () => {
    let scratch: ScratchDatabase;
    let prisma: PrismaClient;
    let beforeData: string;
    const sql = <T>(fn: (client: Client) => Promise<T>) =>
      withScratchClient(scratch.url, fn);

    beforeAll(async () => {
      scratch = await createScratchDatabase(baseUrl, 'fk_ops');
      await applyMigrations(scratch.url, migrations);
      await loadFixture(scratch.url);
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: scratch.url }),
      });
      beforeData = await dataChecksum(scratch.url);
    });

    afterAll(async () => {
      await prisma?.$disconnect();
      await scratch?.drop();
    });

    it('carries exactly the expected keys and triggers', async () => {
      expect(await sql(tenantEnforcement)).toEqual(EXPECTED_ENFORCEMENT);
      expect(await sql(remainingGaps)).toEqual(NO_GAPS);
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
      expect(results).toHaveLength(10 * 3 * 2);
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
      expect(Object.keys(results)).toHaveLength(10 * 6 * 2);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('rejects a reference to a record that does not exist; the optional job-opening location may be cleared', async () => {
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const r of RELATIONSHIPS) {
          out.push(
            `${relationshipId(r)} missing ${await attempt(client, `UPDATE "${r.child}" SET "${r.column}" = 'ops-missing' WHERE ${rowWhere(r.child, 'a')}`)}`,
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

    it('rejects moving any row of the 12 newly protected tables to another business (immutable tenantId) — a single row or all of them, referenced or not', async () => {
      const results = await sql(async (client) => {
        const out: Record<string, string> = {};
        for (const t of PROTECTED_TABLES) {
          for (const [x, y] of PAIRS) {
            out[`${t} ${x}->${y} row`] = (
              await attempt(client, MOVES[t](x, y))
            ).split(' ')[0];
            out[`${t} ${x}->${y} all`] = (
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
      expect(Object.keys(results)).toHaveLength(12 * 6 * 2);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('cross-business Prisma writes — checked, unchecked, nested, connect, upsert and bulk — cannot attach, re-point or move operational records', async () => {
      const outcomes: Record<string, string> = {};
      for (const [x, y] of PAIRS) {
        const X = (n: string) => id(x, n);
        const Y = (n: string) => id(y, n);
        const writes: Record<string, () => Promise<unknown>> = {
          templateItemUnchecked: () =>
            prisma.checklistTemplateItem.update({
              where: { id: X('template-item') },
              data: { templateId: Y('template-spare') },
            }),
          templateItemConnect: () =>
            prisma.checklistTemplateItem.update({
              where: { id: X('template-item') },
              data: { template: { connect: { id: Y('template-spare') } } },
            }),
          templateStealsItem: () =>
            prisma.checklistTemplate.update({
              where: { id: Y('template-spare') },
              data: { items: { connect: { id: X('template-item') } } },
            }),
          templateNestedItemForeignTenant: () =>
            prisma.checklistTemplate.update({
              where: { id: Y('template-spare') },
              data: {
                items: {
                  create: {
                    tenantId: TENANTS[x],
                    section: 'x',
                    label: 'x',
                    sortOrder: 9,
                  } as never,
                },
              },
            }),
          instanceCreateForeignTemplate: () =>
            prisma.checklistInstance.create({
              data: {
                tenantId: TENANTS[x],
                templateId: Y('template'),
                locationId: X('location'),
                businessDate: new Date('2026-02-01'),
              },
            }),
          instanceCreateForeignLocation: () =>
            prisma.checklistInstance.create({
              data: {
                tenantId: TENANTS[x],
                templateId: X('template'),
                locationId: Y('location'),
                businessDate: new Date('2026-02-01'),
              },
            }),
          instanceLocationConnect: () =>
            prisma.checklistInstance.update({
              where: { id: X('instance-spare') },
              data: { location: { connect: { id: Y('location-spare') } } },
            }),
          instanceItemsMovedToForeignInstance: () =>
            prisma.checklistInstanceItem.updateMany({
              where: { tenantId: TENANTS[x] },
              data: { checklistInstanceId: Y('instance-spare') },
            }),
          instanceStealsItem: () =>
            prisma.checklistInstance.update({
              where: { id: Y('instance-spare') },
              data: { items: { connect: { id: X('instance-item') } } },
            }),
          taskForeignLocation: () =>
            prisma.operationsTask.update({
              where: { id: X('task') },
              data: { locationId: Y('location') },
            }),
          taskCreateForeignLocation: () =>
            prisma.operationsTask.create({
              data: {
                tenantId: TENANTS[x],
                locationId: Y('location'),
                businessDate: new Date('2026-02-01'),
                title: 'x',
                createdByInternalUserId: X('staff'),
              },
            }),
          locationStealsTask: () =>
            prisma.location.update({
              where: { id: Y('location-spare') },
              data: { operationsTasks: { connect: { id: X('task') } } },
            }),
          jobForeignLocation: () =>
            prisma.jobOpening.update({
              where: { id: X('job') },
              data: { locationId: Y('location') },
            }),
          jobLocationConnect: () =>
            prisma.jobOpening.update({
              where: { id: X('job') },
              data: { location: { connect: { id: Y('location') } } },
            }),
          applicationForeignJob: () =>
            prisma.jobApplication.update({
              where: { id: X('application-spare') },
              data: { jobOpeningId: Y('job-spare') },
            }),
          applicationCreateForeignJob: () =>
            prisma.jobApplication.create({
              data: {
                tenantId: TENANTS[x],
                jobOpeningId: Y('job'),
                jobTitleSnapshot: 'x',
                firstName: 'x',
                lastName: 'x',
                email: 'x@example.test',
                phone: 'x',
                location: 'x',
                workAuthorized: true,
                availability: 'x',
                message: 'x',
              },
            }),
          jobStealsApplication: () =>
            prisma.jobOpening.update({
              where: { id: Y('job-spare') },
              data: {
                applications: { connect: { id: X('application-spare') } },
              },
            }),
          applicationNoteForeignApplication: () =>
            prisma.jobApplicationNote.update({
              where: { id: X('application-note') },
              data: { jobApplicationId: Y('application-spare') },
            }),
          applicationNoteCreateForeign: () =>
            prisma.jobApplicationNote.create({
              data: {
                tenantId: TENANTS[x],
                jobApplicationId: Y('application'),
                authorInternalUserId: X('staff'),
                body: 'x',
              },
            }),
          applicationStealsNote: () =>
            prisma.jobApplication.update({
              where: { id: Y('application-spare') },
              data: { notes: { connect: { id: X('application-note') } } },
            }),
          inquiryNoteForeignInquiry: () =>
            prisma.franchiseInquiryNote.update({
              where: { id: X('inquiry-note') },
              data: { franchiseInquiryId: Y('inquiry-spare') },
            }),
          inquiryNoteCreateForeign: () =>
            prisma.franchiseInquiryNote.create({
              data: {
                tenantId: TENANTS[x],
                franchiseInquiryId: Y('inquiry'),
                authorInternalUserId: X('staff'),
                body: 'x',
              },
            }),
          inquiryStealsNote: () =>
            prisma.franchiseInquiry.update({
              where: { id: Y('inquiry-spare') },
              data: { notes: { connect: { id: X('inquiry-note') } } },
            }),
          deliveryForeignEvent: () =>
            prisma.notificationDelivery.update({
              where: { id: X('delivery') },
              data: { outboxEventId: Y('event-spare') },
            }),
          deliveryCreateForeignEvent: () =>
            prisma.notificationDelivery.create({
              data: {
                tenantId: TENANTS[x],
                outboxEventId: Y('event-spare'),
                channel: 'EMAIL',
                recipient: 'x@example.test',
                templateKey: 'x',
                aggregateType: 'FranchiseInquiry',
                aggregateId: X('inquiry'),
              },
            }),
          eventStealsDelivery: () =>
            prisma.outboxEvent.update({
              where: { id: Y('event-spare') },
              data: {
                notificationDeliveries: { connect: { id: X('delivery') } },
              },
            }),
          recipientUpsertMove: () =>
            prisma.notificationRecipient.upsert({
              where: { id: X('recipient') },
              create: {
                tenantId: TENANTS[y],
                purpose: 'x',
                email: 'x@example.test',
              },
              update: { tenantId: TENANTS[y] },
            }),
          jobOpeningMove: () =>
            prisma.jobOpening.updateMany({
              where: { id: X('job-spare') },
              data: { tenantId: TENANTS[y] },
            }),
          outboxEventMove: () =>
            prisma.outboxEvent.updateMany({
              where: { id: X('event-spare') },
              data: { tenantId: TENANTS[y] },
            }),
          cmsPageMove: () =>
            prisma.cmsPage.update({
              where: { id: X('page') },
              data: { tenantId: TENANTS[y] },
            }),
          configMove: () =>
            prisma.loyaltyConfiguration.update({
              where: { id: X('loyalty-config') },
              data: { tenantId: TENANTS[y] },
            }),
        };
        for (const [name, write] of Object.entries(writes)) {
          outcomes[`${name} ${x}->${y}`] = await prismaOutcome(write());
        }
      }
      expect(
        Object.entries(outcomes).filter(
          ([, o]) => !['P2003/23503', 'P2039/23001', 'validation'].includes(o),
        ),
      ).toEqual([]);
      // Nested rows cannot even name a business: Prisma takes tenantId from
      // the parent (composite relation) and refuses the argument.
      expect(
        Object.entries(outcomes)
          .filter(([, o]) => o === 'validation')
          .map(([k]) => k),
      ).toEqual(
        PAIRS.map(([x, y]) => `templateNestedItemForeignTenant ${x}->${y}`),
      );
      expect(Object.keys(outcomes)).toHaveLength(31 * 6);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('same-business operational workflows keep working: nested checklist items, tasks, job openings (location set and cleared by column), applications, notes, outbox events and deliveries', async () => {
      const rollback = new Error('rollback');
      await prisma
        .$transaction(async (tx) => {
          for (const x of TAGS) {
            const X = (n: string) => id(x, n);
            const instance = await tx.checklistInstance.create({
              data: {
                tenantId: TENANTS[x],
                templateId: X('template'),
                locationId: X('location-spare'),
                businessDate: new Date('2026-03-01'),
                items: {
                  create: [{ section: 'Open', label: 'Lights', sortOrder: 1 }],
                },
              },
              include: { items: true },
            });
            expect(instance.items.map((i) => i.tenantId)).toEqual([TENANTS[x]]);
            await tx.checklistTemplate.update({
              where: { id: X('template-spare') },
              data: {
                items: {
                  create: { section: 'Close', label: 'Lock up', sortOrder: 2 },
                },
              },
            });
            await tx.checklistInstanceItem.updateMany({
              where: { checklistInstanceId: X('instance') },
              data: { completedAt: new Date() },
            });
            await tx.operationsTask.create({
              data: {
                tenantId: TENANTS[x],
                locationId: X('location-spare'),
                businessDate: new Date('2026-03-01'),
                title: 'Clean grinder',
                createdByInternalUserId: X('staff'),
              },
            });
            await tx.jobOpening.update({
              where: { id: X('job') },
              data: { locationId: X('location-spare') },
            });
            const cleared = await tx.jobOpening.update({
              where: { id: X('job') },
              data: { locationId: null },
            });
            expect([cleared.locationId, cleared.tenantId]).toEqual([
              null,
              TENANTS[x],
            ]);
            await tx.jobOpening.update({
              where: { id: X('job-spare') },
              data: {
                applications: {
                  create: {
                    jobTitleSnapshot: 'Shift lead',
                    firstName: 'Nested',
                    lastName: x,
                    email: `${x}.nested@example.test`,
                    phone: '555-0101',
                    location: 'Fictional City',
                    workAuthorized: true,
                    availability: 'Any',
                    message: 'Nested',
                  },
                },
              },
            });
            await tx.jobApplication.update({
              where: { id: X('application') },
              data: {
                status: 'REVIEWING',
                notes: {
                  create: {
                    authorInternalUserId: X('staff'),
                    body: 'Nested note',
                  },
                },
              },
            });
            await tx.franchiseInquiry.update({
              where: { id: X('inquiry') },
              data: {
                status: 'REVIEWING',
                notes: {
                  create: {
                    authorInternalUserId: X('staff'),
                    body: 'Nested note',
                  },
                },
              },
            });
            const event = await tx.outboxEvent.create({
              data: {
                tenantId: TENANTS[x],
                aggregateType: 'FranchiseInquiry',
                aggregateId: X('inquiry-spare'),
                eventType: 'franchise_inquiry.submitted',
                payload: {},
              },
            });
            await tx.notificationDelivery.create({
              data: {
                tenantId: TENANTS[x],
                outboxEventId: event.id,
                channel: 'EMAIL',
                recipient: `${x}.ops@example.test`,
                templateKey: 'franchise_inquiry_received',
                aggregateType: event.aggregateType,
                aggregateId: event.aggregateId,
              },
            });
            await tx.outboxEvent.updateMany({
              where: { id: event.id },
              data: { status: 'PROCESSED', processedAt: new Date() },
            });
            await tx.notificationDelivery.updateMany({
              where: { outboxEventId: event.id },
              data: { status: 'SENT' },
            });
            for (const [model, where] of [
              ['notificationRecipient', { id: X('recipient') }],
              ['cmsPage', { id: X('page') }],
              ['giftCardConfiguration', { id: X('gift-config') }],
              ['loyaltyConfiguration', { id: X('loyalty-config') }],
            ] as const) {
              // Ordinary updates (same business) are untouched by the
              // ownership trigger.
              await (
                tx as unknown as Record<
                  string,
                  { updateMany(a: object): Promise<unknown> }
                >
              )[model].updateMany({
                where,
                data: { tenantId: TENANTS[x] },
              });
            }
          }
          throw rollback;
        })
        .catch((e) => {
          if (e !== rollback) throw e;
        });
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('Prisma `disconnect` of the optional job-opening location is refused (it would clear tenantId too); the application clears the column instead', async () => {
      expect(
        await prismaOutcome(
          prisma.jobOpening.update({
            where: { id: id('c', 'job') },
            data: { location: { disconnect: true } },
          }),
        ),
      ).toBe('P2039/23001');
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('concurrent writes cannot slip a cross-business reference in: a child being written locks its parent against a move or delete, and parallel cross-business inserts all fail', async () => {
      const open = async () => {
        const c = new Client({ connectionString: scratch.url });
        await c.connect();
        return c;
      };
      const [t1, t2] = [await open(), await open()];
      const lockTimeout = (c: Client) =>
        c.query(`SET LOCAL lock_timeout = '1500ms'`);
      const run = (c: Client, s: string) =>
        c.query(s).then(
          () => 'ok',
          (e: { code?: string }) => String(e.code),
        );
      try {
        // T1 adds an application to business A's job (uncommitted). T2 tries
        // to delete that job, then to move it to business B.
        await t1.query('BEGIN');
        const insert = await run(
          t1,
          `INSERT INTO "JobApplication" SELECT (jsonb_populate_record(NULL::"JobApplication", to_jsonb(t) || '{"id":"race-application"}'::jsonb)).* FROM "JobApplication" t WHERE id = '${id('a', 'application')}'`,
        );
        await t2.query('BEGIN');
        await lockTimeout(t2);
        const remove = await run(
          t2,
          `DELETE FROM "JobOpening" WHERE id = '${id('a', 'job')}'`,
        );
        await t2.query('ROLLBACK');
        // The move changes a key column, so it waits for T1's key-share
        // lock; once T1 ends, the ownership trigger refuses it.
        await t2.query('BEGIN');
        let settled = false;
        const move = run(
          t2,
          `UPDATE "JobOpening" SET "tenantId" = '${TENANTS.b}' WHERE id = '${id('a', 'job')}'`,
        ).then((r) => {
          settled = true;
          return r;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        const moveWaited = !settled;
        await t1.query('ROLLBACK');
        const moved = await move;
        await t2.query('ROLLBACK');
        expect({ insert, remove, moveWaited, moved }).toEqual({
          insert: 'ok',
          // The parent's key is share-locked by T1's foreign-key check.
          remove: '55P03',
          moveWaited: true,
          moved: '23001',
        });
      } finally {
        await Promise.all([t1.end(), t2.end()]);
      }

      // Twelve sessions at once: six same-business and six cross-business
      // notes. Exactly the six same-business ones succeed.
      const clients = await Promise.all(Array.from({ length: 12 }, open));
      try {
        const results = await Promise.all(
          clients.map((c, n) => {
            const [x, y] = PAIRS[n % 6];
            const target = n < 6 ? x : y;
            return run(
              c,
              `INSERT INTO "FranchiseInquiryNote" ("id", "tenantId", "franchiseInquiryId", "authorInternalUserId", "body")
               VALUES ('par-${n}', '${TENANTS[x]}', '${id(target, 'inquiry')}', '${id(x, 'staff')}', 'parallel')`,
            );
          }),
        );
        expect(results).toEqual([
          ...Array<string>(6).fill('ok'),
          ...Array<string>(6).fill('23503'),
        ]);
        await withScratchClient(scratch.url, (c) =>
          c.query(`DELETE FROM "FranchiseInquiryNote" WHERE id LIKE 'par-%'`),
        );
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('the integrity checker reports CLEAN with zero unchecked rows', async () => {
      const report = await sql((client) => checkTenantIntegrity(client));
      expect([report.verdict, report.violations, report.uncheckedRows]).toEqual(
        ['clean', 0, 0],
      );
    });

    it('deliberately removing ANY of the keys or ownership triggers is detected by the catalog guard, and lets the write it stopped through', async () => {
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
      ];
      const results = await sql(async (client) => {
        const out: Array<{
          missing: string[];
          withIt: string;
          without: string;
          gaps: Awaited<ReturnType<typeof remainingGaps>>;
        }> = [];
        for (const m of mutations) {
          const withIt = (await attempt(client, m.write)).split(' ')[0];
          await client.query('BEGIN');
          try {
            await client.query(m.drop);
            const enforcement = await tenantEnforcement(client);
            const gaps = await remainingGaps(client);
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
              gaps,
            });
          } finally {
            await client.query('ROLLBACK');
          }
        }
        return out;
      });
      expect(results).toEqual(
        mutations.map((m, n) => ({
          missing: m.missing,
          withIt: m.blocked,
          without: 'ok',
          // The whole-database guard notices too.
          gaps:
            n < RELATIONSHIPS.length
              ? NO_GAPS
              : {
                  ...NO_GAPS,
                  unprotected: [PROTECTED_TABLES[n - RELATIONSHIPS.length]],
                },
        })),
      );
      expect(mutations).toHaveLength(10 + 12);
      expect(await sql(tenantEnforcement)).toEqual(EXPECTED_ENFORCEMENT);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });
  });

  // Delete behaviour is compared against a database migrated to just
  // before 4C-7 holding the identical fictional rows.
  describe('deletion behaviour is unchanged', () => {
    let before: ScratchDatabase;
    let after: ScratchDatabase;
    const deletes: Record<string, string> = {
      'location in use (Restrict)': `DELETE FROM "Location" WHERE id = '${id('a', 'location')}'`,
      'template in use by an instance (Restrict)': `DELETE FROM "ChecklistTemplate" WHERE id = '${id('a', 'template')}'`,
      'unused template': `DELETE FROM "ChecklistTemplate" WHERE id = '${id('b', 'template-spare')}'`,
      'template item': `DELETE FROM "ChecklistTemplateItem" WHERE id = '${id('b', 'template-item')}'`,
      'instance (items cascade)': `DELETE FROM "ChecklistInstance" WHERE id = '${id('c', 'instance')}'`,
      task: `DELETE FROM "OperationsTask" WHERE id = '${id('a', 'task')}'`,
      'job in use (Restrict)': `DELETE FROM "JobOpening" WHERE id = '${id('b', 'job')}'`,
      'unused job': `DELETE FROM "JobOpening" WHERE id = '${id('b', 'job-spare')}'`,
      'application (notes cascade)': `DELETE FROM "JobApplication" WHERE id = '${id('c', 'application')}'`,
      'inquiry (notes cascade)': `DELETE FROM "FranchiseInquiry" WHERE id = '${id('a', 'inquiry')}'`,
      'outbox event in use (Restrict)': `DELETE FROM "OutboxEvent" WHERE id = '${id('b', 'event')}'`,
      'unused outbox event': `DELETE FROM "OutboxEvent" WHERE id = '${id('b', 'event-spare')}'`,
      'staff member who wrote notes (Restrict)': `DELETE FROM "InternalUser" WHERE id = '${id('c', 'staff')}'`,
    };
    const counts = `SELECT concat_ws(',',
        (SELECT count(*) FROM "ChecklistTemplate"), (SELECT count(*) FROM "ChecklistTemplateItem"),
        (SELECT count(*) FROM "ChecklistInstance"), (SELECT count(*) FROM "ChecklistInstanceItem"),
        (SELECT count(*) FROM "OperationsTask"), (SELECT count(*) FROM "JobOpening"),
        (SELECT count(*) FROM "JobApplication"), (SELECT count(*) FROM "JobApplicationNote"),
        (SELECT count(*) FROM "FranchiseInquiry"), (SELECT count(*) FROM "FranchiseInquiryNote"),
        (SELECT count(*) FROM "OutboxEvent"), (SELECT count(*) FROM "NotificationDelivery")) AS c`;
    const outcomes = (url: string) =>
      withScratchClient(url, async (client) => {
        const out: Record<string, string> = {};
        for (const [name, statement] of Object.entries(deletes)) {
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
      before = await createScratchDatabase(baseUrl, 'fk_ops_del_before');
      after = await createScratchDatabase(baseUrl, 'fk_ops_del_after');
      await applyMigrations(before.url, migrations.slice(0, targetIndex));
      await applyMigrations(after.url, migrations);
      await loadFixture(before.url);
      await loadFixture(after.url);
    });

    afterAll(async () => {
      await before?.drop();
      await after?.drop();
    });

    it('every delete has the same outcome before and after 4C-7 (no intended change)', async () => {
      const was = await outcomes(before.url);
      const is = await outcomes(after.url);
      expect(is).toEqual(was);
      expect(is['job in use (Restrict)']).toBe('23503');
      expect(is['instance (items cascade)']).toMatch(/^ok /);
      expect(is['outbox event in use (Restrict)']).toBe('23503');
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
    const beforeFourC7 = async (label: string) => {
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
    // schema.prisma describes the NEWEST migration, so any later one (ESP-03's
    // payment recovery foundation) is applied first by the real runner — the
    // same approach as the Security 4C-6 suite — and then the database and the
    // schema must agree exactly.
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

    it('succeeds on clean data: everything enforced, data unchanged, no drift, integrity CLEAN', async () => {
      const scratch = await beforeFourC7('fk_ops_ok');
      const data = await dataChecksum(scratch.url);
      expect((await deploy(scratch.url)).code).toBe(0);
      expect(await migrationRow(scratch.url)).toEqual(['finished']);
      expect(await enforcement(scratch.url)).toEqual(EXPECTED_ENFORCEMENT);
      expect(await withScratchClient(scratch.url, remainingGaps)).toEqual(
        NO_GAPS,
      );
      expect(await dataChecksum(scratch.url)).toBe(data);
      expect(await noDrift(scratch.url)).toBe(0);
      const report = await withScratchClient(scratch.url, (client) =>
        checkTenantIntegrity(client),
      );
      expect([report.verdict, report.violations, report.uncheckedRows]).toEqual(
        ['clean', 0, 0],
      );
    });

    it('mismatched rows — cross-business checklist, task, careers, franchising and notification links, and missing parents — abort it before any change, all listed with separate counts; never repaired; recovery only after an explicit fix', async () => {
      const scratch = await beforeFourC7('fk_ops_cross');
      const bad = `
        UPDATE "ChecklistInstance" SET "locationId" = '${id('b', 'location-spare')}' WHERE id = '${id('a', 'instance-spare')}';
        UPDATE "OperationsTask" SET "locationId" = '${id('c', 'location')}' WHERE id = '${id('a', 'task')}';
        UPDATE "JobApplication" SET "jobOpeningId" = '${id('a', 'job-spare')}' WHERE id = '${id('b', 'application-spare')}';
        UPDATE "FranchiseInquiryNote" SET "franchiseInquiryId" = 'ops-missing-inquiry' WHERE id = '${id('c', 'inquiry-note')}';
        UPDATE "NotificationDelivery" SET "outboxEventId" = '${id('c', 'event-spare')}' WHERE id = '${id('b', 'delivery')}';
        UPDATE "NotificationDelivery" SET "outboxEventId" = 'ops-missing-event' WHERE id = '${id('a', 'delivery')}';`;
      // Legacy-style data the single-column keys allowed; planted with
      // triggers suspended, as history would be.
      await run(
        scratch.url,
        `SET session_replication_role = replica; ${bad} SET session_replication_role = origin;`,
      );
      const catalog = await databaseCatalog(scratch.url);
      const data = await dataChecksum(scratch.url);

      const failed = await deploy(scratch.url);
      expect(failed.code).not.toBe(0);
      expect(failed.out).toContain('P3018');
      expect(failed.out).toContain('Security 4C-7 aborted');
      for (const line of [
        "ChecklistInstance.locationId: 1 row(s) name another business's record, 0 row(s) name a missing one",
        "OperationsTask.locationId: 1 row(s) name another business's record, 0 row(s) name a missing one",
        "JobApplication.jobOpeningId: 1 row(s) name another business's record, 0 row(s) name a missing one",
        "FranchiseInquiryNote.franchiseInquiryId: 0 row(s) name another business's record, 1 row(s) name a missing one",
        "NotificationDelivery.outboxEventId: 1 row(s) name another business's record, 1 row(s) name a missing one",
      ]) {
        expect(failed.out).toContain(line);
      }
      expect(failed.out).not.toContain('ChecklistTemplateItem.templateId');
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);
      expect(await dataChecksum(scratch.url)).toBe(data);
      expect(await migrationRow(scratch.url)).toEqual(['unfinished']);
      expect((await deploy(scratch.url)).out).toContain('P3009');

      await run(
        scratch.url,
        `SET session_replication_role = replica;
         UPDATE "ChecklistInstance" SET "locationId" = '${id('a', 'location')}' WHERE id = '${id('a', 'instance-spare')}';
         UPDATE "OperationsTask" SET "locationId" = '${id('a', 'location')}' WHERE id = '${id('a', 'task')}';
         UPDATE "JobApplication" SET "jobOpeningId" = '${id('b', 'job')}' WHERE id = '${id('b', 'application-spare')}';
         UPDATE "FranchiseInquiryNote" SET "franchiseInquiryId" = '${id('c', 'inquiry')}' WHERE id = '${id('c', 'inquiry-note')}';
         UPDATE "NotificationDelivery" SET "outboxEventId" = '${id('b', 'event')}' WHERE id = '${id('b', 'delivery')}';
         UPDATE "NotificationDelivery" SET "outboxEventId" = '${id('a', 'event')}' WHERE id = '${id('a', 'delivery')}';
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

    it('refuses to run without Security 4C-3’s function, changing nothing', async () => {
      const scratch = await beforeFourC7('fk_ops_no43');
      await run(
        scratch.url,
        `ALTER FUNCTION "reject_tenant_reassignment"() RENAME TO "renamed_for_test"`,
      );
      const catalog = await databaseCatalog(scratch.url);
      const failed = await deploy(scratch.url);
      expect(failed.code).not.toBe(0);
      expect(failed.out).toMatch(/requires Security 4C-3/);
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);
    });

    it('a failure at its LAST statement leaves no partial change', async () => {
      const scratch = await beforeFourC7('fk_ops_late');
      // Occupy the name of the last trigger it creates.
      await run(
        scratch.url,
        `CREATE TRIGGER "OutboxEvent_tenantId_immutable" BEFORE UPDATE ON "OutboxEvent"
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
      const scratch = await beforeFourC7('fk_ops_lock');
      const catalog = await databaseCatalog(scratch.url);
      const held = await withScratchClient(scratch.url, async (client) => {
        await client.query('BEGIN');
        // A worker writing a delivery holds this lock.
        await client.query(
          `LOCK TABLE "NotificationDelivery" IN ROW EXCLUSIVE MODE`,
        );
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

    it('while 4C-7 is applied, rolling back 4C-3 is refused atomically — its function is still in use', async () => {
      const scratch = await beforeFourC7('fk_ops_order');
      expect((await deploy(scratch.url)).code).toBe(0);
      const catalog = await databaseCatalog(scratch.url);
      const name = '20261017090000_rollback_tenant_fk_customer_order_payment';
      const failed = await prisma(
        scratch.url,
        ['migrate', 'deploy'],
        project(throughNames, { name, sql: rollbackOf(FOUR_C_3) }),
      );
      expect(failed.code).not.toBe(0);
      expect(failed.out).toMatch(/depend/);
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);
      expect(await migrationRow(scratch.url, name)).toEqual(['unfinished']);
    });

    it('the documented rollback — shipped as a new forward migration — restores the pre-4C-7 catalog exactly, keeps the data, and 4C-7 re-applies; then 4C-6, 4C-5, 4C-4 and 4C-3 roll back in order to the pre-4C-3 catalog', async () => {
      const scratch = await beforeFourC7('fk_ops_rollback');
      const data = await dataChecksum(scratch.url);
      expect((await deploy(scratch.url)).code).toBe(0);
      const rollback = {
        name: '20261017090000_rollback_tenant_fk_operations_careers_notifications',
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
      const reference = await fresh('fk_ops_rollback_ref');
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
        name: '20261017100000_reapply_tenant_fk_operations_careers_notifications',
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

      // The full documented order on a second database.
      const chain = await beforeFourC7('fk_ops_chain');
      const chainData = await dataChecksum(chain.url);
      expect((await deploy(chain.url)).code).toBe(0);
      const steps = [
        rollback,
        {
          name: '20261017110000_rollback_tenant_fk_catalog_offers_snapshots',
          sql: rollbackOf(PREVIOUS),
        },
        {
          name: '20261017120000_rollback_tenant_fk_staff_authorization',
          sql: rollbackOf(FOUR_C_5),
        },
        {
          name: '20261017130000_rollback_tenant_fk_loyalty_giftcard_promotion',
          sql: rollbackOf(FOUR_C_4),
        },
        {
          name: '20261017140000_rollback_tenant_fk_customer_order_payment',
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
      const preFourC3 = await fresh('fk_ops_chain_ref');
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
