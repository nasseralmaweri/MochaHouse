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

// SC3e-2 — migration 20261102090000_operator_billing_controls, on scratch
// databases: known permissions only, one live grant per operator and
// permission, grants never changed or deleted (revoked once, for a reason);
// complimentary grants with a strict shape, one open per subscription,
// forward-only and final; append-only case actions; the complimentary
// history types; and a rollback that refuses while any of it exists.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261102090000_operator_billing_controls.down.sql',
);
const THIS = '20261102090000_operator_billing_controls';
const FOUNDING_PLAN = '01a0db02-f800-7000-8000-00000000f001';
const FOUNDING_VERSION = '01a0db02-f800-7000-8000-00000000f002';
const TENANT = '01a0db02-f800-7000-8000-7e5700003e2a';

jest.setTimeout(120_000);

describe('SC3e-2 operator billing controls migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  let operatorId: string;
  let subscriptionId: string;
  let priceId: string;
  const sql = <T>(fn: (client: Client) => Promise<T>) =>
    withScratchClient(scratch.url, fn);
  const query = (text: string, params: unknown[] = []) =>
    sql((c) => c.query<Record<string, unknown>>(text, params));
  const expectRefused = (statement: string, params: unknown[] = []) =>
    expect(query(statement, params)).rejects.toThrow();
  const permission = (
    name: string,
    reason = 'Granted for the migration test.',
  ) =>
    query(
      `INSERT INTO "PlatformOperatorPermission" (id, "operatorId", permission, "grantReason")
       VALUES (gen_random_uuid()::text, $1, $2, $3) RETURNING id`,
      [operatorId, name, reason],
    );
  const grant = (over: Record<string, unknown> = {}) => {
    const row = {
      status: 'ACTIVE',
      startedAt: new Date(),
      effectiveAt: null as Date | null,
      previousExternalSubscriptionId: 'sub_mig' as string | null,
      reason: 'A partner programme grant.',
      ...over,
    };
    return query(
      `INSERT INTO "BillingComplimentaryGrant"
         (id, "subscriptionId", status, "planVersionId", reason, "grantedByOperatorId",
          "previousStatus", "previousPlanVersionId", "previousPlanPriceId", "previousBillingProvider",
          "previousExternalCustomerId", "previousExternalSubscriptionId", "effectiveAt", "startedAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 'ACTIVE', $3, $6, 'stripe', 'cus_mig', $7, $8, $9, now())
       RETURNING id`,
      [
        subscriptionId,
        row.status,
        FOUNDING_VERSION,
        row.reason,
        operatorId,
        priceId,
        row.previousExternalSubscriptionId,
        row.effectiveAt,
        row.startedAt,
      ],
    );
  };

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3e2_migration',
    );
    const all = listMigrations(MIGRATIONS);
    const at = all.findIndex((migration) => migration.name === THIS);
    expect(at).toBeGreaterThan(0);
    await applyMigrations(scratch.url, all.slice(0, at));
    await sql(async (c) => {
      await c.query(
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, 'sc3e2-mig', 'Mig', 'ACTIVE', now())`,
        [TENANT],
      );
      subscriptionId = (
        await c.query<{ id: string }>(
          `INSERT INTO "TenantSubscription" (id, "subscriberTenantId", "planVersionId", "updatedAt")
           VALUES (gen_random_uuid()::text, $1, $2, now()) RETURNING id`,
          [TENANT, FOUNDING_VERSION],
        )
      ).rows[0].id;
      operatorId = (
        await c.query<{ id: string }>(
          `INSERT INTO "PlatformOperator" (id, "externalProvider", "externalSubject", email, status, "updatedAt")
           VALUES (gen_random_uuid()::text, 'platform-dev', 'platform-dev:mig', 'mig@example.test', 'ACTIVE', now()) RETURNING id`,
        )
      ).rows[0].id;
      priceId = (
        await c.query<{ id: string }>(
          `INSERT INTO "SubscriptionPlanPrice" (id, "planId", interval, currency, "amountMinorUnits")
           VALUES (gen_random_uuid()::text, $1, 'MONTH', 'USD', 4900) RETURNING id`,
          [FOUNDING_PLAN],
        )
      ).rows[0].id;
    });
    await applyMigrations(scratch.url, [all[at]]);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('permissions: known names only, a real reason, one live grant; never changed or deleted; revoked once', async () => {
    const id = (await permission('billing.cases.manage')).rows[0].id as string;
    await expect(permission('billing.everything')).rejects.toThrow();
    await expect(
      permission('billing.prices.manage', 'short'),
    ).rejects.toThrow();
    await expect(permission('billing.cases.manage')).rejects.toThrow();
    await expectRefused(
      `UPDATE "PlatformOperatorPermission" SET permission = 'billing.policy.manage' WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "PlatformOperatorPermission" SET "revokedAt" = now() WHERE id = $1`,
      [id],
    );
    await query(
      `UPDATE "PlatformOperatorPermission" SET "revokedAt" = now(), "revokeReason" = 'Left the billing team.' WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "PlatformOperatorPermission" SET "revokeReason" = 'Changed my mind.' WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `DELETE FROM "PlatformOperatorPermission" WHERE id = $1`,
      [id],
    );
    await expectRefused(`TRUNCATE "PlatformOperatorPermission"`);
    // After revocation it may be granted again.
    await permission('billing.cases.manage');
  });

  it('complimentary grants: strict shape, one open per subscription, forward-only and final', async () => {
    await expect(grant({ status: 'PENDING' })).rejects.toThrow();
    await expect(grant({ reason: 'short' })).rejects.toThrow();
    await expect(
      grant({ status: 'ACTIVE', startedAt: null }),
    ).rejects.toThrow();
    await expect(
      grant({ status: 'SCHEDULED', startedAt: null, effectiveAt: null }),
    ).rejects.toThrow();
    const id = (
      await grant({
        status: 'SCHEDULED',
        startedAt: null,
        effectiveAt: new Date(Date.now() + 86_400_000),
      })
    ).rows[0].id as string;
    await expect(grant()).rejects.toThrow();
    await expectRefused(
      `UPDATE "BillingComplimentaryGrant" SET "planVersionId" = "previousPlanVersionId", reason = 'A different reason now.' WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "BillingComplimentaryGrant" SET status = 'ENDED', "finishedAt" = now(), "finishCode" = 'EXPIRED' WHERE id = $1`,
      [id],
    );
    await query(
      `UPDATE "BillingComplimentaryGrant" SET status = 'ACTIVE', "startedAt" = now() WHERE id = $1`,
      [id],
    );
    await query(
      `UPDATE "BillingComplimentaryGrant" SET status = 'ENDED', "finishedAt" = now(), "finishCode" = 'EXPIRED' WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "BillingComplimentaryGrant" SET "finishCode" = 'REVOKED' WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `DELETE FROM "BillingComplimentaryGrant" WHERE id = $1`,
      [id],
    );
  });

  it('case actions are append-only; a closing outcome only on a resolved case; the complimentary history types exist', async () => {
    const caseId = (
      await query(
        `INSERT INTO "BillingReconciliationCase" (id, kind, "subscriptionId") VALUES (gen_random_uuid()::text, 'PRICE_MISMATCH', $1) RETURNING id`,
        [subscriptionId],
      )
    ).rows[0].id as string;
    const action = (
      await query(
        `INSERT INTO "BillingReconciliationCaseAction" (id, "caseId", action, result, "actorPlatformOperatorId")
         VALUES (gen_random_uuid()::text, $1, 'RECHECKED', 'CONSISTENT', $2) RETURNING id`,
        [caseId, operatorId],
      )
    ).rows[0].id as string;
    // A release names its schedule; a release or a closing says why.
    await expectRefused(
      `INSERT INTO "BillingReconciliationCaseAction" (id, "caseId", action, result, note, "actorPlatformOperatorId")
       VALUES (gen_random_uuid()::text, $1, 'SCHEDULE_RELEASED', 'RELEASED', 'why', $2)`,
      [caseId, operatorId],
    );
    await expectRefused(
      `INSERT INTO "BillingReconciliationCaseAction" (id, "caseId", action, result, "actorPlatformOperatorId")
       VALUES (gen_random_uuid()::text, $1, 'CLOSED', 'NO_ACTION_NEEDED', $2)`,
      [caseId, operatorId],
    );
    await expectRefused(
      `UPDATE "BillingReconciliationCaseAction" SET result = 'MISMATCH_FOUND' WHERE id = $1`,
      [action],
    );
    await expectRefused(
      `DELETE FROM "BillingReconciliationCaseAction" WHERE id = $1`,
      [action],
    );
    await expectRefused(
      `UPDATE "BillingReconciliationCase" SET "resolutionOutcome" = 'DUPLICATE' WHERE id = $1`,
      [caseId],
    );
    await query(
      `UPDATE "BillingReconciliationCase" SET status = 'RESOLVED', "resolvedAt" = now(), "resolutionOutcome" = 'DUPLICATE', "resolutionNote" = 'Same as another.' WHERE id = $1`,
      [caseId],
    );
    await query(
      `INSERT INTO "TenantSubscriptionEvent" (id, "subscriptionId", type, "fromStatus", "toStatus", "toPlanVersionId", source)
       VALUES (gen_random_uuid()::text, $1, 'COMPLIMENTARY_STARTED', 'ACTIVE', 'ACTIVE', $2, 'SYSTEM')`,
      [subscriptionId, FOUNDING_VERSION],
    );
    await expectRefused(
      `INSERT INTO "TenantSubscriptionEvent" (id, "subscriptionId", type, "fromStatus", "toStatus", source)
       VALUES (gen_random_uuid()::text, $1, 'COMPLIMENTARY_ENDED', 'ACTIVE', 'CANCELED', 'SYSTEM')`,
      [subscriptionId],
    );
  });

  it('the rollback refuses, changing nothing, while any of it exists', async () => {
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    expect(
      Number(
        (
          await query(
            `SELECT count(*)::int AS n FROM "PlatformOperatorPermission"`,
          )
        ).rows[0].n,
      ),
    ).toBeGreaterThan(0);
  });

  it('the rollback removes exactly what was added when nothing exists', async () => {
    const clean = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3e2_rollback_clean',
    );
    try {
      await applyMigrations(clean.url, listMigrations(MIGRATIONS));
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      const left = await withScratchClient(clean.url, async (c) => ({
        tables: (
          await c.query<{ name: string }>(
            `SELECT table_name AS name FROM information_schema.tables
             WHERE table_name IN ('PlatformOperatorPermission', 'BillingComplimentaryGrant', 'BillingReconciliationCaseAction')
             UNION ALL
             SELECT column_name FROM information_schema.columns
             WHERE table_name = 'BillingReconciliationCase' AND column_name IN ('resolutionOutcome', 'resolutionNote')
             UNION ALL
             SELECT proname FROM pg_proc WHERE proname IN
               ('guard_platform_operator_permission', 'guard_billing_complimentary_grant', 'guard_billing_reconciliation_case_action')`,
          )
        ).rows,
        enumValues: (
          await c.query<{ v: string }>(
            `SELECT unnest(enum_range(NULL::"TenantSubscriptionEventType"))::text AS v`,
          )
        ).rows
          .map((r) => r.v)
          .filter((v) => v.startsWith('COMPLIMENTARY')),
      }));
      expect(left).toEqual({ tables: [], enumValues: [] });
    } finally {
      await clean.drop();
    }
  });
});
