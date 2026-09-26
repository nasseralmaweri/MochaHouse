import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import { TEST_TENANT_B_ID } from '@mocha-house/testing';

// Milestone S0C — static guards on how the tenant foundation may be used.
// These fail the build if application source (not tests) starts treating
// Mocha House as an implicit default, reads SINGLE_TENANT_ID outside its
// resolvers, or depends on the test-only Tenant B fixture.
const repoRoot = join(__dirname, '../../../..');
const appSourceRoots = ['apps/api/src', 'apps/worker/src'].map((dir) =>
  join(repoRoot, dir),
);

function applicationSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (path.endsWith('.ts') && !path.endsWith('.spec.ts')) {
        files.push(path);
      }
    }
  };
  appSourceRoots.forEach(walk);
  return files;
}

function filesMatching(pattern: RegExp): string[] {
  return applicationSourceFiles()
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(repoRoot, file).replace(/\\/g, '/'))
    .sort();
}

describe('Tenant foundation boundaries', () => {
  it('scans real application source', () => {
    expect(applicationSourceFiles().length).toBeGreaterThan(100);
  });

  it('no application source names Tenant #1 — there is no default tenant', () => {
    expect(
      filesMatching(
        new RegExp(
          `TENANT_1_MOCHA_HOUSE|${TENANT_1_MOCHA_HOUSE_ID}|ensureTenantOne`,
        ),
      ),
    ).toEqual([]);
  });

  it('only the single-tenant resolvers read SINGLE_TENANT_ID', () => {
    // Actual reads: the env-name constant, or process.env access by name.
    expect(
      filesMatching(
        /SINGLE_TENANT_ID_ENV|process\.env(\.|\[\s*['"`])SINGLE_TENANT_ID/,
      ),
    ).toEqual([
      'apps/api/src/tenancy/single-tenant-resolution.provider.ts',
      'apps/worker/src/tenancy/single-tenant-resolution.provider.ts',
    ]);
  });

  it('application source never depends on the test-only Tenant B fixture', () => {
    expect(
      filesMatching(new RegExp(`@mocha-house/testing|${TEST_TENANT_B_ID}`)),
    ).toEqual([]);
  });

  it('the testing package is a devDependency only', () => {
    for (const app of ['apps/api', 'apps/worker']) {
      const pkg = JSON.parse(
        readFileSync(join(repoRoot, app, 'package.json'), 'utf8'),
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(pkg.dependencies?.['@mocha-house/testing']).toBeUndefined();
      expect(pkg.devDependencies?.['@mocha-house/testing']).toBe('workspace:*');
    }
  });
});
