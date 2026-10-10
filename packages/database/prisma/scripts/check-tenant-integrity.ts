// Security 4C-1 — READ-ONLY tenant relationship integrity report.
//
//   DATABASE_URL=... pnpm --filter @mocha-house/database integrity:check [--json] [--samples N]
//
// Checks every relationship in src/integrity/relationship-inventory.ts and
// prints counts per relationship type plus the primary keys of a few
// offending rows (never row contents). The session is forced read-only
// before any query and the checker's own transaction is READ ONLY and
// rolled back, so it modifies nothing; a role with SELECT only is enough.
// The connection string is never printed.
//
// Exit codes: 0 = no violations (warnings allowed), 1 = violations found,
// 2 = the check could not run.
import 'dotenv/config';
import { Client } from 'pg';
import {
  checkTenantIntegrity,
  formatTenantIntegrityReport,
} from '../../src/integrity';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    return 2;
  }
  const samples = Number(argValue('--samples') ?? '5');
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
  } catch {
    console.error('Could not connect to the database.');
    return 2;
  }
  try {
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    const report = await checkTenantIntegrity(client, {
      sampleLimit: Number.isFinite(samples) ? samples : 5,
    });
    console.log(
      process.argv.includes('--json')
        ? JSON.stringify(report, null, 2)
        : formatTenantIntegrityReport(report),
    );
    return report.violations > 0 ? 1 : 0;
  } catch (error) {
    console.error(
      `The integrity check failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return 2;
  } finally {
    await client.end();
  }
}

main().then(
  (code) => process.exit(code),
  () => process.exit(2),
);
