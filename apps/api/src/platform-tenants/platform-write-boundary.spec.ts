import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MODEL_TENANCY } from '@mocha-house/database';

// SC1d (D6) — the platform plane READS business data; exactly ONE platform
// file may WRITE a business's own (tenant-owned) rows: the provisioning
// service. Any other platform source that calls a write on a tenant-owned
// model, or runs raw SQL that writes, fails this test until it is reviewed.

const SRC = join(__dirname, '..');
const PLATFORM_DIRS = ['platform-auth', 'platform-tenants'];
// SC1e — plus the lifecycle service (owner email correction only).
const ALLOWED_WRITERS = [
  join('platform-tenants', 'application', 'tenant-lifecycle.service.ts'),
  join('platform-tenants', 'application', 'tenant-provisioning.service.ts'),
];
const WRITES =
  '(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)';

const tenantModelAccessors = Object.entries(MODEL_TENANCY)
  .filter(([, tenancy]) => tenancy === 'tenant')
  .map(([model]) => model.charAt(0).toLowerCase() + model.slice(1));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return entry.endsWith('.ts') && !entry.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('SC1d platform write boundary', () => {
  const files = PLATFORM_DIRS.flatMap((dir) => sourceFiles(join(SRC, dir)));
  const writeOf = new RegExp(
    `\\.(${tenantModelAccessors.join('|')})\\s*\\.\\s*${WRITES}\\s*\\(`,
  );
  const rawWrite = /\$executeRaw/;

  it('scans the platform sources (and knows the tenant-owned models)', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(tenantModelAccessors).toEqual(
      expect.arrayContaining(['internalUser', 'internalRole', 'location']),
    );
  });

  it('only the provisioning and lifecycle services write tenant-owned rows', () => {
    const writers = files
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return writeOf.test(source) || rawWrite.test(source);
      })
      .map((file) => relative(SRC, file));
    expect(writers.sort()).toEqual([...ALLOWED_WRITERS].sort());
  });
});
