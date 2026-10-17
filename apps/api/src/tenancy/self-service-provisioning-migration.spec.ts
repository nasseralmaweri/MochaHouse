import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyMigrationSql,
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  withScratchClient,
  type ScratchDatabase,
} from '@mocha-house/testing';

// SC4b — migration 20261107090000_self_service_provisioning, on scratch
// databases: Founding is never offered for self-service; a registration's
// business link comes with its time, only once VERIFIED, and never changes;
// a BILLED subscription without a provider customer is exactly "payment
// setup pending"; and a rollback that refuses while any of it exists and
// otherwise restores the SC4a shape (with SC4a's guard still working).
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261107090000_self_service_provisioning.down.sql',
);
const TENANT = '01a0db02-f800-7000-8000-7e5700004b01';
const FOUNDING_PLAN = '01a0db02-f800-7000-8000-00000000f001';
const FOUNDING_VERSION = '01a0db02-f800-7000-8000-00000000f002';
const NONCE = 'a'.repeat(64);

jest.setTimeout(120_000);

describe('SC4b self-service provisioning migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  let subscriptionId: string;
  let priceId: string;
  const query = (text: string, params: unknown[] = []) =>
    withScratchClient(scratch.url, (c) =>
      c.query<Record<string, unknown> & { id: string }>(text, params),
    );

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4b_migration',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    await query(
      `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, 'sc4b-mig', 'Mig', 'ACTIVE', now())`,
      [TENANT],
    );
    subscriptionId = (
      await query(
        `INSERT INTO "TenantSubscription" (id, "subscriberTenantId", "planVersionId", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, now()) RETURNING id`,
        [TENANT, FOUNDING_VERSION],
      )
    ).rows[0].id;
    priceId = (
      await query(
        `INSERT INTO "SubscriptionPlanPrice" (id, "planId", interval, currency, "amountMinorUnits")
         VALUES (gen_random_uuid()::text, $1, 'MONTH', 'USD', 4900) RETURNING id`,
        [FOUNDING_PLAN],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('never offers the Founding plan for self-service', async () => {
    await expect(
      query(
        `UPDATE "SubscriptionPlan" SET "selfServiceAvailable" = true WHERE id = $1`,
        [FOUNDING_PLAN],
      ),
    ).rejects.toThrow();
    const other = (
      await query(
        `INSERT INTO "SubscriptionPlan" (id, key, name, "updatedAt", "selfServiceAvailable")
         VALUES (gen_random_uuid()::text, 'sc4b-mig', 'Mig', now(), true) RETURNING id`,
      )
    ).rows[0].id;
    expect(other).toBeTruthy();
  });

  it('allows a BILLED subscription without a provider customer only as exactly "payment setup pending"', async () => {
    const set = (sql: string) =>
      query(`UPDATE "TenantSubscription" SET ${sql} WHERE id = $1`, [
        subscriptionId,
      ]);
    // Without the setup-required time, or without its price: refused.
    await expect(
      set(`"billingMode" = 'BILLED', "planPriceId" = '${priceId}'`),
    ).rejects.toThrow();
    await expect(
      set(`"billingMode" = 'BILLED', "paymentSetupRequiredSince" = now()`),
    ).rejects.toThrow();
    await set(
      `"billingMode" = 'BILLED', "planPriceId" = '${priceId}', "paymentSetupRequiredSince" = now()`,
    );
    // Nothing authorized, started or owed while there is no provider customer.
    for (const sql of [
      `"recurringPaymentAuthorizedAt" = now()`,
      `"status" = 'TRIALING', "trialStartedAt" = now(), "trialEndsAt" = now() + interval '7 days', "trialRequiresPaymentMethod" = true`,
      `"currentPeriodStart" = now(), "currentPeriodEnd" = now() + interval '30 days'`,
      `"cancelAtPeriodEnd" = true`,
    ]) {
      await expect(set(sql)).rejects.toThrow();
    }
    // With a provider customer, the normal BILLED rules apply again.
    await set(
      `"billingProvider" = 'fake', "externalCustomerId" = 'cus_sc4b_mig'`,
    );
    await set(`"billingProvider" = NULL, "externalCustomerId" = NULL`);
  });

  it('links a registration to its business once, only when VERIFIED, and never changes the link', async () => {
    const id = (
      await query(
        `INSERT INTO "OwnerRegistration" (id, email, "identityProvider", "identitySubject", "initialPasswordNonce", "expiresAt", "updatedAt")
         VALUES (gen_random_uuid()::text, 'sc4b-mig@example.com', 'internal-dev', 'internal-dev:sc4b-mig@example.com', '${NONCE}', now() + interval '1 day', now()) RETURNING id`,
      )
    ).rows[0].id;
    const update = (sql: string) =>
      query(`UPDATE "OwnerRegistration" SET ${sql} WHERE id = $1`, [id]);
    // Not VERIFIED yet; a link without its time.
    await expect(
      update(`"provisionedTenantId" = '${TENANT}', "provisionedAt" = now()`),
    ).rejects.toThrow();
    await update(
      `status = 'VERIFIED', "verifiedAt" = now(), "displayName" = 'Owner', "termsVersion" = 't', "privacyVersion" = 'p', "legalAcceptedAt" = now()`,
    );
    await expect(
      update(`"provisionedTenantId" = '${TENANT}'`),
    ).rejects.toThrow();
    await update(
      `"provisionedTenantId" = '${TENANT}', "provisionedAt" = now()`,
    );
    await expect(
      update(`"provisionedTenantId" = NULL, "provisionedAt" = NULL`),
    ).rejects.toThrow();
    await expect(
      update(`"provisionedTenantId" = '01a0db02-f800-7000-8000-7e5700004b02'`),
    ).rejects.toThrow();
    // One business per registration, one registration per business.
    await expect(
      query(
        `INSERT INTO "OwnerRegistration" (id, email, "identityProvider", "identitySubject", "initialPasswordNonce", "expiresAt", "updatedAt",
           status, "verifiedAt", "displayName", "termsVersion", "privacyVersion", "legalAcceptedAt", "provisionedTenantId", "provisionedAt")
         VALUES (gen_random_uuid()::text, 'sc4b-mig2@example.com', 'internal-dev', 'x2', '${NONCE}', now() + interval '1 day', now(),
           'VERIFIED', now(), 'O', 't', 'p', now(), $1, now())`,
        [TENANT],
      ),
    ).rejects.toThrow();
  });

  it('the rollback refuses while any self-service record exists', async () => {
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    expect(
      (
        await query(
          `SELECT count(*)::int AS n FROM information_schema.columns
           WHERE table_name = 'OwnerRegistration' AND column_name = 'provisionedTenantId'`,
        )
      ).rows[0],
    ).toEqual({ n: 1 });
  });

  it("the rollback restores the SC4a shape when nothing exists, and SC4a's guard still works", async () => {
    const clean = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4b_rollback_clean',
    );
    try {
      await applyMigrations(clean.url, listMigrations(MIGRATIONS));
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      await withScratchClient(clean.url, async (c) => {
        const left = await c.query<{ name: string }>(
          `SELECT column_name AS name FROM information_schema.columns
             WHERE (table_name = 'OwnerRegistration' AND column_name IN ('provisionedTenantId', 'provisionedAt'))
                OR (table_name = 'SubscriptionPlan' AND column_name = 'selfServiceAvailable')`,
        );
        expect(left.rows).toEqual([]);
        const id = (
          await c.query<{ id: string }>(
            `INSERT INTO "OwnerRegistration" (id, email, "identityProvider", "initialPasswordNonce", "expiresAt", "updatedAt")
             VALUES (gen_random_uuid()::text, 'after@example.com', 'internal-dev', '${NONCE}', now() + interval '1 day', now()) RETURNING id`,
          )
        ).rows[0].id;
        await c.query(
          `UPDATE "OwnerRegistration" SET "identitySubject" = 's' WHERE id = $1`,
          [id],
        );
        await expect(
          c.query(
            `UPDATE "OwnerRegistration" SET "identitySubject" = 't' WHERE id = $1`,
            [id],
          ),
        ).rejects.toThrow();
      });
    } finally {
      await clean.drop();
    }
  });
});
