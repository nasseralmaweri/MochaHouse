import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// SC2b, owner decision B6 — a notification already queued for an operation
// the API accepted (an order, a job application, a franchise inquiry) is
// always delivered, even if the business's plan later loses that module.
// Refused operations never create an outbox event in the first place (the
// API refuses them before writing anything), so the worker has nothing to
// gate. This pins that the worker never consults subscription or
// entitlement data: a plan change must never strand or drop a queued
// notification.
const SOURCE_ROOT = join(__dirname, '..');
const FORBIDDEN = [
  /tenantSubscription/,
  /tenantModuleGrant/,
  /subscriptionPlan/,
  /Entitlement/,
  /StorefrontFeature/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return entry.endsWith('.ts') && !entry.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('worker notification delivery is independent of the business plan (SC2b B6)', () => {
  it('no worker source reads subscription or entitlement data', () => {
    const files = sourceFiles(SOURCE_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return FORBIDDEN.some((pattern) => pattern.test(text));
    });
    expect(offenders).toEqual([]);
  });
});
