import { Client } from 'pg';

// A session-level advisory lock on a dedicated connection, held for the
// duration of `fn` — across network calls, with NO database transaction open
// (ESP-03 PR 5; shared since ESP-04 M5b by payment recovery and refunds).
// Returns null, and `fn` is not run, when another holder has the lock. The
// lock is released when `fn` ends, or by PostgreSQL if the connection drops.
export async function withSessionLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const client = new Client({ connectionString: lockConnectionString() });
  // A dropped lock connection is surfaced by the next query; never crash.
  client.on('error', () => undefined);
  await client.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [key],
    );
    if (rows[0]?.locked !== true) return null;
    try {
      return await fn();
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key])
        .catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

// The connection string for a plain `pg` client (Prisma's `schema` query
// parameter is not one `pg` understands).
export function lockConnectionString(): string {
  const raw = process.env.DATABASE_URL!;
  try {
    const url = new URL(raw);
    url.searchParams.delete('schema');
    return url.toString();
  } catch {
    return raw;
  }
}
