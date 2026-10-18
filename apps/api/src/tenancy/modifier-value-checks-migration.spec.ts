import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  applyMigrationSql,
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  withScratchClient,
  type ScratchDatabase,
} from '@mocha-house/testing';

// Product Modifier Management — migration 20261114090000_modifier_value_checks
// on scratch databases: valid existing modifiers come through unchanged; the
// database itself then refuses out-of-bounds values; a database holding a
// row that breaks a rule is refused before anything is added (counted per
// rule, nothing repaired); and the guarded rollback.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const THIS_MIGRATION = '20261114090000_modifier_value_checks';
const ROLLBACK = join(
  __dirname,
  `../../../../packages/database/prisma/rollbacks/${THIS_MIGRATION}.down.sql`,
);
const T1 = TENANT_1_MOCHA_HOUSE_ID;

jest.setTimeout(240_000);

describe('Product Modifier Management value checks migration (scratch database)', () => {
  const all = listMigrations(MIGRATIONS);
  const at = all.findIndex((m) => m.name === THIS_MIGRATION);
  const before = all.slice(0, at);
  const thisOne = all.slice(at, at + 1);

  const run = (
    scratch: ScratchDatabase,
    text: string,
    params: unknown[] = [],
  ) =>
    withScratchClient(scratch.url, (c) =>
      c.query<Record<string, unknown>>(text, params),
    );
  const insertGroup = (
    scratch: ScratchDatabase,
    id: string,
    values: {
      name?: string;
      isRequired?: boolean;
      minSelections?: number;
      maxSelections?: number | null;
    } = {},
  ) =>
    run(
      scratch,
      `INSERT INTO "ModifierGroup" (id, "tenantId", name, "isRequired", "minSelections", "maxSelections", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [
        id,
        T1,
        values.name ?? 'Size',
        values.isRequired ?? true,
        values.minSelections ?? 1,
        values.maxSelections === undefined ? 1 : values.maxSelections,
      ],
    );
  const insertOption = (
    scratch: ScratchDatabase,
    id: string,
    groupId: string,
    values: { name?: string; priceAdjustment?: number } = {},
  ) =>
    run(
      scratch,
      `INSERT INTO "ModifierOption" (id, "tenantId", "modifierGroupId", name, "priceAdjustment", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, now())`,
      [id, T1, groupId, values.name ?? 'Small', values.priceAdjustment ?? 0],
    );
  const constraintCount = async (scratch: ScratchDatabase) =>
    Number(
      (
        await run(
          scratch,
          `SELECT count(*) AS n FROM pg_constraint
           WHERE conname IN ('ModifierGroup_name_check', 'ModifierGroup_selections_check',
                             'ModifierOption_name_check', 'ModifierOption_priceAdjustment_check')`,
        )
      ).rows[0].n,
    );

  it('is listed after every earlier migration', () => {
    expect(at).toBeGreaterThan(0);
  });

  describe('on valid data', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'pmm_checks_ok',
      );
      await applyMigrations(scratch.url, before);
      await insertGroup(scratch, 'mg-size');
      await insertOption(scratch, 'mo-small', 'mg-size');
      await insertOption(scratch, 'mo-large', 'mg-size', {
        name: 'Large',
        priceAdjustment: 10_000,
      });
      await insertGroup(scratch, 'mg-extras', {
        name: 'Extras',
        isRequired: false,
        minSelections: 0,
        maxSelections: null,
      });
      await applyMigrations(scratch.url, thisOne);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('keeps every existing modifier exactly as it was', async () => {
      const { rows } = await run(
        scratch,
        `SELECT id, name, "isRequired", "minSelections", "maxSelections" FROM "ModifierGroup" ORDER BY id`,
      );
      expect(rows).toEqual([
        {
          id: 'mg-extras',
          name: 'Extras',
          isRequired: false,
          minSelections: 0,
          maxSelections: null,
        },
        {
          id: 'mg-size',
          name: 'Size',
          isRequired: true,
          minSelections: 1,
          maxSelections: 1,
        },
      ]);
      const options = await run(
        scratch,
        `SELECT id, "priceAdjustment" FROM "ModifierOption" ORDER BY id`,
      );
      expect(options.rows).toEqual([
        { id: 'mo-large', priceAdjustment: 10_000 },
        { id: 'mo-small', priceAdjustment: 0 },
      ]);
      expect(await constraintCount(scratch)).toBe(4);
    });

    it('then refuses out-of-bounds values in the database itself', async () => {
      const badGroups = [
        { name: '' },
        { name: ' Size' },
        { name: 'x'.repeat(121) },
        { minSelections: 21, maxSelections: null },
        { minSelections: -1, isRequired: false, maxSelections: null },
        { minSelections: 0, isRequired: true, maxSelections: null },
        { minSelections: 1, isRequired: false },
        { minSelections: 2, maxSelections: 1 },
        { minSelections: 0, isRequired: false, maxSelections: 0 },
        { maxSelections: 21 },
      ];
      for (const [i, values] of badGroups.entries()) {
        await expect(
          insertGroup(scratch, `mg-bad-${i}`, values),
        ).rejects.toThrow(/check constraint/);
      }
      for (const [i, values] of [
        { priceAdjustment: -1 },
        { priceAdjustment: 10_001 },
        { name: '' },
        { name: 'Oat ' },
      ].entries()) {
        await expect(
          insertOption(scratch, `mo-bad-${i}`, 'mg-size', values),
        ).rejects.toThrow(/check constraint/);
      }
    });

    it('the rollback removes only its four constraints, then refuses to run again', async () => {
      const sql = readFileSync(ROLLBACK, 'utf8');
      await applyMigrationSql(scratch.url, sql);
      expect(await constraintCount(scratch)).toBe(0);
      const { rows } = await run(
        scratch,
        `SELECT count(*) AS n FROM "ModifierOption"`,
      );
      expect(Number(rows[0].n)).toBe(2);
      await expect(applyMigrationSql(scratch.url, sql)).rejects.toThrow(
        /rollback refused/,
      );
    });
  });

  describe('on data that breaks a rule', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'pmm_checks_bad',
      );
      await applyMigrations(scratch.url, before);
      await insertGroup(scratch, 'mg-mismatch', {
        isRequired: true,
        minSelections: 0,
        maxSelections: null,
      });
      await insertGroup(scratch, 'mg-ok');
      await insertOption(scratch, 'mo-negative', 'mg-ok', {
        priceAdjustment: -50,
      });
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('stops before adding anything, counts each rule, and repairs nothing', async () => {
      await expect(applyMigrations(scratch.url, thisOne)).rejects.toThrow(
        /group required\/minimum mismatch: 1, option names: 0, option price adjustments: 1/,
      );
      expect(await constraintCount(scratch)).toBe(0);
      const group = await run(
        scratch,
        `SELECT "isRequired", "minSelections" FROM "ModifierGroup" WHERE id = 'mg-mismatch'`,
      );
      expect(group.rows).toEqual([{ isRequired: true, minSelections: 0 }]);
      const option = await run(
        scratch,
        `SELECT "priceAdjustment" FROM "ModifierOption" WHERE id = 'mo-negative'`,
      );
      expect(option.rows).toEqual([{ priceAdjustment: -50 }]);
    });

    it('applies once the rows are fixed explicitly', async () => {
      await run(
        scratch,
        `UPDATE "ModifierGroup" SET "isRequired" = false WHERE id = 'mg-mismatch'`,
      );
      await run(
        scratch,
        `UPDATE "ModifierOption" SET "priceAdjustment" = 0 WHERE id = 'mo-negative'`,
      );
      await applyMigrations(scratch.url, thisOne);
      expect(await constraintCount(scratch)).toBe(4);
    });
  });
});
