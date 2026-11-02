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

// ESP-04 M3 — migration 20261122090000_stripe_payment_intents on scratch
// databases: existing payments and events come through unchanged; a Stripe
// payment that names an intent always names its connected account, at most
// one Stripe payment names a given intent, and neither its account nor its
// intent ever changes; payment events gain the intent they are about and the
// UNMATCHED status; the preflight refuses (changing nothing) when applied
// twice or when Stripe payments already exist; and the rollback refuses while
// any Stripe payment or payment event exists, otherwise restoring the
// previous shape.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const THIS_MIGRATION = '20261122090000_stripe_payment_intents';
const MIGRATION_SQL = join(MIGRATIONS, THIS_MIGRATION, 'migration.sql');
const ROLLBACK = join(
  __dirname,
  `../../../../packages/database/prisma/rollbacks/${THIS_MIGRATION}.down.sql`,
);
const T1 = TENANT_1_MOCHA_HOUSE_ID;
const DIGEST = '0'.repeat(64);

jest.setTimeout(300_000);

describe('ESP-04 M3 Stripe payment intents migration (scratch database)', () => {
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
  const attempt = (
    scratch: ScratchDatabase,
    id: string,
    provider: string,
    paymentState: string | null,
    providerReference: string | null = null,
    providerAccountId: string | null = null,
  ) =>
    run(
      scratch,
      providerAccountId === null
        ? `INSERT INTO "PaymentAttempt" (id, "tenantId", "idempotencyKey", provider, amount, currency, status, "paymentState", "providerReference", "updatedAt")
           VALUES ($1, $2, $3, $4, 500, 'USD', 'PENDING', $5, $6, now())`
        : `INSERT INTO "PaymentAttempt" (id, "tenantId", "idempotencyKey", provider, amount, currency, status, "paymentState", "providerReference", "providerAccountId", "updatedAt")
           VALUES ($1, $2, $3, $4, 500, 'USD', 'PENDING', $5, $6, $7, now())`,
      [
        id,
        T1,
        `key-${id}`,
        provider,
        paymentState,
        providerReference,
        ...(providerAccountId === null ? [] : [providerAccountId]),
      ],
    );
  const event = (
    scratch: ScratchDatabase,
    id: string,
    status = 'RECEIVED',
    objectId: string | null = null,
  ) =>
    run(
      scratch,
      objectId === null
        ? `INSERT INTO "RestaurantPaymentProviderEvent" (id, provider, "externalEventId", type, livemode, "payloadDigest", status)
           VALUES ($1, 'stripe', $1, 'account.updated', false, $2, $3)`
        : `INSERT INTO "RestaurantPaymentProviderEvent" (id, provider, "externalEventId", type, livemode, "payloadDigest", status, "externalObjectId")
           VALUES ($1, 'stripe', $1, 'payment_intent.succeeded', false, $2, $3, $4)`,
      objectId === null ? [id, DIGEST, status] : [id, DIGEST, status, objectId],
    );
  const count = async (scratch: ScratchDatabase, sql: string) =>
    Number((await run(scratch, sql)).rows[0].n);

  it('is listed after every earlier migration', () => {
    expect(at).toBeGreaterThan(0);
  });

  describe('applied', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp04_m3_stripe_intents',
      );
      await applyMigrations(scratch.url, before);
      await attempt(
        scratch,
        'pa-fake',
        'fake-two-step',
        'REQUIRES_CUSTOMER_ACTION',
        'fakepi_1',
      );
      await event(scratch, 'evt-old', 'PROCESSED');
      await applyMigrations(scratch.url, thisOne);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('leaves existing payments and events exactly as they were', async () => {
      const { rows } = await run(
        scratch,
        `SELECT id, provider, "paymentState", "providerReference", "providerAccountId" FROM "PaymentAttempt"`,
      );
      expect(rows).toEqual([
        {
          id: 'pa-fake',
          provider: 'fake-two-step',
          paymentState: 'REQUIRES_CUSTOMER_ACTION',
          providerReference: 'fakepi_1',
          providerAccountId: null,
        },
      ]);
      const events = await run(
        scratch,
        `SELECT id, status, "externalObjectId", "lastAttemptAt" FROM "RestaurantPaymentProviderEvent"`,
      );
      expect(events.rows).toEqual([
        {
          id: 'evt-old',
          status: 'PROCESSED',
          externalObjectId: null,
          lastAttemptAt: null,
        },
      ]);
    });

    it('a Stripe payment that names an intent always names its account, in the right format', async () => {
      await attempt(
        scratch,
        'pa-s1',
        'stripe',
        'REQUIRES_CUSTOMER_ACTION',
        'pi_1',
        'acct_1A',
      );
      await attempt(scratch, 'pa-s0', 'stripe', 'CHARGING');
      await expect(
        attempt(scratch, 'pa-s2', 'stripe', 'REQUIRES_CUSTOMER_ACTION', 'pi_2'),
      ).rejects.toThrow(/check constraint/);
      await expect(
        attempt(scratch, 'pa-s3', 'stripe', 'CHARGING', null, 'not-an-account'),
      ).rejects.toThrow(/check constraint/);
    });

    it('at most one Stripe payment names a given intent (other providers unaffected)', async () => {
      await expect(
        attempt(
          scratch,
          'pa-dup',
          'stripe',
          'REQUIRES_CUSTOMER_ACTION',
          'pi_1',
          'acct_1A',
        ),
      ).rejects.toThrow(/unique/);
      await attempt(
        scratch,
        'pa-fake2',
        'fake-two-step',
        'REQUIRES_CUSTOMER_ACTION',
        'fakepi_1',
      );
    });

    it("never changes a Stripe payment's account, intent or provider once recorded", async () => {
      await expect(
        run(
          scratch,
          `UPDATE "PaymentAttempt" SET "providerAccountId" = 'acct_1B' WHERE id = 'pa-s1'`,
        ),
      ).rejects.toThrow(/connected account never changes/);
      await expect(
        run(
          scratch,
          `UPDATE "PaymentAttempt" SET "providerReference" = 'pi_9' WHERE id = 'pa-s1'`,
        ),
      ).rejects.toThrow(/intent never changes/);
      await expect(
        run(
          scratch,
          `UPDATE "PaymentAttempt" SET provider = 'fake' WHERE id = 'pa-s1'`,
        ),
      ).rejects.toThrow(/provider never changes/);
      // The claim records them once, and the payment moves on normally.
      await run(
        scratch,
        `UPDATE "PaymentAttempt" SET "providerAccountId" = 'acct_1C', "providerReference" = 'pi_3', "paymentState" = 'REQUIRES_CUSTOMER_ACTION' WHERE id = 'pa-s0'`,
      );
      await run(
        scratch,
        `UPDATE "PaymentAttempt" SET status = 'SUCCEEDED', "paymentState" = 'SUCCEEDED' WHERE id = 'pa-s1'`,
      );
    });

    it('payment events name their intent and may be kept as UNMATCHED', async () => {
      await event(scratch, 'evt-pi', 'UNMATCHED', 'pi_5');
      await expect(
        event(scratch, 'evt-bad', 'RECEIVED', 'ch_5'),
      ).rejects.toThrow(/check constraint/);
      await expect(event(scratch, 'evt-bogus', 'SOMETHING')).rejects.toThrow(
        /check constraint/,
      );
    });

    it('refuses to apply twice, changing nothing', async () => {
      await expect(
        applyMigrationSql(scratch.url, readFileSync(MIGRATION_SQL, 'utf8')),
      ).rejects.toThrow(/already exists/);
    });

    it('the rollback refuses while Stripe payments or payment events exist, changing nothing', async () => {
      await expect(
        applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
      ).rejects.toThrow(/rollback refused/);
      expect(
        await count(
          scratch,
          `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'PaymentAttempt' AND column_name = 'providerAccountId'`,
        ),
      ).toBe(1);
    });
  });

  describe('preflight with Stripe payments already present', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp04_m3_stripe_intents_pre',
      );
      await applyMigrations(scratch.url, before);
      await attempt(scratch, 'pa-early', 'stripe', 'NOT_SENT');
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('refuses, changing nothing', async () => {
      await expect(
        applyMigrationSql(scratch.url, readFileSync(MIGRATION_SQL, 'utf8')),
      ).rejects.toThrow(/Stripe payment attempts already exist/);
      expect(
        await count(
          scratch,
          `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'PaymentAttempt' AND column_name = 'providerAccountId'`,
        ),
      ).toBe(0);
    });
  });

  describe('rollback with nothing to lose', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp04_m3_stripe_intents_rb',
      );
      await applyMigrations(scratch.url, [...before, ...thisOne]);
      await event(scratch, 'evt-acct', 'PROCESSED');
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('restores the previous shape', async () => {
      await applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8'));
      expect(
        await count(
          scratch,
          `SELECT count(*)::int AS n FROM information_schema.columns
            WHERE (table_name = 'PaymentAttempt' AND column_name = 'providerAccountId')
               OR (table_name = 'RestaurantPaymentProviderEvent' AND column_name IN ('externalObjectId', 'lastAttemptAt'))`,
        ),
      ).toBe(0);
      expect(
        await count(
          scratch,
          `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'stripe_payment_attempt_guard'`,
        ),
      ).toBe(0);
      await expect(event(scratch, 'evt-un', 'UNMATCHED')).rejects.toThrow(
        /check constraint/,
      );
      await event(scratch, 'evt-ok', 'FAILED');
    });
  });
});
