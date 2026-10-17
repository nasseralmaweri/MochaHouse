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

// SC4a — migration 20261106090000_owner_registration, on scratch databases:
// a registration's email is normalised; it records a login before leaving
// PENDING_VERIFICATION; VERIFIED carries the legal acceptance; the recorded
// login never changes, VERIFIED is final and a registration with a login is
// never deleted; and a rollback that refuses while any registration exists
// and otherwise removes exactly what the migration added.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261106090000_owner_registration.down.sql',
);
const NONCE = 'a'.repeat(64);

jest.setTimeout(120_000);

describe('SC4a owner registration migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  const query = (text: string, params: unknown[] = []) =>
    withScratchClient(scratch.url, (c) =>
      c.query<Record<string, unknown> & { id: string }>(text, params),
    );
  const insert = (columns: string, values: string) =>
    query(
      `INSERT INTO "OwnerRegistration" (id, "initialPasswordNonce", "expiresAt", "updatedAt", ${columns})
       VALUES (gen_random_uuid()::text, '${NONCE}', now() + interval '1 day', now(), ${values}) RETURNING id`,
    );

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4a_migration',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('keeps a registration well-formed', async () => {
    const ok = `'owner@example.com', 'internal-dev'`;
    await insert(`email, "identityProvider"`, ok);
    // Not normalised, an unknown provider, a duplicate email.
    for (const values of [
      `'Owner2@example.com', 'internal-dev'`,
      `' owner3@example.com', 'internal-dev'`,
      `'owner4@example.com', 'platform-dev'`,
      ok,
    ]) {
      await expect(
        insert(`email, "identityProvider"`, values),
      ).rejects.toThrow();
    }
    // Past PENDING_VERIFICATION only with a login; VERIFIED only with the
    // name, the legal acceptance and when.
    await expect(
      insert(
        `email, "identityProvider", status`,
        `'owner5@example.com', 'internal-dev', 'PASSWORD_SETUP'`,
      ),
    ).rejects.toThrow();
    await expect(
      insert(
        `email, "identityProvider", "identitySubject", status, "verifiedAt"`,
        `'owner6@example.com', 'internal-dev', 's6', 'VERIFIED', now()`,
      ),
    ).rejects.toThrow();
    await insert(
      `email, "identityProvider", "identitySubject", status, "verifiedAt", "displayName",
       "termsVersion", "privacyVersion", "legalAcceptedAt"`,
      `'owner7@example.com', 'internal-dev', 's7', 'VERIFIED', now(), 'Owner',
       'terms-1', 'privacy-1', now()`,
    );
    // One registration per login.
    await expect(
      insert(
        `email, "identityProvider", "identitySubject"`,
        `'owner8@example.com', 'internal-dev', 's7'`,
      ),
    ).rejects.toThrow();
  });

  it('never changes a recorded login, never reopens a finished registration and never deletes one with a login', async () => {
    const id = (
      await insert(
        `email, "identityProvider"`,
        `'guard@example.com', 'internal-dev'`,
      )
    ).rows[0].id;
    const update = (sql: string) =>
      query(`UPDATE "OwnerRegistration" SET ${sql} WHERE id = $1`, [id]);

    await update(`"identitySubject" = 'guard-subject'`);
    await expect(update(`"identitySubject" = 'other'`)).rejects.toThrow();
    await expect(update(`"identitySubject" = NULL`)).rejects.toThrow();
    await expect(update(`email = 'other@example.com'`)).rejects.toThrow();
    await expect(
      update(`"initialPasswordNonce" = '${'b'.repeat(64)}'`),
    ).rejects.toThrow();
    await update(`status = 'PASSWORD_SETUP'`);
    await expect(update(`status = 'PENDING_VERIFICATION'`)).rejects.toThrow();
    await update(
      `status = 'VERIFIED', "verifiedAt" = now(), "displayName" = 'G',
       "termsVersion" = 't', "privacyVersion" = 'p', "legalAcceptedAt" = now()`,
    );
    await expect(update(`status = 'PASSWORD_SETUP'`)).rejects.toThrow();
    await expect(update(`"termsVersion" = 't2'`)).rejects.toThrow();
    await expect(
      query(`DELETE FROM "OwnerRegistration" WHERE id = $1`, [id]),
    ).rejects.toThrow();

    // A registration that never got a login may be removed.
    const bare = (
      await insert(
        `email, "identityProvider"`,
        `'bare@example.com', 'internal-dev'`,
      )
    ).rows[0].id;
    await query(`DELETE FROM "OwnerRegistration" WHERE id = $1`, [bare]);
  });

  it('the rollback refuses while any registration exists', async () => {
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    expect(
      (
        await query(
          `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'OwnerRegistration'`,
        )
      ).rows[0],
    ).toEqual({ n: 1 });
  });

  it('the rollback removes exactly what the migration added when nothing exists', async () => {
    const clean = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4a_rollback_clean',
    );
    try {
      await applyMigrations(clean.url, listMigrations(MIGRATIONS));
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      const left = await withScratchClient(
        clean.url,
        async (c) =>
          (
            await c.query<{ name: string }>(
              `SELECT table_name AS name FROM information_schema.tables WHERE table_name = 'OwnerRegistration'
             UNION ALL
             SELECT proname FROM pg_proc WHERE proname = 'guard_owner_registration'
             UNION ALL
             SELECT typname FROM pg_type WHERE typname = 'OwnerRegistrationStatus'`,
            )
          ).rows,
      );
      expect(left).toEqual([]);
    } finally {
      await clean.drop();
    }
  });
});
