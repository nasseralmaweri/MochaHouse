import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';
import {
  applyMigrationSql,
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  withScratchClient,
  type ScratchDatabase,
} from '@mocha-house/testing';

// SC3e-1 — migration 20261101090000_billing_invoices, on scratch databases:
// a strict invoice shape (known statuses, lower-case currency, no negative
// amounts, paid exactly when paidAt is set), one row per provider invoice,
// which invoice of which subscription set once, a paid or void invoice that
// stays so, no older read over a newer one, no deletion, and a rollback that
// refuses while any invoice is recorded.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261101090000_billing_invoices.down.sql',
);
const ADJUSTMENTS_ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261103090000_billing_adjustments.down.sql',
);
const THIS = '20261101090000_billing_invoices';
const FOUNDING_VERSION = '01a0db02-f800-7000-8000-00000000f002';
const TENANT = '01a0db02-f800-7000-8000-7e5700003e1a';
const OTHER_TENANT = '01a0db02-f800-7000-8000-7e5700003e1b';

jest.setTimeout(120_000);

describe('SC3e-1 billing invoices migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  let subscriptionId: string;
  let otherSubscriptionId: string;
  let seq = 0;
  const sql = <T>(fn: (client: Client) => Promise<T>) =>
    withScratchClient(scratch.url, fn);
  const query = (text: string, params: unknown[] = []) =>
    sql((c) => c.query<Record<string, unknown>>(text, params));
  const expectRefused = (statement: string, params: unknown[] = []) =>
    expect(query(statement, params)).rejects.toThrow();
  const invoice = async (over: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      externalInvoiceId: `in_mig_${seq++}`,
      status: 'paid',
      currency: 'usd',
      amountPaid: 4900,
      paidAt: new Date(),
      ...over,
    };
    return (
      await query(
        `INSERT INTO "BillingInvoice"
           (id, "subscriptionId", provider, "externalInvoiceId", "externalCustomerId",
            "externalSubscriptionId", status, currency, "totalMinorUnits", "amountDueMinorUnits",
            "amountPaidMinorUnits", "amountRemainingMinorUnits", "issuedAt", "paidAt",
            "syncedAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, 'stripe', $2, 'cus_mig', 'sub_mig', $3, $4,
                 4900, 4900, $5, 0, now() - interval '1 day', $6, now(), now())
         RETURNING id`,
        [
          subscriptionId,
          row.externalInvoiceId,
          row.status,
          row.currency,
          row.amountPaid,
          row.paidAt,
        ],
      )
    ).rows[0].id as string;
  };

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3e1_migration',
    );
    const all = listMigrations(MIGRATIONS);
    const at = all.findIndex((migration) => migration.name === THIS);
    expect(at).toBeGreaterThan(0);
    await applyMigrations(scratch.url, all.slice(0, at));
    await sql(async (c) => {
      for (const [id, slug] of [
        [TENANT, 'sc3e1-mig'],
        [OTHER_TENANT, 'sc3e1-mig-other'],
      ]) {
        await c.query(
          `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, $2, 'Mig', 'ACTIVE', now())`,
          [id, slug],
        );
      }
      const sub = async (tenant: string) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO "TenantSubscription" (id, "subscriberTenantId", "planVersionId", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, now()) RETURNING id`,
            [tenant, FOUNDING_VERSION],
          )
        ).rows[0].id;
      subscriptionId = await sub(TENANT);
      otherSubscriptionId = await sub(OTHER_TENANT);
    });
    const before = await query(
      `SELECT count(*)::int AS n FROM "TenantSubscription"`,
    );
    await applyMigrations(scratch.url, [all[at]]);
    expect(
      (await query(`SELECT count(*)::int AS n FROM "TenantSubscription"`)).rows,
    ).toEqual(before.rows);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('keeps a strict shape: known statuses, lower-case currency, no negative amounts, paid exactly when paidAt is set', async () => {
    await invoice();
    await invoice({ status: 'open', amountPaid: 0, paidAt: null });
    await expect(invoice({ status: 'refunded' })).rejects.toThrow();
    await expect(invoice({ currency: 'USD' })).rejects.toThrow();
    await expect(invoice({ amountPaid: -1 })).rejects.toThrow();
    await expect(invoice({ status: 'paid', paidAt: null })).rejects.toThrow();
    await expect(
      invoice({ status: 'open', amountPaid: 0, paidAt: new Date() }),
    ).rejects.toThrow();
  });

  it('one row per provider invoice', async () => {
    await invoice({ externalInvoiceId: 'in_mig_once' });
    await expect(
      invoice({ externalInvoiceId: 'in_mig_once' }),
    ).rejects.toThrow();
  });

  it('which invoice of which subscription never changes; a paid or void invoice stays so; never an older read; never deleted', async () => {
    const id = await invoice();
    await expectRefused(
      `UPDATE "BillingInvoice" SET "subscriptionId" = $2 WHERE id = $1`,
      [id, otherSubscriptionId],
    );
    await expectRefused(
      `UPDATE "BillingInvoice" SET "externalCustomerId" = 'cus_other' WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "BillingInvoice" SET "externalInvoiceId" = 'in_other' WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "BillingInvoice" SET status = 'open', "paidAt" = NULL WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "BillingInvoice" SET "syncedAt" = "syncedAt" - interval '1 minute' WHERE id = $1`,
      [id],
    );
    // A credit note after payment updates the amounts (newer read).
    await query(
      `UPDATE "BillingInvoice" SET "postPaymentCreditMinorUnits" = 1000, "syncedAt" = now() + interval '1 second' WHERE id = $1`,
      [id],
    );
    await expectRefused(`DELETE FROM "BillingInvoice" WHERE id = $1`, [id]);
    await expectRefused(`TRUNCATE "BillingInvoice"`);
    // Its number is set once.
    const open = await invoice({ status: 'open', amountPaid: 0, paidAt: null });
    await query(`UPDATE "BillingInvoice" SET number = 'INV-1' WHERE id = $1`, [
      open,
    ]);
    await expectRefused(
      `UPDATE "BillingInvoice" SET number = 'INV-2' WHERE id = $1`,
      [open],
    );
  });

  it('the rollback refuses, changing nothing, while any invoice is recorded', async () => {
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    expect(
      Number(
        (await query(`SELECT count(*)::int AS n FROM "BillingInvoice"`)).rows[0]
          .n,
      ),
    ).toBeGreaterThan(0);
  });

  it('the rollback removes exactly the table and its guard when no invoice is recorded', async () => {
    const clean = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3e1_rollback_clean',
    );
    try {
      await applyMigrations(clean.url, listMigrations(MIGRATIONS));
      // SC3e-3 references invoices: rolled back first (newest first).
      await applyMigrationSql(
        clean.url,
        readFileSync(ADJUSTMENTS_ROLLBACK, 'utf8'),
      );
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      const left = await withScratchClient(
        clean.url,
        async (c) =>
          (
            await c.query<{ name: string }>(
              `SELECT table_name AS name FROM information_schema.tables WHERE table_name = 'BillingInvoice'
             UNION ALL
             SELECT proname FROM pg_proc WHERE proname = 'guard_billing_invoice'`,
            )
          ).rows,
      );
      expect(left).toEqual([]);
    } finally {
      await clean.drop();
    }
  });
});
