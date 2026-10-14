import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
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
  createTestTenantB,
  createTestTenantC,
  databaseCatalog,
  isAppliedAtomically,
  listMigrations,
  prismaCli,
  removeTestTenantB,
  removeTestTenantC,
  tenantContextFor,
  withScratchClient,
  type ExtraMigration,
  type MigrationProject,
  type ScratchDatabase,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { AuditModule } from '../audit/audit.module';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { CustomersModule } from '../customers/customers.module';
import { CrmModule } from '../crm/crm.module';
import { CustomerNotesService } from '../crm/application/customer-notes.service';
import { AuthorizationService } from '../internal-auth/authorization/authorization.service';
import { AuthorizationContext } from '../internal-auth/authorization/authorization-context';
import { AdminInternalUsersService } from '../internal-users/application/admin-internal-users.service';
import { dataChecksum } from './historical-state';

// Security 4C-5 — PostgreSQL-enforced tenant isolation for staff identities
// and authorization:
//   - seventeen composite foreign keys ("tenantId", <column>) -> parent
//     ("tenantId", "id"): the role's permissions, the user, role and
//     LOCATION scope of every role assignment (scopeId's first foreign key),
//     and every staff-actor reference (audit actor, approval requester and
//     decider, checklist completer and exception actor, task creator and
//     completer, note authors, media uploader, points-ledger and gift-card
//     actors);
//   - a CHECK keeping an assignment's scope shape (CORPORATE <=> no
//     scopeId) and a partial unique index allowing one CORPORATE grant per
//     user and role;
//   - eleven more tables whose rows can never move to another business.
//
// With three fictional businesses (A = Mocha House, B and C = test
// businesses) this spec proves: the schema, inventory, migration and
// rollback agree; the configured test database enforces everything, and a
// removed key, trigger, CHECK or index is detected; same-business staff
// writes work; every cross-business grant, role, location, staff actor and
// move is rejected by PostgreSQL — by direct SQL and by Prisma writes
// (nested create / connect / set / connectOrCreate, upsert, updateMany);
// the application's role-assignment, revocation, deactivation and note
// paths stay tenant-safe; delete behaviour is unchanged except the one
// intended change; the integrity checker reports CLEAN; and the migration,
// run by the REAL `prisma migrate deploy`, aborts on mismatched rows before
// changing anything, is atomic, fails fast on locks, leaves no drift, and
// its rollback restores the previous catalog exactly. All data is
// fictional.

jest.setTimeout(600_000);

const repoRoot = join(__dirname, '../../../..');
const databaseDir = join(repoRoot, 'packages/database');
const migrationsDir = join(databaseDir, 'prisma/migrations');
const MIGRATION = '20261014090000_tenant_fk_staff_authorization';
const PREVIOUS = '20261013090000_tenant_fk_loyalty_giftcard_promotion';
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
const id = (tag: Tag, name: string) => `sa-${tag}-${name}`;

type OnDelete = 'CASCADE' | 'RESTRICT';

interface Relationship {
  readonly child: string;
  readonly column: string;
  readonly parent: string;
  readonly onDelete: OnDelete;
  readonly optional: boolean;
  // The fixture row of the child, and an unused parent of each business it
  // is pointed at (so no other unique constraint can fire first).
  readonly childRow: string;
  readonly spareParent: string;
  // Other columns a copied row must change to stay unique.
  readonly copy?: Readonly<Record<string, string>>;
}

const staff = (
  child: string,
  column: string,
  childRow: string,
  optional = false,
  copy?: Record<string, string>,
): Relationship => ({
  child,
  column,
  parent: 'InternalUser',
  onDelete: 'RESTRICT',
  optional,
  childRow,
  spareParent: 'staff-spare',
  copy,
});

const RELATIONSHIPS: readonly Relationship[] = [
  {
    child: 'InternalRolePermission',
    column: 'roleId',
    parent: 'InternalRole',
    onDelete: 'CASCADE',
    optional: false,
    childRow: 'permission',
    spareParent: 'role-spare',
  },
  {
    child: 'InternalUserRoleAssignment',
    column: 'internalUserId',
    parent: 'InternalUser',
    onDelete: 'CASCADE',
    optional: false,
    childRow: 'grant-corp',
    spareParent: 'staff-spare',
  },
  {
    child: 'InternalUserRoleAssignment',
    column: 'roleId',
    parent: 'InternalRole',
    onDelete: 'RESTRICT',
    optional: false,
    childRow: 'grant-corp',
    spareParent: 'role-spare',
  },
  {
    child: 'InternalUserRoleAssignment',
    column: 'scopeId',
    parent: 'Location',
    onDelete: 'RESTRICT',
    optional: true,
    childRow: 'grant-loc',
    spareParent: 'location-spare',
  },
  staff('InternalAuditEvent', 'actorInternalUserId', 'audit'),
  staff('ApprovalRequest', 'requestedByInternalUserId', 'approval'),
  staff('ApprovalRequest', 'decidedByInternalUserId', 'approval', true),
  staff('ChecklistInstanceItem', 'completedByInternalUserId', 'item', true),
  staff('ChecklistInstanceItem', 'exceptionByInternalUserId', 'item', true),
  staff('OperationsTask', 'createdByInternalUserId', 'task'),
  staff('OperationsTask', 'completedByInternalUserId', 'task', true),
  staff('CustomerNote', 'authorInternalUserId', 'note'),
  staff('JobApplicationNote', 'authorInternalUserId', 'app-note'),
  staff('FranchiseInquiryNote', 'authorInternalUserId', 'inquiry-note'),
  staff('MediaAsset', 'uploadedByInternalUserId', 'media', false, {
    objectKey: 'media-copy',
  }),
  staff('MochaBeanLedgerEntry', 'actorInternalUserId', 'ledger', true),
  staff('GiftCardTransaction', 'actorInternalUserId', 'gc-tx', true),
];

const relationshipId = (r: Relationship) => `${r.child}.${r.column}`;
const constraintName = (r: Relationship) =>
  `${r.child}_tenantId_${r.column}_fkey`;

// Tables whose rows can never move to another business once 4C-5 is
// applied: the eleven it protects, plus the three staff-actor tables
// Security 4C-3 / 4C-4 already protect (asserted here too).
const NEW_PROTECTED = [
  'ApprovalRequest',
  'ChecklistInstanceItem',
  'FranchiseInquiryNote',
  'InternalAuditEvent',
  'InternalRole',
  'InternalRolePermission',
  'InternalUser',
  'InternalUserRoleAssignment',
  'JobApplicationNote',
  'MediaAsset',
  'OperationsTask',
];
const ALREADY_PROTECTED = [
  'CustomerNote',
  'GiftCardTransaction',
  'MochaBeanLedgerEntry',
];
const PROTECTED_TABLES = [...NEW_PROTECTED, ...ALREADY_PROTECTED].sort();

const SCOPE_CHECK =
  'InternalUserRoleAssignment_scope_shape_check: CHECK (((("scopeType" = \'CORPORATE\'::"InternalScopeType") AND ("scopeId" IS NULL)) OR (("scopeType" = \'LOCATION\'::"InternalScopeType") AND ("scopeId" IS NOT NULL))))';
const CORPORATE_INDEX =
  'index: CREATE UNIQUE INDEX "InternalUserRoleAssignment_corporate_grant_key" ON public."InternalUserRoleAssignment" USING btree ("internalUserId", "roleId") WHERE ("scopeType" = \'CORPORATE\'::"InternalScopeType")';

const EXPECTED_FOREIGN_KEYS = RELATIONSHIPS.map(
  (r) =>
    `${constraintName(r)}: FOREIGN KEY ("tenantId", "${r.column}") REFERENCES "${r.parent}"("tenantId", id) ON UPDATE RESTRICT ON DELETE ${r.onDelete}`,
).sort();
const immutabilityTrigger = (t: string) =>
  `trigger: CREATE TRIGGER "${t}_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON public."${t}" FOR EACH ROW WHEN ((old."tenantId" IS DISTINCT FROM new."tenantId")) EXECUTE FUNCTION reject_tenant_reassignment()`;
// Ordered by trigger name, as PostgreSQL lists them ("C" collation).
const EXPECTED_IMMUTABILITY = PROTECTED_TABLES.map(immutabilityTrigger).sort();
const EXPECTED_ENFORCEMENT = [
  ...EXPECTED_FOREIGN_KEYS,
  ...EXPECTED_IMMUTABILITY,
  SCOPE_CHECK,
  CORPORATE_INDEX,
];

// Every foreign key on the seventeen referencing columns, every ownership
// trigger on the fourteen protected tables, the scope CHECK and the
// CORPORATE-grant index — as PostgreSQL defines them. Exactly
// EXPECTED_ENFORCEMENT means: composite, on the right parent key, the right
// delete action, no single-column key left behind, and no row can move.
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
  const triggers = await client.query<{ d: string }>(
    `SELECT 'trigger: ' || pg_get_triggerdef(t.oid) AS d
       FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND p.proname = 'reject_tenant_reassignment'
        AND t.tgrelid::regclass::text IN (${PROTECTED_TABLES.map((t) => `'"${t}"'`).join(', ')})
      ORDER BY t.tgname COLLATE "C"`,
  );
  const checks = await client.query<{ d: string }>(
    `SELECT conname || ': ' || pg_get_constraintdef(oid) AS d FROM pg_constraint
      WHERE contype = 'c' AND conrelid = '"InternalUserRoleAssignment"'::regclass
      ORDER BY conname COLLATE "C"`,
  );
  const indexes = await client.query<{ d: string }>(
    `SELECT 'index: ' || indexdef AS d FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'InternalUserRoleAssignment'
        AND indexdef LIKE '%WHERE%'
      ORDER BY indexname COLLATE "C"`,
  );
  return [...keys.rows, ...triggers.rows, ...checks.rows, ...indexes.rows].map(
    (r) => r.d,
  );
}

// Fictional data for one business: every relationship in use, plus unused
// "spare" parents to point rows at. Unchecked creates with explicit ids, so
// the same rows load into a pre-4C-5 database too.
async function loadBusiness(prisma: PrismaClient, tag: Tag) {
  const tenantId = TENANTS[tag];
  const i = (name: string) => id(tag, name);
  for (const name of ['staff', 'staff-2', 'staff-3', 'staff-spare']) {
    await prisma.internalUser.create({
      data: {
        id: i(name),
        tenantId,
        externalProvider: 'dev',
        externalSubject: i(name),
        email: `${tag}.${name}.sa@example.test`,
        status: 'ACTIVE',
      },
    });
  }
  for (const name of ['location', 'location-2', 'location-spare']) {
    await prisma.location.create({
      data: { id: i(name), tenantId, name: 'Store', slug: i(name) },
    });
  }
  for (const name of ['role', 'role-2', 'role-spare']) {
    await prisma.internalRole.create({
      data: { id: i(name), tenantId, key: i(name), displayName: 'Staff' },
    });
  }
  await prisma.internalRolePermission.createMany({
    data: [
      { tenantId, roleId: i('role'), permissionKey: 'orders.view' },
      { tenantId, roleId: i('role-2'), permissionKey: 'orders.view' },
    ],
  });
  await prisma.internalUserRoleAssignment.createMany({
    data: [
      {
        id: i('grant-corp'),
        tenantId,
        internalUserId: i('staff'),
        roleId: i('role'),
        scopeType: 'CORPORATE',
        scopeId: null,
      },
      // The only reference to location-2: deleting it shows the one
      // intended delete-behaviour change.
      {
        id: i('grant-loc'),
        tenantId,
        internalUserId: i('staff'),
        roleId: i('role'),
        scopeType: 'LOCATION',
        scopeId: i('location-2'),
      },
      {
        id: i('grant-3'),
        tenantId,
        internalUserId: i('staff-3'),
        roleId: i('role'),
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    ],
  });
  await prisma.internalAuditEvent.create({
    data: {
      id: i('audit'),
      tenantId,
      actorInternalUserId: i('staff'),
      action: 'user.role_assigned',
      targetType: 'internal_user',
      targetId: i('staff-3'),
      reason: 'fixture',
    },
  });
  await prisma.campaign.create({
    data: { id: i('campaign'), tenantId, name: 'Fictional Campaign' },
  });
  await prisma.approvalRequest.create({
    data: {
      id: i('approval'),
      tenantId,
      targetType: 'Campaign',
      targetId: i('campaign'),
      action: 'activate',
      status: 'APPROVED',
      requestedByInternalUserId: i('staff'),
      decidedByInternalUserId: i('staff-2'),
      decidedAt: new Date('2026-01-02T00:00:00Z'),
      decisionReason: 'fixture',
    },
  });
  await prisma.checklistTemplate.create({
    data: { id: i('template'), tenantId, key: i('template'), name: 'Opening' },
  });
  await prisma.checklistInstance.create({
    data: {
      id: i('instance'),
      tenantId,
      templateId: i('template'),
      locationId: i('location'),
      businessDate: new Date('2026-01-02'),
    },
  });
  await prisma.checklistInstanceItem.create({
    data: {
      id: i('item'),
      tenantId,
      checklistInstanceId: i('instance'),
      section: 'Front',
      label: 'Lights',
      sortOrder: 1,
      completedByInternalUserId: i('staff'),
      completedAt: new Date('2026-01-02T08:00:00Z'),
      exceptionByInternalUserId: i('staff-2'),
      exceptionReason: 'fixture',
    },
  });
  await prisma.operationsTask.create({
    data: {
      id: i('task'),
      tenantId,
      locationId: i('location'),
      businessDate: new Date('2026-01-02'),
      title: 'Restock',
      createdByInternalUserId: i('staff'),
      completedByInternalUserId: i('staff-2'),
      completedAt: new Date('2026-01-02T09:00:00Z'),
    },
  });
  await prisma.customer.create({
    data: {
      id: i('customer'),
      tenantId,
      externalProvider: 'dev',
      externalSubject: i('customer'),
    },
  });
  await prisma.customerNote.create({
    data: {
      id: i('note'),
      tenantId,
      customerId: i('customer'),
      authorInternalUserId: i('staff'),
      body: 'Fictional note',
    },
  });
  await prisma.customerLoyaltyAccount.create({
    data: {
      id: i('loyalty'),
      tenantId,
      customerId: i('customer'),
      balance: 10,
    },
  });
  await prisma.mochaBeanLedgerEntry.create({
    data: {
      id: i('ledger'),
      tenantId,
      loyaltyAccountId: i('loyalty'),
      type: 'MANUAL_ADJUSTMENT',
      amount: 10,
      reason: 'fixture',
      actorInternalUserId: i('staff'),
    },
  });
  await prisma.giftCard.create({
    data: {
      id: i('card'),
      tenantId,
      codeHash: i('card'),
      last4: '0000',
      originalValueMinorUnits: 500,
      balanceMinorUnits: 500,
    },
  });
  await prisma.giftCardTransaction.create({
    data: {
      id: i('gc-tx'),
      tenantId,
      giftCardId: i('card'),
      type: 'ADJUSTMENT',
      amountMinorUnits: 0,
      balanceAfterMinorUnits: 500,
      reason: 'fixture',
      actorInternalUserId: i('staff'),
    },
  });
  await prisma.jobOpening.create({
    data: {
      id: i('job'),
      tenantId,
      title: 'Barista',
      employmentType: 'PART_TIME',
      summary: 's',
      description: 'd',
      responsibilities: 'r',
      qualifications: 'q',
    },
  });
  await prisma.jobApplication.create({
    data: {
      id: i('app'),
      tenantId,
      jobOpeningId: i('job'),
      jobTitleSnapshot: 'Barista',
      firstName: 'Fictional',
      lastName: 'Applicant',
      email: `${tag}.applicant@example.test`,
      phone: '5550000000',
      location: 'Anywhere',
      workAuthorized: true,
      availability: 'Weekends',
      message: 'Hello',
    },
  });
  await prisma.jobApplicationNote.create({
    data: {
      id: i('app-note'),
      tenantId,
      jobApplicationId: i('app'),
      authorInternalUserId: i('staff'),
      body: 'Fictional note',
    },
  });
  await prisma.franchiseInquiry.create({
    data: {
      id: i('inquiry'),
      tenantId,
      firstName: 'Fictional',
      lastName: 'Investor',
      email: `${tag}.investor@example.test`,
      phone: '5550000000',
      city: 'Town',
      state: 'ST',
      country: 'US',
      preferredMarket: 'Town',
      consentAcknowledged: true,
    },
  });
  await prisma.franchiseInquiryNote.create({
    data: {
      id: i('inquiry-note'),
      tenantId,
      franchiseInquiryId: i('inquiry'),
      authorInternalUserId: i('staff'),
      body: 'Fictional note',
    },
  });
  await prisma.mediaAsset.create({
    data: {
      id: i('media'),
      tenantId,
      objectKey: i('media'),
      fileName: 'latte.png',
      contentType: 'image/png',
      fileSizeBytes: 1,
      uploadedByInternalUserId: i('staff'),
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

// Who holds what: every grant with its business, user, role and scope.
async function grants(url: string): Promise<string> {
  return withScratchClient(url, async (client) => {
    const { rows } = await client.query<{ s: string }>(
      `SELECT coalesce(string_agg(concat_ws(':', "tenantId", "internalUserId", "roleId", "scopeType", "scopeId"), ',' ORDER BY id), '') AS s
         FROM "InternalUserRoleAssignment"`,
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
  child === 'InternalRolePermission'
    ? `"roleId" = '${id(tag, 'role')}' AND "permissionKey" = 'orders.view'`
    : `id = '${id(tag, row)}'`;

// A copy of the child row with a new id and the referencing column set to
// `parentId` — a direct-SQL INSERT whose only possible failure is the
// foreign key under test.
const insertCopy = (r: Relationship, from: Tag, parentId: string) => {
  const overrides: Record<string, string> = {
    id: `copy-${from}-${r.childRow}`,
    [r.column]: parentId,
  };
  for (const [column, value] of Object.entries(r.copy ?? {})) {
    overrides[column] = `${value}-${from}`;
  }
  return `INSERT INTO "${r.child}"
    SELECT (jsonb_populate_record(NULL::"${r.child}", to_jsonb(t) || '${JSON.stringify(overrides)}'::jsonb)).*
      FROM "${r.child}" t WHERE ${rowWhere(r.child, r.childRow, from)}`;
};

// Per newly protected table: a move to business `y` the foreign keys alone
// would allow (every enforced reference re-pointed to `y`), so only the
// ownership trigger stands in its way.
const MOVES: Record<string, (x: Tag, y: Tag) => string> = {
  ApprovalRequest: (x, y) =>
    `UPDATE "ApprovalRequest" SET "tenantId" = '${TENANTS[y]}', "requestedByInternalUserId" = '${id(y, 'staff')}', "decidedByInternalUserId" = '${id(y, 'staff-2')}' WHERE id = '${id(x, 'approval')}'`,
  ChecklistInstanceItem: (x, y) =>
    `UPDATE "ChecklistInstanceItem" SET "tenantId" = '${TENANTS[y]}', "checklistInstanceId" = '${id(y, 'instance')}', "completedByInternalUserId" = '${id(y, 'staff')}', "exceptionByInternalUserId" = '${id(y, 'staff-2')}' WHERE id = '${id(x, 'item')}'`,
  FranchiseInquiryNote: (x, y) =>
    `UPDATE "FranchiseInquiryNote" SET "tenantId" = '${TENANTS[y]}', "franchiseInquiryId" = '${id(y, 'inquiry')}', "authorInternalUserId" = '${id(y, 'staff')}' WHERE id = '${id(x, 'inquiry-note')}'`,
  InternalAuditEvent: (x, y) =>
    `UPDATE "InternalAuditEvent" SET "tenantId" = '${TENANTS[y]}', "actorInternalUserId" = '${id(y, 'staff')}' WHERE id = '${id(x, 'audit')}'`,
  InternalRole: (x, y) =>
    `UPDATE "InternalRole" SET "tenantId" = '${TENANTS[y]}' WHERE id = '${id(x, 'role-spare')}'`,
  InternalRolePermission: (x, y) =>
    `UPDATE "InternalRolePermission" SET "tenantId" = '${TENANTS[y]}', "roleId" = '${id(y, 'role-spare')}' WHERE ${rowWhere('InternalRolePermission', 'permission', x)}`,
  InternalUser: (x, y) =>
    `UPDATE "InternalUser" SET "tenantId" = '${TENANTS[y]}' WHERE id = '${id(x, 'staff-spare')}'`,
  InternalUserRoleAssignment: (x, y) =>
    `UPDATE "InternalUserRoleAssignment" SET "tenantId" = '${TENANTS[y]}', "internalUserId" = '${id(y, 'staff-spare')}', "roleId" = '${id(y, 'role-spare')}', "scopeId" = '${id(y, 'location-spare')}' WHERE id = '${id(x, 'grant-loc')}'`,
  JobApplicationNote: (x, y) =>
    `UPDATE "JobApplicationNote" SET "tenantId" = '${TENANTS[y]}', "jobApplicationId" = '${id(y, 'app')}', "authorInternalUserId" = '${id(y, 'staff')}' WHERE id = '${id(x, 'app-note')}'`,
  MediaAsset: (x, y) =>
    `UPDATE "MediaAsset" SET "tenantId" = '${TENANTS[y]}', "uploadedByInternalUserId" = '${id(y, 'staff')}' WHERE id = '${id(x, 'media')}'`,
  OperationsTask: (x, y) =>
    `UPDATE "OperationsTask" SET "tenantId" = '${TENANTS[y]}', "locationId" = '${id(y, 'location')}', "createdByInternalUserId" = '${id(y, 'staff')}', "completedByInternalUserId" = '${id(y, 'staff-2')}' WHERE id = '${id(x, 'task')}'`,
};

describe('Tenant-enforced staff authorization (Security 4C-5)', () => {
  it('the inventory marks exactly these seventeen relationships as tenant-enforced, with matching delete rules; scopeId is no longer polymorphic', () => {
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
        (r) => r.kind === 'polymorphic' && r.id.startsWith('InternalUser'),
      ),
    ).toEqual([]);
    // No other reference to a staff user, role or permission set remains
    // outside the tenant-enforced set.
    expect(
      TENANT_RELATIONSHIPS.filter(
        (r): r is DirectReference =>
          r.kind === 'composite-fk-candidate' &&
          ['InternalUser', 'InternalRole'].includes(r.target) &&
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
    // No single-column relation to a staff user or role is left anywhere.
    expect(
      schema.match(
        /^\s+\w+\s+Internal(User|Role)\??\s+@relation\((?:"\w+", )?fields: \[(?!tenantId, )/gm,
      ),
    ).toBeNull();
  });

  it('the migration is ONE DO block: version and 4C-3 checks, read-only preflight of every relationship, scope shape and duplicate grant, lock_timeout, then the keys, CHECK, index and triggers', () => {
    expect(targetIndex).toBeGreaterThan(0);
    expect(migrations[targetIndex - 1].name).toBe(PREVIOUS);
    // Security 4C-6 is the only migration after it (its rollback must come
    // first; see the rollback tests).
    expect(migrations[targetIndex + 1]?.name).toBe(
      '20261015090000_tenant_fk_catalog_offers_snapshots',
    );
    const sql = target.sql;
    expect(isAppliedAtomically(sql)).toBe(true);
    const code = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .trim();
    expect(code).toMatch(
      /^DO \$tenant_fk_staff_authorization\$[\s\S]*\$tenant_fk_staff_authorization\$;$/,
    );
    const order = [
      "set_config('lock_timeout', '5s', true)",
      "current_setting('server_version_num')::int < 150000",
      "to_regprocedure('public.reject_tenant_reassignment()') IS NULL",
      ...RELATIONSHIPS.map(
        (r) => `('${r.child}', '${r.column}', '${r.parent}')`,
      ),
      'scope shape',
      'HAVING count(*) > 1',
      'Security 4C-5 aborted',
      'DROP CONSTRAINT',
      'ADD CONSTRAINT "InternalRolePermission_tenantId_roleId_fkey"',
      'ADD CONSTRAINT "InternalUserRoleAssignment_scope_shape_check"',
      'CREATE UNIQUE INDEX "InternalUserRoleAssignment_corporate_grant_key"',
      'CREATE TRIGGER',
    ].map((s) => code.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    for (const r of RELATIONSHIPS) {
      expect(code).toContain(
        `ADD CONSTRAINT "${constraintName(r)}" FOREIGN KEY ("tenantId", "${r.column}") REFERENCES "${r.parent}"("tenantId", "id") ON DELETE ${r.onDelete} ON UPDATE RESTRICT;`,
      );
    }
    expect(code.match(/ADD CONSTRAINT "\w+_fkey"/g)).toHaveLength(17);
    expect(code.match(/DROP CONSTRAINT/g)).toHaveLength(16);
    for (const t of NEW_PROTECTED) {
      expect(code).toContain(
        `CREATE TRIGGER "${t}_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "${t}"`,
      );
    }
    expect(code.match(/CREATE TRIGGER/g)).toHaveLength(11);
    // It reuses 4C-3's function and never creates or drops one, and it
    // never repairs, merges, revokes or reassigns data.
    expect(code).not.toMatch(/(CREATE|DROP) FUNCTION/);
    expect(code).not.toMatch(
      /\bUPDATE\s+"|\bDELETE\s+FROM\b|\bINSERT\s+INTO\b|\bTRUNCATE\b/i,
    );
  });

  it('the rollback is ONE DO block that removes only what 4C-5 added and restores the sixteen original keys — keeping 4C-3’s function', () => {
    expect(isAppliedAtomically(rollbackSql)).toBe(true);
    expect(rollbackSql.match(/DROP TRIGGER/g)).toHaveLength(11);
    for (const t of NEW_PROTECTED) {
      expect(rollbackSql).toContain(
        `DROP TRIGGER "${t}_tenantId_immutable" ON "${t}";`,
      );
    }
    for (const r of RELATIONSHIPS) {
      expect(rollbackSql).toContain(`DROP CONSTRAINT "${constraintName(r)}"`);
    }
    expect(rollbackSql).toContain(
      'DROP INDEX "InternalUserRoleAssignment_corporate_grant_key";',
    );
    expect(rollbackSql).toContain(
      'DROP CONSTRAINT "InternalUserRoleAssignment_scope_shape_check";',
    );
    expect(rollbackSql.match(/ADD CONSTRAINT "\w+_fkey"/g)).toHaveLength(16);
    expect(rollbackSql).not.toMatch(/FUNCTION/);
    expect(rollbackSql).not.toMatch(
      /\bUPDATE\s+"|\bDELETE\s+FROM\b|\bINSERT\s+INTO\b|\bTRUNCATE\b/i,
    );
  });

  it('the migrated test database enforces every relationship, ownership, scope shape and single CORPORATE grant (catalog regression guard)', async () => {
    expect(
      await withScratchClient(baseUrl, (client) => tenantEnforcement(client)),
    ).toEqual(EXPECTED_ENFORCEMENT);
  });

  describe('on a scratch database with three fictional businesses', () => {
    let scratch: ScratchDatabase;
    let prisma: PrismaClient;
    let beforeData: string;
    const sql = <T>(fn: (client: Client) => Promise<T>) =>
      withScratchClient(scratch.url, fn);

    beforeAll(async () => {
      scratch = await createScratchDatabase(baseUrl, 'fk_staff');
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

    it('carries exactly the expected keys, triggers, CHECK and index', async () => {
      expect(await sql(tenantEnforcement)).toEqual(EXPECTED_ENFORCEMENT);
    });

    it('accepts same-business references, by UPDATE and by INSERT, for every relationship and business', async () => {
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const r of RELATIONSHIPS) {
          for (const x of TAGS) {
            const parent = id(x, r.spareParent);
            out.push(
              `${relationshipId(r)} ${x} update ${await attempt(
                client,
                `UPDATE "${r.child}" SET "${r.column}" = '${parent}' WHERE ${rowWhere(r.child, r.childRow, x)}`,
              )}`,
              `${relationshipId(r)} ${x} insert ${await attempt(client, insertCopy(r, x, parent))}`,
            );
          }
        }
        return out;
      });
      expect(results.filter((s) => !s.endsWith(' ok'))).toEqual([]);
      expect(results).toHaveLength(17 * 3 * 2);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('rejects every cross-business reference by direct SQL — every relationship, every ordered pair, UPDATE and INSERT', async () => {
      const results = await sql(async (client) => {
        const out: Record<string, string> = {};
        for (const r of RELATIONSHIPS) {
          for (const [x, y] of PAIRS) {
            const foreign = id(y, r.spareParent);
            out[`${relationshipId(r)} ${x}->${y} update`] = await attempt(
              client,
              `UPDATE "${r.child}" SET "${r.column}" = '${foreign}' WHERE ${rowWhere(r.child, r.childRow, x)}`,
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
      expect(Object.keys(results)).toHaveLength(17 * 6 * 2);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('rejects a reference to a staff user, role or location that does not exist', async () => {
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const r of RELATIONSHIPS) {
          out.push(
            `${relationshipId(r)} ${await attempt(
              client,
              `UPDATE "${r.child}" SET "${r.column}" = 'sa-missing' WHERE ${rowWhere(r.child, r.childRow, 'a')}`,
            )}`,
          );
        }
        return out;
      });
      expect(results).toEqual(
        RELATIONSHIPS.map(
          (r) => `${relationshipId(r)} 23503 ${constraintName(r)}`,
        ),
      );
    });

    it('optional staff references may be cleared; required ones may not', async () => {
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const r of RELATIONSHIPS) {
          if (r.column === 'scopeId') continue; // the scope CHECK, below
          out.push(
            `${relationshipId(r)} ${await attempt(
              client,
              `UPDATE "${r.child}" SET "${r.column}" = NULL WHERE ${rowWhere(r.child, r.childRow, 'b')}`,
            )}`,
          );
        }
        return out;
      });
      expect(results).toEqual(
        RELATIONSHIPS.filter((r) => r.column !== 'scopeId').map(
          (r) => `${relationshipId(r)} ${r.optional ? 'ok' : '23502'}`,
        ),
      );
    });

    it('a grant’s scope shape is enforced: CORPORATE never carries a location, LOCATION always names one', async () => {
      const assignment = (tag: Tag, name: string) =>
        `UPDATE "InternalUserRoleAssignment" SET %s WHERE id = '${id(tag, name)}'`;
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const x of TAGS) {
          for (const set of [
            `"scopeId" = '${id(x, 'location')}'`,
            `"scopeType" = 'LOCATION'`,
          ]) {
            out.push(
              await attempt(
                client,
                assignment(x, 'grant-corp').replace('%s', set),
              ),
            );
          }
          for (const set of [`"scopeId" = NULL`, `"scopeType" = 'CORPORATE'`]) {
            out.push(
              await attempt(
                client,
                assignment(x, 'grant-loc').replace('%s', set),
              ),
            );
          }
          // A consistent change of both is fine.
          out.push(
            await attempt(
              client,
              assignment(x, 'grant-loc').replace(
                '%s',
                `"scopeType" = 'CORPORATE', "scopeId" = NULL, "roleId" = '${id(x, 'role-2')}'`,
              ),
            ),
          );
        }
        return out;
      });
      const check = '23514 InternalUserRoleAssignment_scope_shape_check';
      expect(results).toEqual(
        TAGS.flatMap(() => [check, check, check, check, 'ok']),
      );
    });

    it('a user can hold the same CORPORATE grant only once (and the same LOCATION grant once per location)', async () => {
      const results = await sql(async (client) => {
        const out: string[] = [];
        for (const x of TAGS) {
          out.push(
            await attempt(
              client,
              `INSERT INTO "InternalUserRoleAssignment" ("id", "tenantId", "internalUserId", "roleId", "scopeType", "scopeId", "updatedAt")
               VALUES ('dup-${x}', '${TENANTS[x]}', '${id(x, 'staff')}', '${id(x, 'role')}', 'CORPORATE', NULL, now())`,
            ),
            await attempt(
              client,
              `INSERT INTO "InternalUserRoleAssignment" ("id", "tenantId", "internalUserId", "roleId", "scopeType", "scopeId", "updatedAt")
               VALUES ('dup-${x}', '${TENANTS[x]}', '${id(x, 'staff')}', '${id(x, 'role')}', 'LOCATION', '${id(x, 'location-2')}', now())`,
            ),
            // A different role, or another location, is a different grant.
            await attempt(
              client,
              `INSERT INTO "InternalUserRoleAssignment" ("id", "tenantId", "internalUserId", "roleId", "scopeType", "scopeId", "updatedAt")
               VALUES ('dup-${x}', '${TENANTS[x]}', '${id(x, 'staff')}', '${id(x, 'role-2')}', 'CORPORATE', NULL, now())`,
            ),
            await attempt(
              client,
              `INSERT INTO "InternalUserRoleAssignment" ("id", "tenantId", "internalUserId", "roleId", "scopeType", "scopeId", "updatedAt")
               VALUES ('dup-${x}', '${TENANTS[x]}', '${id(x, 'staff')}', '${id(x, 'role')}', 'LOCATION', '${id(x, 'location')}', now())`,
            ),
          );
        }
        return out;
      });
      expect(results).toEqual(
        TAGS.flatMap(() => [
          '23505 InternalUserRoleAssignment_corporate_grant_key',
          // The existing unique key (PostgreSQL truncates its long name).
          '23505 InternalUserRoleAssignment_internalUserId_roleId_scopeType__key',
          'ok',
          'ok',
        ]),
      );
    });

    it('rejects moving any row of the fourteen protected tables to another business (immutable tenantId), referenced or not', async () => {
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
      expect(Object.keys(results)).toHaveLength(14 * 6);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('cross-business Prisma writes cannot grant a foreign role or location, steal a grant, permission or staff record, or attribute work to another business’s staff', async () => {
      const outcomes: Record<string, string> = {};
      for (const [x, y] of PAIRS) {
        const X = (n: string) => id(x, n);
        const Y = (n: string) => id(y, n);
        const writes: Record<string, () => Promise<unknown>> = {
          // Onboarding / role change shapes.
          nestedGrantForeignRole: () =>
            prisma.internalUser.update({
              where: { id: X('staff-2') },
              data: {
                roleAssignments: {
                  create: { roleId: Y('role'), scopeType: 'CORPORATE' },
                },
              },
            }),
          nestedGrantForeignLocation: () =>
            prisma.internalUser.update({
              where: { id: X('staff-2') },
              data: {
                roleAssignments: {
                  create: {
                    roleId: X('role'),
                    scopeType: 'LOCATION',
                    scopeId: Y('location-spare'),
                  },
                },
              },
            }),
          nestedRoleGrantForeignUser: () =>
            prisma.internalRole.update({
              where: { id: X('role-spare') },
              data: {
                assignments: {
                  create: {
                    internalUserId: Y('staff-2'),
                    scopeType: 'CORPORATE',
                  },
                },
              },
            }),
          nestedLocationGrantForeignUser: () =>
            prisma.location.update({
              where: { id: X('location-spare') },
              data: {
                staffRoleAssignments: {
                  create: {
                    internalUserId: Y('staff-2'),
                    roleId: Y('role'),
                    scopeType: 'LOCATION',
                  },
                },
              },
            }),
          grantConnectForeignRole: () =>
            prisma.internalUserRoleAssignment.update({
              where: { id: X('grant-corp') },
              data: { role: { connect: { id: Y('role-spare') } } },
            }),
          grantConnectForeignLocation: () =>
            prisma.internalUserRoleAssignment.update({
              where: { id: X('grant-loc') },
              data: { location: { connect: { id: Y('location-spare') } } },
            }),
          grantConnectForeignUser: () =>
            prisma.internalUserRoleAssignment.update({
              where: { id: X('grant-corp') },
              data: { internalUser: { connect: { id: Y('staff-spare') } } },
            }),
          grantUncheckedForeignRole: () =>
            prisma.internalUserRoleAssignment.update({
              where: { id: X('grant-corp') },
              data: { roleId: Y('role-spare') },
            }),
          grantUncheckedForeignLocation: () =>
            prisma.internalUserRoleAssignment.update({
              where: { id: X('grant-loc') },
              data: { scopeId: Y('location-spare') },
            }),
          grantUpsertForeignRole: () =>
            prisma.internalUserRoleAssignment.upsert({
              where: { id: X('grant-corp') },
              create: {
                tenantId: TENANTS[x],
                internalUserId: X('staff'),
                roleId: X('role'),
                scopeType: 'CORPORATE',
              },
              update: { role: { connect: { id: Y('role-spare') } } },
            }),
          grantUpdateManyMove: () =>
            prisma.internalUserRoleAssignment.updateMany({
              where: { id: X('grant-corp') },
              data: { tenantId: TENANTS[y] },
            }),
          // Stealing an existing grant, permission or staff record.
          userStealsGrant: () =>
            prisma.internalUser.update({
              where: { id: X('staff-spare') },
              data: { roleAssignments: { connect: { id: Y('grant-corp') } } },
            }),
          userStealsGrantConnectOrCreate: () =>
            prisma.internalUser.update({
              where: { id: X('staff-spare') },
              data: {
                roleAssignments: {
                  connectOrCreate: {
                    where: { id: Y('grant-corp') },
                    create: { roleId: X('role-spare'), scopeType: 'CORPORATE' },
                  },
                },
              },
            }),
          roleStealsGrant: () =>
            prisma.internalRole.update({
              where: { id: X('role-spare') },
              data: { assignments: { connect: { id: Y('grant-corp') } } },
            }),
          locationStealsGrant: () =>
            prisma.location.update({
              where: { id: X('location-spare') },
              data: {
                staffRoleAssignments: { connect: { id: Y('grant-loc') } },
              },
            }),
          roleStealsPermission: () =>
            prisma.internalRole.update({
              where: { id: X('role-spare') },
              data: {
                permissions: {
                  connect: {
                    roleId_permissionKey: {
                      roleId: Y('role'),
                      permissionKey: 'orders.view',
                    },
                  },
                },
              },
            }),
          permissionUpdateManyMove: () =>
            prisma.internalRolePermission.updateMany({
              where: { roleId: X('role') },
              data: { tenantId: TENANTS[y], roleId: Y('role-spare') },
            }),
          userMove: () =>
            prisma.internalUser.updateMany({
              where: { id: X('staff-spare') },
              data: { tenantId: TENANTS[y] },
            }),
          roleMove: () =>
            prisma.internalRole.updateMany({
              where: { id: X('role-spare') },
              data: { tenantId: TENANTS[y] },
            }),
          // Staff-actor associations.
          auditActorForeign: () =>
            prisma.internalAuditEvent.update({
              where: { id: X('audit') },
              data: { actorInternalUser: { connect: { id: Y('staff') } } },
            }),
          userStealsAudit: () =>
            prisma.internalUser.update({
              where: { id: X('staff-spare') },
              data: { auditEventsActed: { connect: { id: Y('audit') } } },
            }),
          approvalDeciderForeign: () =>
            prisma.approvalRequest.update({
              where: { id: X('approval') },
              data: { decidedByInternalUser: { connect: { id: Y('staff') } } },
            }),
          approvalRequesterUnchecked: () =>
            prisma.approvalRequest.update({
              where: { id: X('approval') },
              data: { requestedByInternalUserId: Y('staff') },
            }),
          checklistCompleterSet: () =>
            prisma.internalUser.update({
              where: { id: X('staff-spare') },
              data: { checklistItemsCompleted: { set: [{ id: Y('item') }] } },
            }),
          checklistExceptionForeign: () =>
            prisma.checklistInstanceItem.update({
              where: { id: Y('item') },
              data: { exceptionBy: { connect: { id: X('staff') } } },
            }),
          taskCreatorForeign: () =>
            prisma.operationsTask.update({
              where: { id: X('task') },
              data: { createdBy: { connect: { id: Y('staff') } } },
            }),
          taskCompleterUnchecked: () =>
            prisma.operationsTask.update({
              where: { id: X('task') },
              data: { completedByInternalUserId: Y('staff') },
            }),
          customerNoteAuthorForeign: () =>
            prisma.customerNote.update({
              where: { id: X('note') },
              data: { authorInternalUser: { connect: { id: Y('staff') } } },
            }),
          nestedNoteForeignCustomer: () =>
            prisma.internalUser.update({
              where: { id: Y('staff') },
              data: {
                customerNotesAuthored: {
                  create: { customerId: X('customer'), body: 'x' },
                },
              },
            }),
          jobNoteAuthorForeign: () =>
            prisma.jobApplicationNote.update({
              where: { id: X('app-note') },
              data: { authorInternalUser: { connect: { id: Y('staff') } } },
            }),
          inquiryNoteAuthorUnchecked: () =>
            prisma.franchiseInquiryNote.update({
              where: { id: X('inquiry-note') },
              data: { authorInternalUserId: Y('staff') },
            }),
          mediaUploaderForeign: () =>
            prisma.mediaAsset.update({
              where: { id: X('media') },
              data: { uploadedByInternalUser: { connect: { id: Y('staff') } } },
            }),
          ledgerActorUnchecked: () =>
            prisma.mochaBeanLedgerEntry.update({
              where: { id: X('ledger') },
              data: { actorInternalUserId: Y('staff') },
            }),
          giftCardActorForeign: () =>
            prisma.giftCardTransaction.update({
              where: { id: X('gc-tx') },
              data: { actorInternalUser: { connect: { id: Y('staff') } } },
            }),
          userStealsLedgerEntry: () =>
            prisma.internalUser.update({
              where: { id: X('staff-spare') },
              data: { mochaBeanAdjustments: { connect: { id: Y('ledger') } } },
            }),
        };
        for (const [name, write] of Object.entries(writes)) {
          outcomes[`${name} ${x}->${y}`] = await prismaOutcome(write());
        }
      }
      // Every shape is refused — by the composite foreign key (P2003 /
      // 23503) or, where Prisma would re-point the row's own tenantId, by
      // the immutable tenantId (P2039 / 23001).
      expect(
        Object.entries(outcomes).filter(
          ([, o]) => !['P2003/23503', 'P2039/23001'].includes(o),
        ),
      ).toEqual([]);
      expect(Object.keys(outcomes)).toHaveLength(35 * 6);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('same-business staff and authorization writes keep working (onboarding, role change, location grant, revocation, staff actors)', async () => {
      const rollback = new Error('rollback');
      await prisma
        .$transaction(async (tx) => {
          for (const x of TAGS) {
            const X = (n: string) => id(x, n);
            const tenantId = TENANTS[x];
            // Onboarding: a new user with a CORPORATE and a LOCATION grant.
            const user = await tx.internalUser.create({
              data: {
                tenantId,
                externalProvider: 'dev',
                externalSubject: `sa-new-${x}`,
                email: `sa-new-${x}@example.test`,
                roleAssignments: {
                  create: [
                    { roleId: X('role'), scopeType: 'CORPORATE' },
                    {
                      roleId: X('role-2'),
                      scopeType: 'LOCATION',
                      scopeId: X('location-spare'),
                    },
                  ],
                },
              },
              include: { roleAssignments: true },
            });
            expect(user.roleAssignments.map((g) => g.tenantId)).toEqual([
              tenantId,
              tenantId,
            ]);
            // A new role with its permissions.
            await tx.internalRole.create({
              data: {
                tenantId,
                key: `sa-new-role-${x}`,
                displayName: 'New',
                permissions: { create: [{ permissionKey: 'orders.view' }] },
              },
            });
            // Role change and location change on an existing grant.
            await tx.internalUserRoleAssignment.update({
              where: { id: X('grant-loc') },
              data: {
                role: { connect: { id: X('role-2') } },
                location: { connect: { id: X('location-spare') } },
              },
            });
            // Revocation of one grant leaves the other.
            await tx.internalUserRoleAssignment.delete({
              where: { id: X('grant-corp') },
            });
            expect(
              await tx.internalUserRoleAssignment.count({
                where: { internalUserId: X('staff') },
              }),
            ).toBe(1);
            // Staff actors of the same business.
            await tx.customerNote.update({
              where: { id: X('note') },
              data: { authorInternalUser: { connect: { id: X('staff-2') } } },
            });
            await tx.internalUser.update({
              where: { id: X('staff-spare') },
              data: { checklistItemsCompleted: { set: [{ id: X('item') }] } },
            });
            // Clearing an optional staff actor: by its column, as the
            // application does (see the next test for `disconnect`).
            await tx.operationsTask.update({
              where: { id: X('task') },
              data: { completedByInternalUserId: null },
            });
            await tx.mochaBeanLedgerEntry.update({
              where: { id: X('ledger') },
              data: { actorInternalUserId: X('staff-2') },
            });
          }
          throw rollback;
        })
        .catch((e: unknown) => {
          if (e !== rollback) throw e;
        });
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('Prisma `disconnect` of an optional staff relation is refused (it would clear the row’s tenantId too) — clearing the column works, and the application only does that', async () => {
      const outcomes = [
        await prismaOutcome(
          prisma.operationsTask.update({
            where: { id: id('a', 'task') },
            data: { completedBy: { disconnect: true } },
          }),
        ),
        await prismaOutcome(
          prisma.checklistInstanceItem.update({
            where: { id: id('b', 'item') },
            data: { exceptionBy: { disconnect: true } },
          }),
        ),
        await prismaOutcome(
          prisma.internalUserRoleAssignment.update({
            where: { id: id('c', 'grant-loc') },
            data: { location: { disconnect: true } },
          }),
        ),
      ];
      expect(outcomes).toEqual(['P2039/23001', 'P2039/23001', 'P2039/23001']);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
      // Tripwire: the only `disconnect` calls in application code are on
      // relations that are not (yet) tenant-enforced composite keys.
      const sources = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory()
            ? sources(join(dir, e.name))
            : e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')
              ? [join(dir, e.name)]
              : [],
        );
      const disconnects = ['apps/api/src', 'apps/worker/src']
        .flatMap((d) => sources(join(repoRoot, d)))
        .flatMap((file) =>
          readFileSync(file, 'utf8')
            .split('\n')
            .filter((line) => /disconnect:\s*true/.test(line))
            .map(() => file.slice(repoRoot.length + 1)),
        );
      // Since Security 4C-7 every relation between business records is
      // composite, so application code may use none.
      expect(disconnects.sort()).toEqual([]);
    });

    it('the integrity checker reports CLEAN with zero unchecked rows', async () => {
      const report = await sql((client) => checkTenantIntegrity(client));
      expect([report.verdict, report.violations, report.uncheckedRows]).toEqual(
        ['clean', 0, 0],
      );
    });

    it('deliberately removing ANY key, ownership trigger, the scope CHECK or the CORPORATE index is detected by the catalog guard, and lets the write it stopped through', async () => {
      type Mutation = { drop: string; missing: string; write: string };
      const mutations: Mutation[] = [
        ...RELATIONSHIPS.map((r) => ({
          drop: `ALTER TABLE "${r.child}" DROP CONSTRAINT "${constraintName(r)}"`,
          missing: EXPECTED_FOREIGN_KEYS.find((k) =>
            k.startsWith(`${constraintName(r)}:`),
          )!,
          write: `UPDATE "${r.child}" SET "${r.column}" = '${id('b', r.spareParent)}' WHERE ${rowWhere(r.child, r.childRow, 'a')}`,
        })),
        ...NEW_PROTECTED.map((t) => ({
          drop: `DROP TRIGGER "${t}_tenantId_immutable" ON "${t}"`,
          missing: immutabilityTrigger(t),
          write: MOVES[t]('a', 'b'),
        })),
        {
          drop: `ALTER TABLE "InternalUserRoleAssignment" DROP CONSTRAINT "InternalUserRoleAssignment_scope_shape_check"`,
          missing: SCOPE_CHECK,
          write: `UPDATE "InternalUserRoleAssignment" SET "scopeId" = '${id('a', 'location')}' WHERE id = '${id('a', 'grant-corp')}'`,
        },
        {
          drop: `DROP INDEX "InternalUserRoleAssignment_corporate_grant_key"`,
          missing: CORPORATE_INDEX,
          write: `INSERT INTO "InternalUserRoleAssignment" ("id", "tenantId", "internalUserId", "roleId", "scopeType", "scopeId", "updatedAt")
                  VALUES ('dup', '${TENANTS.a}', '${id('a', 'staff')}', '${id('a', 'role')}', 'CORPORATE', NULL, now())`,
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
        mutations.map((m, n) => ({
          missing: [m.missing],
          withIt:
            n < RELATIONSHIPS.length
              ? '23503'
              : n < RELATIONSHIPS.length + NEW_PROTECTED.length
                ? '23001'
                : n === mutations.length - 2
                  ? '23514'
                  : '23505',
          without: 'ok',
        })),
      );
      expect(mutations).toHaveLength(17 + 11 + 2);
      expect(await sql(tenantEnforcement)).toEqual(EXPECTED_ENFORCEMENT);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });
  });

  // Delete behaviour is compared against a database migrated to just
  // before 4C-5 holding the identical fictional rows.
  describe('deletion behaviour is unchanged', () => {
    let before: ScratchDatabase;
    let after: ScratchDatabase;
    const deletes: Record<string, string> = {
      'staff with history (Restrict)': `DELETE FROM "InternalUser" WHERE id = '${id('a', 'staff')}'`,
      'staff with only grants (grants cascade)': `DELETE FROM "InternalUser" WHERE id = '${id('a', 'staff-3')}'`,
      'staff with nothing': `DELETE FROM "InternalUser" WHERE id = '${id('a', 'staff-spare')}'`,
      'role in use (Restrict)': `DELETE FROM "InternalRole" WHERE id = '${id('a', 'role')}'`,
      'unused role (permissions cascade)': `DELETE FROM "InternalRole" WHERE id = '${id('b', 'role-2')}'`,
      'one grant (revocation)': `DELETE FROM "InternalUserRoleAssignment" WHERE id = '${id('c', 'grant-corp')}'`,
      'customer (notes cascade)': `DELETE FROM "Customer" WHERE id = '${id('b', 'customer')}'`,
      'job application (notes cascade)': `DELETE FROM "JobApplication" WHERE id = '${id('a', 'app')}'`,
      'franchise inquiry (notes cascade)': `DELETE FROM "FranchiseInquiry" WHERE id = '${id('c', 'inquiry')}'`,
      'checklist instance (items cascade)': `DELETE FROM "ChecklistInstance" WHERE id = '${id('a', 'instance')}'`,
      'unreferenced location': `DELETE FROM "Location" WHERE id = '${id('a', 'location-spare')}'`,
    };
    const counts = `SELECT concat_ws(',',
        (SELECT count(*) FROM "InternalUser"), (SELECT count(*) FROM "InternalRole"),
        (SELECT count(*) FROM "InternalRolePermission"), (SELECT count(*) FROM "InternalUserRoleAssignment"),
        (SELECT count(*) FROM "CustomerNote"), (SELECT count(*) FROM "JobApplicationNote"),
        (SELECT count(*) FROM "FranchiseInquiryNote"), (SELECT count(*) FROM "ChecklistInstanceItem"),
        (SELECT count(*) FROM "Location")) AS c`;
    const outcomes = (url: string, statements: Record<string, string>) =>
      withScratchClient(url, async (client) => {
        const out: Record<string, string> = {};
        for (const [name, statement] of Object.entries(statements)) {
          await client.query('BEGIN');
          try {
            await client.query(statement);
            const { rows } = await client.query<{ c: string }>(counts);
            out[name] = `ok ${rows[0].c}`;
          } catch (error) {
            out[name] = String((error as { code?: string }).code);
          } finally {
            await client.query('ROLLBACK');
          }
        }
        return out;
      });

    beforeAll(async () => {
      before = await createScratchDatabase(baseUrl, 'fk_staff_del_before');
      after = await createScratchDatabase(baseUrl, 'fk_staff_del_after');
      await applyMigrations(before.url, migrations.slice(0, targetIndex));
      await applyMigrations(after.url, migrations);
      await loadFixture(before.url);
      await loadFixture(after.url);
    });

    afterAll(async () => {
      await before?.drop();
      await after?.drop();
    });

    it('every delete has the same outcome before and after 4C-5', async () => {
      const was = await outcomes(before.url, deletes);
      const is = await outcomes(after.url, deletes);
      expect(is).toEqual(was);
      expect(is['staff with history (Restrict)']).toBe('23503');
      expect(is['role in use (Restrict)']).toBe('23503');
      expect(is['staff with only grants (grants cascade)']).toMatch(/^ok /);
      expect(is['unused role (permissions cascade)']).toMatch(/^ok /);
    });

    it('the one intended change: a location with a LOCATION grant can no longer be deleted out from under it (was: the grant was left dangling)', async () => {
      const statement = {
        location: `DELETE FROM "Location" WHERE id = '${id('a', 'location-2')}'`,
      };
      expect((await outcomes(before.url, statement)).location).toMatch(/^ok /);
      expect((await outcomes(after.url, statement)).location).toBe('23503');
    });
  });

  // The application's own staff-authorization paths, against the
  // configured test database (migrated by CI), with three businesses.
  describe('application authorization paths stay tenant-safe', () => {
    let moduleRef: TestingModule;
    let prisma: PrismaService;
    let users: AdminInternalUsersService;
    let authorization: AuthorizationService;
    let notes: CustomerNotesService;
    const suffix = randomUUID().slice(0, 8);
    const originalEnv = { ...process.env };
    const tenant = {
      a: tenantContextFor(TENANTS.a),
      b: tenantContextFor(TENANTS.b),
      c: tenantContextFor(TENANTS.c),
    };
    const corporate = [{ scopeType: 'CORPORATE' as const, scopeId: null }];
    const admin = AuthorizationContext.of({
      'users.view': corporate,
      'users.manage_status': corporate,
      'users.manage_roles': corporate,
      'catalog.products.edit': corporate,
      'catalog.overrides.manage': corporate,
      'customers.view': corporate,
      'customers.notes.manage': corporate,
    });
    const created = {
      users: [] as string[],
      roles: [] as string[],
      locations: [] as string[],
      customers: [] as string[],
    };
    const ids = {} as Record<
      Tag,
      {
        actor: string;
        user: string;
        corpRole: string;
        locRole: string;
        location: string;
        customer: string;
      }
    >;

    beforeAll(async () => {
      process.env.NODE_ENV = 'development';
      process.env.AUTH_PROVIDER = 'dev';
      process.env.AUTH_DEV_JWT_SECRET = 'sec-4c5-customer-secret';
      process.env.INTERNAL_AUTH_PROVIDER = 'dev';
      process.env.INTERNAL_AUTH_DEV_JWT_SECRET = 'sec-4c5-internal-secret';
      process.env.GIFT_CARD_CODE_SECRET = 'sec-4c5-gift-card-code-secret';
      moduleRef = await Test.createTestingModule({
        imports: [
          PrismaModule,
          AuditModule,
          CustomerAuthModule,
          InternalAuthModule,
          CustomersModule,
          CrmModule,
        ],
        providers: [AdminInternalUsersService],
      }).compile();
      prisma = moduleRef.get(PrismaService);
      users = moduleRef.get(AdminInternalUsersService);
      authorization = moduleRef.get(AuthorizationService);
      notes = moduleRef.get(CustomerNotesService);
      await createTestTenantB(prisma);
      await createTestTenantC(prisma);
      for (const tag of TAGS) {
        const tenantId = TENANTS[tag];
        const user = async (label: string) => {
          const row = await prisma.internalUser.create({
            data: {
              tenantId,
              externalProvider: 'internal-dev',
              externalSubject: `internal-dev:sec4c5-${label}-${tag}-${suffix}`,
              email: `sec4c5-${label}-${tag}-${suffix}@example.com`,
              status: 'ACTIVE',
              activatedAt: new Date(),
            },
          });
          created.users.push(row.id);
          return row.id;
        };
        // A corporate-only and a location-only access level.
        const role = async (label: string, permissionKey: string) => {
          const row = await prisma.internalRole.create({
            data: {
              tenantId,
              key: `sec4c5-${label}-${tag}-${suffix}`,
              displayName: `Sec 4C-5 ${label} ${tag}`,
              permissions: { create: [{ permissionKey }] },
            },
          });
          created.roles.push(row.id);
          return row.id;
        };
        const location = await prisma.location.create({
          data: {
            tenantId,
            name: `Sec 4C-5 ${tag}`,
            slug: `sec4c5-${tag}-${suffix}`,
          },
        });
        created.locations.push(location.id);
        const customer = await prisma.customer.create({
          data: {
            tenantId,
            externalProvider: 'dev',
            externalSubject: `sec4c5-${tag}-${suffix}`,
          },
        });
        created.customers.push(customer.id);
        ids[tag] = {
          actor: await user('actor'),
          user: await user('user'),
          corpRole: await role('corp', 'catalog.products.edit'),
          locRole: await role('loc', 'catalog.overrides.manage'),
          location: location.id,
          customer: customer.id,
        };
      }
    });

    afterAll(async () => {
      try {
        await prisma.internalAuditEvent.deleteMany({
          where: { actorInternalUserId: { in: created.users } },
        });
        await prisma.customerNote.deleteMany({
          where: { customerId: { in: created.customers } },
        });
        await prisma.customer.deleteMany({
          where: { id: { in: created.customers } },
        });
        await prisma.internalUserRoleAssignment.deleteMany({
          where: { internalUserId: { in: created.users } },
        });
        await prisma.internalRole.deleteMany({
          where: { id: { in: created.roles } },
        });
        await prisma.internalUser.deleteMany({
          where: { id: { in: created.users } },
        });
        await prisma.location.deleteMany({
          where: { id: { in: created.locations } },
        });
        await removeTestTenantB(prisma);
        await removeTestTenantC(prisma);
      } finally {
        await moduleRef?.close();
        process.env = { ...originalEnv };
      }
    });

    const grantRows = (tag: Tag) =>
      prisma.internalUserRoleAssignment.findMany({
        where: { internalUserId: ids[tag].user },
        select: {
          tenantId: true,
          roleId: true,
          scopeType: true,
          scopeId: true,
        },
        orderBy: { id: 'asc' },
      });

    it('assigning another business’s role or location is refused exactly like a missing one — for every pair — and grants nothing', async () => {
      for (const [x, y] of PAIRS) {
        const before = await grantRows(x);
        await expect(
          users.assignRole(
            ids[x].user,
            {
              roleId: ids[y].corpRole,
              scope: { kind: 'corporate' },
              reason: 'r',
            },
            ids[x].actor,
            admin,
            tenant[x],
          ),
        ).rejects.toThrow(new NotFoundException('Access level not found.'));
        await expect(
          users.assignRole(
            ids[x].user,
            {
              roleId: ids[x].locRole,
              scope: { kind: 'locations', locationIds: [ids[y].location] },
              reason: 'r',
            },
            ids[x].actor,
            admin,
            tenant[x],
          ),
        ).rejects.toThrow(
          new BadRequestException(
            'One or more of the chosen locations no longer exists.',
          ),
        );
        // Another business's user is not found either.
        await expect(
          users.assignRole(
            ids[y].user,
            {
              roleId: ids[x].corpRole,
              scope: { kind: 'corporate' },
              reason: 'r',
            },
            ids[x].actor,
            admin,
            tenant[x],
          ),
        ).rejects.toThrow(new NotFoundException('Internal user not found.'));
        expect(await grantRows(x)).toEqual(before);
        expect(
          (await authorization.loadContext(ids[x].user, tenant[x])).has(
            'catalog.products.edit',
          ),
        ).toBe(before.length > 0);
      }
    });

    it('same-business onboarding, location grant, duplicate refusal and revocation work — and concurrent duplicate CORPORATE grants yield exactly one', async () => {
      for (const x of TAGS) {
        // Concurrent identical CORPORATE grants: one wins, never two.
        const raced = await Promise.allSettled(
          [1, 2, 3].map(() =>
            users.assignRole(
              ids[x].user,
              {
                roleId: ids[x].corpRole,
                scope: { kind: 'corporate' },
                reason: 'r',
              },
              ids[x].actor,
              admin,
              tenant[x],
            ),
          ),
        );
        expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        await expect(
          users.assignRole(
            ids[x].user,
            {
              roleId: ids[x].corpRole,
              scope: { kind: 'corporate' },
              reason: 'r',
            },
            ids[x].actor,
            admin,
            tenant[x],
          ),
        ).rejects.toThrow(
          new ConflictException('This person already has that access.'),
        );
        const detail = await users.assignRole(
          ids[x].user,
          {
            roleId: ids[x].locRole,
            scope: { kind: 'locations', locationIds: [ids[x].location] },
            reason: 'r',
          },
          ids[x].actor,
          admin,
          tenant[x],
        );
        expect(detail.assignments).toHaveLength(2);
        expect(await grantRows(x)).toEqual(
          expect.arrayContaining([
            {
              tenantId: TENANTS[x],
              roleId: ids[x].corpRole,
              scopeType: 'CORPORATE',
              scopeId: null,
            },
            {
              tenantId: TENANTS[x],
              roleId: ids[x].locRole,
              scopeType: 'LOCATION',
              scopeId: ids[x].location,
            },
          ]),
        );
        expect(
          (await authorization.loadContext(ids[x].user, tenant[x])).has(
            'catalog.products.edit',
          ),
        ).toBe(true);
      }
      // Revocation: another business cannot remove the grant; its owner can,
      // one grant at a time.
      for (const [x, y] of PAIRS) {
        const [grant] = await prisma.internalUserRoleAssignment.findMany({
          where: { internalUserId: ids[x].user, scopeType: 'CORPORATE' },
        });
        await expect(
          users.removeRoleAssignment(
            ids[x].user,
            grant.id,
            { reason: 'r' },
            ids[y].actor,
            admin,
            tenant[y],
          ),
        ).rejects.toThrow(NotFoundException);
        expect(
          await prisma.internalUserRoleAssignment.count({
            where: { id: grant.id },
          }),
        ).toBe(1);
      }
      for (const x of TAGS) {
        const [grant] = await prisma.internalUserRoleAssignment.findMany({
          where: { internalUserId: ids[x].user, scopeType: 'CORPORATE' },
        });
        const detail = await users.removeRoleAssignment(
          ids[x].user,
          grant.id,
          { reason: 'r' },
          ids[x].actor,
          admin,
          tenant[x],
        );
        expect(detail.assignments).toHaveLength(1);
      }
    });

    it('deactivation: another business cannot suspend a user; the owner can, without silently revoking or moving any grant', async () => {
      for (const [x, y] of PAIRS) {
        await expect(
          users.updateStatus(
            ids[x].user,
            { status: 'SUSPENDED', reason: 'r' },
            ids[y].actor,
            admin,
            tenant[y],
          ),
        ).rejects.toThrow(new NotFoundException('Internal user not found.'));
      }
      for (const x of TAGS) {
        const grantsBefore = await grantRows(x);
        await users.updateStatus(
          ids[x].user,
          { status: 'SUSPENDED', reason: 'r' },
          ids[x].actor,
          admin,
          tenant[x],
        );
        expect(await grantRows(x)).toEqual(grantsBefore);
        const audit = await prisma.internalAuditEvent.findFirstOrThrow({
          where: { action: 'user.status_changed', targetId: ids[x].user },
        });
        expect([audit.tenantId, audit.actorInternalUserId]).toEqual([
          TENANTS[x],
          ids[x].actor,
        ]);
      }
    });

    it('a staff actor of another business can never be recorded as a note’s author: the database refuses it and nothing is written', async () => {
      for (const [x, y] of PAIRS) {
        await expect(
          notes.addNote(
            ids[x].customer,
            'cross',
            ids[y].actor,
            admin,
            tenant[x],
          ),
        ).rejects.toMatchObject({ code: 'P2003' });
        expect(
          await prisma.customerNote.count({
            where: { customerId: ids[x].customer },
          }),
        ).toBe(0);
        expect(
          await prisma.internalAuditEvent.count({
            where: { targetType: 'customer', targetId: ids[x].customer },
          }),
        ).toBe(0);
      }
      for (const x of TAGS) {
        await notes.addNote(
          ids[x].customer,
          'own',
          ids[x].actor,
          admin,
          tenant[x],
        );
        const note = await prisma.customerNote.findFirstOrThrow({
          where: { customerId: ids[x].customer },
        });
        expect([note.tenantId, note.authorInternalUserId]).toEqual([
          TENANTS[x],
          ids[x].actor,
        ]);
      }
    });
  });

  // Real `prisma migrate deploy`, exactly as CI and every environment run
  // it, against newly created guarded scratch databases.
  describe('applied by real prisma migrate deploy', () => {
    const prisma = prismaCli(databaseDir);
    const projects: MigrationProject[] = [];
    const scratches: ScratchDatabase[] = [];
    const beforeNames = migrations.slice(0, targetIndex).map((m) => m.name);
    // Up to and including 4C-5: the rollback tests below start from 4C-5,
    // not from a later migration that depends on it (Security 4C-6).
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
    // A database at the migration before 4C-5, holding the fixture.
    const beforeFourC5 = async (label: string) => {
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

    it('succeeds on clean data: everything enforced, data and grants unchanged, no drift, integrity CLEAN', async () => {
      const scratch = await beforeFourC5('fk_staff_ok');
      const data = await dataChecksum(scratch.url);
      const held = await grants(scratch.url);
      const result = await prisma(scratch.url, ['migrate', 'deploy']);
      expect(result.code).toBe(0);
      expect(await migrationRow(scratch.url)).toEqual(['finished']);
      expect(await enforcement(scratch.url)).toEqual(EXPECTED_ENFORCEMENT);
      expect(await dataChecksum(scratch.url)).toBe(data);
      expect(await grants(scratch.url)).toBe(held);
      expect(await noDrift(scratch.url)).toBe(0);
      const report = await withScratchClient(scratch.url, (client) =>
        checkTenantIntegrity(client),
      );
      expect([report.verdict, report.violations, report.uncheckedRows]).toEqual(
        ['clean', 0, 0],
      );
    });

    it('mismatched rows — cross-business grant, role, location and actor, missing location, malformed scope, duplicate CORPORATE grant — abort it before any change, all listed; never repaired, revoked or reassigned; recovery only after an explicit fix', async () => {
      const scratch = await beforeFourC5('fk_staff_cross');
      // Legacy-style bad data the single-column keys (and no scope
      // constraint) allowed.
      await run(
        scratch.url,
        `UPDATE "InternalUserRoleAssignment" SET "roleId" = '${id('b', 'role-spare')}' WHERE id = '${id('a', 'grant-corp')}';
         UPDATE "InternalUserRoleAssignment" SET "scopeId" = '${id('c', 'location-spare')}' WHERE id = '${id('b', 'grant-loc')}';
         UPDATE "InternalUserRoleAssignment" SET "scopeId" = 'sa-deleted-location' WHERE id = '${id('c', 'grant-loc')}';
         UPDATE "InternalRolePermission" SET "roleId" = '${id('a', 'role-spare')}' WHERE "roleId" = '${id('c', 'role-2')}';
         UPDATE "InternalAuditEvent" SET "actorInternalUserId" = '${id('a', 'staff')}' WHERE id = '${id('b', 'audit')}';
         UPDATE "CustomerNote" SET "authorInternalUserId" = '${id('c', 'staff')}' WHERE id = '${id('a', 'note')}';
         UPDATE "InternalUserRoleAssignment" SET "scopeId" = '${id('a', 'location')}' WHERE id = '${id('a', 'grant-3')}';
         INSERT INTO "InternalUserRoleAssignment" ("id", "tenantId", "internalUserId", "roleId", "scopeType", "scopeId", "updatedAt")
           VALUES ('sa-dup-1', '${TENANTS.b}', '${id('b', 'staff')}', '${id('b', 'role')}', 'CORPORATE', NULL, now()),
                  ('sa-dup-2', '${TENANTS.b}', '${id('b', 'staff')}', '${id('b', 'role')}', 'CORPORATE', NULL, now());`,
      );
      const catalog = await databaseCatalog(scratch.url);
      const data = await dataChecksum(scratch.url);
      const held = await grants(scratch.url);

      const failed = await prisma(scratch.url, ['migrate', 'deploy']);
      expect(failed.code).not.toBe(0);
      expect(failed.out).toContain('P3018');
      expect(failed.out).toContain('Security 4C-5 aborted');
      for (const line of [
        'InternalRolePermission.roleId -> InternalRole: 1 row(s)',
        'InternalUserRoleAssignment.roleId -> InternalRole: 1 row(s)',
        'InternalUserRoleAssignment.scopeId -> Location: 2 row(s)',
        'InternalAuditEvent.actorInternalUserId -> InternalUser: 1 row(s)',
        'CustomerNote.authorInternalUserId -> InternalUser: 1 row(s)',
        'InternalUserRoleAssignment scope shape: 1 row(s)',
        'InternalUserRoleAssignment duplicate CORPORATE grants: 1 user/role pair(s)',
      ]) {
        expect(failed.out).toContain(line);
      }
      expect(failed.out).not.toContain(
        'InternalUserRoleAssignment.internalUserId',
      );
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);
      expect(await dataChecksum(scratch.url)).toBe(data);
      expect(await grants(scratch.url)).toBe(held);
      expect(await migrationRow(scratch.url)).toEqual(['unfinished']);

      const retried = await prisma(scratch.url, ['migrate', 'deploy']);
      expect(retried.out).toContain('P3009');
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);

      // Documented recovery: explicit, deliberate fixes of the reported
      // rows (here: restore the fixture's own references and remove the
      // planted duplicates), then resolve and deploy again.
      await run(
        scratch.url,
        `UPDATE "InternalUserRoleAssignment" SET "roleId" = '${id('a', 'role')}' WHERE id = '${id('a', 'grant-corp')}';
         UPDATE "InternalUserRoleAssignment" SET "scopeId" = '${id('b', 'location-2')}' WHERE id = '${id('b', 'grant-loc')}';
         UPDATE "InternalUserRoleAssignment" SET "scopeId" = '${id('c', 'location-2')}' WHERE id = '${id('c', 'grant-loc')}';
         UPDATE "InternalRolePermission" SET "roleId" = '${id('c', 'role-2')}' WHERE "roleId" = '${id('a', 'role-spare')}';
         UPDATE "InternalAuditEvent" SET "actorInternalUserId" = '${id('b', 'staff')}' WHERE id = '${id('b', 'audit')}';
         UPDATE "CustomerNote" SET "authorInternalUserId" = '${id('a', 'staff')}' WHERE id = '${id('a', 'note')}';
         UPDATE "InternalUserRoleAssignment" SET "scopeId" = NULL WHERE id = '${id('a', 'grant-3')}';
         DELETE FROM "InternalUserRoleAssignment" WHERE id IN ('sa-dup-1', 'sa-dup-2');`,
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

    it('refuses to run without Security 4C-3’s function, changing nothing', async () => {
      const scratch = await beforeFourC5('fk_staff_no43');
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
      const scratch = await beforeFourC5('fk_staff_late');
      // Occupy the name of the last trigger it creates.
      await run(
        scratch.url,
        `CREATE TRIGGER "OperationsTask_tenantId_immutable" BEFORE UPDATE ON "OperationsTask"
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
      const scratch = await beforeFourC5('fk_staff_lock');
      const catalog = await databaseCatalog(scratch.url);
      const held = await withScratchClient(scratch.url, async (client) => {
        await client.query('BEGIN');
        await client.query(
          `LOCK TABLE "InternalUserRoleAssignment" IN ROW EXCLUSIVE MODE`,
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

    it('while 4C-5 is applied, rolling back 4C-3 is refused atomically (its function is still in use) — even after 4C-4 is rolled back', async () => {
      const scratch = await beforeFourC5('fk_staff_order');
      expect(
        (
          await prisma(
            scratch.url,
            ['migrate', 'deploy'],
            project(throughNames),
          )
        ).code,
      ).toBe(0);
      const rollback4 = {
        name: '20261015090000_rollback_tenant_fk_loyalty_giftcard_promotion',
        sql: rollbackOf(PREVIOUS),
      };
      expect(
        (
          await prisma(
            scratch.url,
            ['migrate', 'deploy'],
            project(throughNames, rollback4),
          )
        ).code,
      ).toBe(0);
      const catalog = await databaseCatalog(scratch.url);
      const name = '20261015100000_rollback_tenant_fk_customer_order_payment';
      const failed = await prisma(
        scratch.url,
        ['migrate', 'deploy'],
        project(throughNames, [rollback4, { name, sql: rollbackOf(FOUR_C_3) }]),
      );
      expect(failed.code).not.toBe(0);
      expect(failed.out).toMatch(/depend/);
      expect(await databaseCatalog(scratch.url)).toEqual(catalog);
      expect(await migrationRow(scratch.url, name)).toEqual(['unfinished']);
    });

    it('the documented rollback — shipped as a new forward migration — restores the pre-4C-5 catalog exactly, keeps the data, and 4C-5 re-applies; then 4C-4 and 4C-3 roll back in order to the pre-4C-3 catalog', async () => {
      const scratch = await beforeFourC5('fk_staff_rollback');
      const data = await dataChecksum(scratch.url);
      expect(
        (
          await prisma(
            scratch.url,
            ['migrate', 'deploy'],
            project(throughNames),
          )
        ).code,
      ).toBe(0);
      const rollback = {
        name: '20261015090000_rollback_tenant_fk_staff_authorization',
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
      const reference = await fresh('fk_staff_rollback_ref');
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
        name: '20261015100000_reapply_tenant_fk_staff_authorization',
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

      // The full documented order on a second database: 4C-5, then 4C-4,
      // then 4C-3 — each shipped as a forward migration.
      const chain = await beforeFourC5('fk_staff_chain');
      const chainData = await dataChecksum(chain.url);
      expect(
        (await prisma(chain.url, ['migrate', 'deploy'], project(throughNames)))
          .code,
      ).toBe(0);
      const steps = [
        rollback,
        {
          name: '20261015110000_rollback_tenant_fk_loyalty_giftcard_promotion',
          sql: rollbackOf(PREVIOUS),
        },
        {
          name: '20261015120000_rollback_tenant_fk_customer_order_payment',
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
      const preFourC3 = await fresh('fk_staff_chain_ref');
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
