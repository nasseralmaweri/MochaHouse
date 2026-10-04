import 'dotenv/config';
import { join } from 'node:path';
import { MODEL_TENANCY, TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  TENANT_ID_REQUIRED_MODELS,
  applyMigrationSql,
  applyMigrations,
  createScratchDatabase,
  isAppliedAtomically,
  listMigrations,
  withScratchClient,
  type ScratchDatabase,
} from '@mocha-house/testing';

// Milestone S0D-2D — the guarded, parent-derived backfill + NOT NULL
// migration for JobOpening, JobApplication, JobApplicationNote,
// FranchiseInquiry and FranchiseInquiryNote ONLY, exercised on throwaway
// scratch databases starting from the exact post-S0D-2C-1 state, with rows
// written in the nullable window that exercise every backfill tier.

jest.setTimeout(180_000);

const repoRoot = join(__dirname, '../../../..');
const migrations = listMigrations(
  join(repoRoot, 'packages/database/prisma/migrations'),
);
const targetIndex = migrations.findIndex((m) =>
  m.name.endsWith('_require_tenant_id_careers_franchising'),
);
const before = migrations.slice(0, targetIndex);
const target = migrations[targetIndex];

const CONVERTED = [
  'JobOpening',
  'JobApplication',
  'JobApplicationNote',
  'FranchiseInquiry',
  'FranchiseInquiryNote',
];
// Models already NOT NULL before this migration (S0D-2A, S0D-2B-1,
// S0D-2B-2, S0D-2C-1) plus the five converted here.
const REQUIRED_AFTER = new Set([
  'Location',
  'Category',
  'Product',
  'Menu',
  'ModifierGroup',
  'ModifierOption',
  'ProductModifierGroup',
  'MenuProduct',
  'LocationMenu',
  'LocationProductPriceOverride',
  'LocationProductAvailabilityOverride',
  'ChecklistTemplate',
  'ChecklistTemplateItem',
  'ChecklistInstance',
  'ChecklistInstanceItem',
  'OperationsTask',
  'Customer',
  'CustomerPreferredLocation',
  'CustomerNote',
  'PaymentAttempt',
  'Order',
  'OrderLine',
  'OrderStatusHistory',
  ...CONVERTED,
]);
const tenantTables = Object.entries(MODEL_TENANCY)
  .filter(([, tenancy]) => tenancy === 'tenant')
  .map(([model]) => model)
  // Milestone S0D-2C-3 added NotificationRecipient AFTER this migration;
  // this test is pinned to the schema exactly as it existed at `target`,
  // which never has that table.
  .filter((model) => model !== 'NotificationRecipient');

const baseUrl = process.env.DATABASE_URL!;
const T1 = TENANT_1_MOCHA_HOUSE_ID;

// Window rows:
//   job-loc  -> JobOpening tier 1 (its Location)
//   job-corp -> JobOpening tier 2 (corporate / no location; Tenant #1
//               fallback, single-tenant guard)
//   app-loc, app-corp -> JobApplication, one per JobOpening tier
//   note-app -> JobApplicationNote on app-loc
//   inq-w    -> FranchiseInquiry (no parent at all; Tenant #1 fallback)
//   note-inq -> FranchiseInquiryNote on inq-w
const WINDOW_ROWS_SQL = `
INSERT INTO "Location" (id, name, slug, "updatedAt", "tenantId")
  VALUES ('loc-cf-w', 'CF Window', 'cf-window', now(), '${T1}');
INSERT INTO "InternalUser" (id, "externalProvider", email, "updatedAt")
  VALUES ('iu-cf-w', 'internal-dev', 'cf-window@example.com', now());
INSERT INTO "JobOpening" (id, title, "employmentType", "locationId", summary, description, responsibilities, qualifications, "updatedAt") VALUES
  ('job-loc',  'Barista',  'FULL_TIME', 'loc-cf-w', 'Summary',  'Description',  'Responsibilities',  'Qualifications',  now()),
  ('job-corp', 'HQ Role',  'FULL_TIME', NULL,        'Summary',  'Description',  'Responsibilities',  'Qualifications',  now());
INSERT INTO "JobApplication" (id, "jobOpeningId", "jobTitleSnapshot", "firstName", "lastName", email, phone, location, "workAuthorized", availability, message, "updatedAt") VALUES
  ('app-loc',  'job-loc',  'Barista', 'Dana', 'Rivera', 'dana@example.com', '555-0100', 'Austin, TX', true, 'Anytime', 'Message', now()),
  ('app-corp', 'job-corp', 'HQ Role', 'Sam',  'Lee',    'sam@example.com',  '555-0101', 'Austin, TX', true, 'Anytime', 'Message', now());
INSERT INTO "JobApplicationNote" (id, "jobApplicationId", "authorInternalUserId", body, "createdAt")
  VALUES ('note-app', 'app-loc', 'iu-cf-w', 'Looks promising.', now());
INSERT INTO "FranchiseInquiry" (id, "firstName", "lastName", email, phone, city, state, country, "preferredMarket", "consentAcknowledged", "updatedAt")
  VALUES ('inq-w', 'Jordan', 'Lee', 'jordan@example.com', '555-0200', 'Austin', 'TX', 'USA', 'Central Texas', true, now());
INSERT INTO "FranchiseInquiryNote" (id, "franchiseInquiryId", "authorInternalUserId", body, "createdAt")
  VALUES ('note-inq', 'inq-w', 'iu-cf-w', 'Followed up by phone.', now());
`;

async function query<T extends object>(
  url: string,
  sql: string,
  params: unknown[] = [],
) {
  return withScratchClient(url, async (client) => {
    const { rows } = await client.query<T>(sql, params);
    return rows;
  });
}

async function nullability(url: string): Promise<Record<string, string>> {
  const rows = await query<{ table_name: string; is_nullable: string }>(
    url,
    `SELECT table_name, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'tenantId'`,
  );
  return Object.fromEntries(rows.map((r) => [r.table_name, r.is_nullable]));
}

async function tenantIds(url: string, table: string) {
  const rows = await query<{ id: string; tenantId: string | null }>(
    url,
    `SELECT id, "tenantId" FROM "${table}" ORDER BY id`,
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.tenantId]));
}

async function allConvertedStillNull(url: string) {
  const columns = await nullability(url);
  for (const table of CONVERTED) {
    expect({ table, nullable: columns[table] }).toEqual({
      table,
      nullable: 'YES',
    });
    const ids = await tenantIds(url, table);
    for (const [id, tenantId] of Object.entries(ids)) {
      expect({ table, id, tenantId }).toEqual({ table, id, tenantId: null });
    }
  }
}

// Everything the migration must NOT change: constraints, indexes, triggers
// and column defaults across the schema, plus the enum catalogue.
async function structure(url: string) {
  const pick = async (sql: string) =>
    (await query<{ def: string }>(url, sql)).map((r) => r.def);
  return {
    constraints: await pick(
      `SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1`,
    ),
    indexes: await pick(
      `SELECT indexdef AS def FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
    ),
    triggers: await pick(
      `SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`,
    ),
    defaults: await pick(
      `SELECT table_name || '.' || column_name || '=' || column_default AS def
         FROM information_schema.columns
        WHERE table_schema = 'public' AND column_default IS NOT NULL ORDER BY 1`,
    ),
    enums: await pick(
      `SELECT t.typname || '.' || e.enumlabel AS def
         FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid ORDER BY 1`,
    ),
  };
}

// Plants a row state the application and the FKs would never allow, by
// skipping FK enforcement for ONE statement batch on the scratch database
// only. Used to prove each post-backfill consistency check fires.
async function withoutFkChecks(url: string, sql: string) {
  await applyMigrationSql(
    url,
    `SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`,
  );
}

async function expectAbort(url: string, message: RegExp) {
  await expect(applyMigrationSql(url, target.sql)).rejects.toThrow(message);
}

describe('S0D-2D careers & franchising NOT NULL migration (scratch databases)', () => {
  let scratch: ScratchDatabase;
  let structureBefore: Awaited<ReturnType<typeof structure>>;

  beforeAll(async () => {
    scratch = await createScratchDatabase(baseUrl, 's0d2d');
    await applyMigrations(scratch.url, before);
    await applyMigrationSql(scratch.url, WINDOW_ROWS_SQL);
    structureBefore = await structure(scratch.url);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('follows S0D-2C-1, is atomic, alters ONLY the five models, and orders guards → backfill → checks → NOT NULL', () => {
    expect(targetIndex).toBeGreaterThan(0);
    expect(before[before.length - 1].name).toMatch(
      /_require_tenant_id_order_payment$/,
    );
    expect(isAppliedAtomically(target.sql)).toBe(true);

    const altered = [
      ...target.sql.matchAll(
        /ALTER TABLE "(\w+)" ALTER COLUMN "tenantId" SET NOT NULL;/g,
      ),
    ].map((m) => m[1]);
    expect(altered.sort()).toEqual([...CONVERTED].sort());
    expect(target.sql).not.toMatch(
      /ADD VALUE|CREATE TYPE|DEFAULT|UNIQUE|FOREIGN KEY|CREATE TRIGGER|DROP TRIGGER|CREATE INDEX|DROP /,
    );
    // OutboxEvent / NotificationDelivery are NOT converted here.
    expect(target.sql).not.toMatch(/"OutboxEvent"|"NotificationDelivery"/);

    const at = (needle: string) => target.sql.indexOf(needle);
    const firstUpdate = at('UPDATE "JobOpening"');
    expect(at('not ACTIVE')).toBeLessThan(firstUpdate);
    expect(at('other than Tenant #1')).toBeLessThan(firstUpdate);
    // The Tenant #1 fallback tiers run after the parent-derived tier.
    expect(at('FROM "Location" AS l')).toBeLessThan(
      at("corporate row(s) assigned to Tenant #1"),
    );
    const lastCheck = at(
      "FranchiseInquiryNote row(s) do not match their FranchiseInquiry''s tenant",
    );
    expect(
      at("JobOpening row(s) do not match their Location''s tenant"),
    ).toBeLessThan(lastCheck);
    for (const table of CONVERTED) {
      expect(lastCheck).toBeLessThan(at(`ALTER TABLE "${table}"`));
    }
  });

  it('aborts, rolling everything back, when another tenant exists', async () => {
    await query(
      scratch.url,
      `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, 'test-tenant-b', 'B', 'ACTIVE', now())`,
      [TEST_TENANT_B_ID],
    );
    try {
      await expectAbort(
        scratch.url,
        /S0D-2D aborted: 1 tenant\(s\) other than Tenant #1 exist/,
      );
      await allConvertedStillNull(scratch.url);
    } finally {
      await query(scratch.url, `DELETE FROM "Tenant" WHERE id = $1`, [
        TEST_TENANT_B_ID,
      ]);
    }
  });

  it('aborts when Tenant #1 is not ACTIVE', async () => {
    await query(
      scratch.url,
      `UPDATE "Tenant" SET status = 'SUSPENDED', "suspensionReason" = 'SECURITY' WHERE id = $1`,
      [T1],
    );
    try {
      await expectAbort(scratch.url, /S0D-2D aborted: Tenant #1 is SUSPENDED/);
      await allConvertedStillNull(scratch.url);
    } finally {
      await query(
        scratch.url,
        `UPDATE "Tenant" SET status = 'ACTIVE', "suspensionReason" = NULL WHERE id = $1`,
        [T1],
      );
    }
  });

  // Each consistency check, proven by planting one impossible row state.
  const plantedChecks: {
    name: string;
    plant: string;
    undo: string;
    message: RegExp;
  }[] = [
    {
      name: 'a JobOpening that disagrees with its Location',
      // app-loc and note-app are pre-attributed to the same ghost value so
      // the backfill never tries to propagate it through their own
      // tenantId -> Tenant FK (which would fail on the FK, not the check).
      plant: `UPDATE "JobOpening" SET "tenantId" = 'ghost' WHERE id = 'job-loc';
              UPDATE "JobApplication" SET "tenantId" = 'ghost' WHERE id = 'app-loc';
              UPDATE "JobApplicationNote" SET "tenantId" = 'ghost' WHERE id = 'note-app';`,
      undo: `UPDATE "JobOpening" SET "tenantId" = NULL WHERE id = 'job-loc';
             UPDATE "JobApplication" SET "tenantId" = NULL WHERE id = 'app-loc';
             UPDATE "JobApplicationNote" SET "tenantId" = NULL WHERE id = 'note-app'`,
      message: /1 JobOpening row\(s\) do not match their Location's tenant/,
    },
    {
      name: 'a JobApplication that disagrees with its JobOpening',
      // app-loc is pre-attributed so JobOpening's value is not propagated
      // onto it (the tenant FK would otherwise fire first), and note-app is
      // pre-attributed to the same ghost value for the same reason.
      plant: `UPDATE "JobApplication" SET "tenantId" = 'ghost' WHERE id = 'app-loc';
              UPDATE "JobApplicationNote" SET "tenantId" = 'ghost' WHERE id = 'note-app';`,
      undo: `UPDATE "JobApplication" SET "tenantId" = NULL WHERE id = 'app-loc';
             UPDATE "JobApplicationNote" SET "tenantId" = NULL WHERE id = 'note-app'`,
      message:
        /1 JobApplication row\(s\) do not match their JobOpening's tenant/,
    },
    {
      name: 'a JobApplicationNote that disagrees with its JobApplication',
      plant: `UPDATE "JobApplicationNote" SET "tenantId" = 'ghost' WHERE id = 'note-app';`,
      undo: `UPDATE "JobApplicationNote" SET "tenantId" = NULL WHERE id = 'note-app'`,
      message:
        /1 JobApplicationNote row\(s\) do not match their JobApplication's tenant/,
    },
    {
      name: 'a FranchiseInquiryNote that disagrees with its FranchiseInquiry',
      plant: `UPDATE "FranchiseInquiryNote" SET "tenantId" = 'ghost' WHERE id = 'note-inq';`,
      undo: `UPDATE "FranchiseInquiryNote" SET "tenantId" = NULL WHERE id = 'note-inq'`,
      message:
        /1 FranchiseInquiryNote row\(s\) do not match their FranchiseInquiry's tenant/,
    },
  ];
  for (const check of plantedChecks) {
    it(`aborts, rolling everything back, on ${check.name}`, async () => {
      await withoutFkChecks(scratch.url, check.plant);
      try {
        await expectAbort(scratch.url, check.message);
        const columns = await nullability(scratch.url);
        for (const table of CONVERTED) {
          expect(columns[table]).toBe('YES');
        }
      } finally {
        await withoutFkChecks(scratch.url, `${check.undo};`);
      }
      await allConvertedStillNull(scratch.url);
    });
  }

  it('when guards and checks pass: backfills every row through its tier and makes ONLY the five models NOT NULL, changing nothing else', async () => {
    const notices: string[] = [];
    await withScratchClient(scratch.url, async (client) => {
      client.on('notice', (n) => notices.push(n.message ?? ''));
      await client.query(target.sql);
    });

    expect(
      notices.find((n) => n.includes('JobOpening -> ') && n.includes('from Location')),
    ).toMatch(/-> 1 row\(s\)/);
    expect(
      notices.find(
        (n) => n.includes('JobOpening -> ') && n.includes('corporate row(s)'),
      ),
    ).toMatch(/-> 1 corporate row\(s\)/);
    expect(
      notices.find((n) => n.includes('JobApplication -> ')),
    ).toMatch(/-> 2 row\(s\) from JobOpening/);
    expect(
      notices.find((n) => n.includes('JobApplicationNote -> ')),
    ).toMatch(/-> 1 row\(s\) from JobApplication/);
    expect(
      notices.find(
        (n) => n.includes('FranchiseInquiry -> ') && !n.includes('Note'),
      ),
    ).toMatch(/-> 1 row\(s\) assigned to Tenant #1/);
    expect(
      notices.find((n) => n.includes('FranchiseInquiryNote -> ')),
    ).toMatch(/-> 1 row\(s\) from FranchiseInquiry/);

    for (const table of CONVERTED) {
      const ids = await tenantIds(scratch.url, table);
      for (const [id, tenantId] of Object.entries(ids)) {
        expect({ table, id, tenantId }).toEqual({ table, id, tenantId: T1 });
      }
    }
    // OutboxEvent is untouched: still nullable.
    expect((await nullability(scratch.url)).OutboxEvent).toBe('YES');

    const columns = await nullability(scratch.url);
    for (const table of tenantTables) {
      expect({ table, nullable: columns[table] }).toEqual({
        table,
        nullable: REQUIRED_AFTER.has(table) ? 'NO' : 'YES',
      });
    }
    expect(tenantTables.filter((t) => columns[t] === 'NO')).toHaveLength(28);
    expect(tenantTables.filter((t) => columns[t] === 'YES')).toHaveLength(35);
    // Every model this slice made required stays in the testing package's
    // running list (later slices only ever extend it).
    expect(TENANT_ID_REQUIRED_MODELS).toEqual(
      expect.arrayContaining([...REQUIRED_AFTER]),
    );

    // No default, and no constraint / index / trigger / enum change.
    expect(await structure(scratch.url)).toEqual(structureBefore);
  });

  it('afterwards refuses tenantless rows in all five models', async () => {
    const attempts = [
      `INSERT INTO "JobOpening" (id, title, "employmentType", summary, description, responsibilities, qualifications, "updatedAt")
         VALUES ('job-x', 'X', 'FULL_TIME', 'S', 'D', 'R', 'Q', now())`,
      `INSERT INTO "JobApplication" (id, "jobOpeningId", "jobTitleSnapshot", "firstName", "lastName", email, phone, location, "workAuthorized", availability, message, "updatedAt")
         VALUES ('app-x', 'job-loc', 'Barista', 'X', 'Y', 'x@example.com', '555', 'Austin', true, 'Any', 'M', now())`,
      `INSERT INTO "JobApplicationNote" (id, "jobApplicationId", "authorInternalUserId", body)
         VALUES ('note-app-x', 'app-loc', 'iu-cf-w', 'x')`,
      `INSERT INTO "FranchiseInquiry" (id, "firstName", "lastName", email, phone, city, state, country, "preferredMarket", "consentAcknowledged", "updatedAt")
         VALUES ('inq-x', 'X', 'Y', 'x@example.com', '555', 'Austin', 'TX', 'USA', 'Central Texas', true, now())`,
      `INSERT INTO "FranchiseInquiryNote" (id, "franchiseInquiryId", "authorInternalUserId", body)
         VALUES ('note-inq-x', 'inq-w', 'iu-cf-w', 'x')`,
    ];
    for (const sql of attempts) {
      await expect(applyMigrationSql(scratch.url, sql)).rejects.toThrow(
        /null value in column "tenantId"/,
      );
    }
  });
});
