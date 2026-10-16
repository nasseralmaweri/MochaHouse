import { Client } from 'pg';

// Helpers for the suites pinned to an OLDER migration (Security 4C-2 .. 4C-7).
// Those suites build a scratch database at an old migration, apply the real
// migration runner, and then check that the migration under test changed nothing
// it should not have ("data unchanged"). A migration added AFTER them (ESP-03's
// payment recovery foundation) is applied by the same `migrate deploy` and adds
// objects those suites never knew about. These helpers exclude ONLY those
// explicitly listed later-added objects — never a table or column that existed
// when the suite's migration was written — so every original assertion keeps its
// strength.
//
// This file uses `pg` directly rather than the shared test helpers package:
// application source must never depend on that test-only package
// (tenant-boundaries.spec.ts).

// Tables created after the 4C-era migrations.
export const TABLES_ADDED_AFTER_4C: ReadonlySet<string> = new Set([
  'PaymentReconciliationCase',
  'PaymentReconciliationEvent',
  'OrderClosure',
  'OrderRefundObligation',
  // SC1a — CENTERIVO platform operators (20261022090000).
  'PlatformOperator',
  'PlatformAuditEvent',
  // SC1d — business provisioning records (20261023090000).
  'TenantProvisioningOperation',
  // SC2a — SaaS plans and subscriptions (20261024090000).
  'SubscriptionPlan',
  'SubscriptionPlanVersion',
  'TenantSubscription',
  'TenantModuleGrant',
  'TenantSubscriptionEvent',
  // SC3a — SaaS billing (20261025090000).
  'SubscriptionPlanPrice',
  'BillingPolicy',
  'BillingTrialClaim',
  'BillingProviderEvent',
]);

// Columns added after the 4C-era migrations to tables that already existed.
export const COLUMNS_ADDED_AFTER_4C: Readonly<
  Record<string, readonly string[]>
> = {
  PaymentAttempt: ['paymentState', 'fulfilmentStatus'],
};

// A checksum of every row of every table that existed at the 4C-era migrations,
// over the columns that existed then (excluding Prisma's own history). Rows are
// hashed as JSON, so a column added later cannot change it, and a change to any
// pre-existing column of any pre-existing table still does.
export async function dataChecksum(url: string): Promise<string> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows: tables } = await client.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
          AND tablename <> ALL ($1::text[])
        ORDER BY 1`,
      [[...TABLES_ADDED_AFTER_4C]],
    );
    const parts: string[] = [];
    for (const { name } of tables) {
      const { rows } = await client.query<{ sum: string }>(
        `SELECT md5(coalesce(string_agg(r, '|' ORDER BY r), '')) AS sum
           FROM (SELECT (to_jsonb(t) - $1::text[])::text AS r FROM "${name}" t) s`,
        [[...(COLUMNS_ADDED_AFTER_4C[name] ?? [])]],
      );
      parts.push(`${name}:${rows[0].sum}`);
    }
    return parts.join(',');
  } finally {
    await client.end();
  }
}
