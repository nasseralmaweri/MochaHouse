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
//
// SC3c-3 — the ONE exception is the separate CENTERIVO billing notice
// pipeline (src/billing-notifications): its notices are ABOUT the business's
// subscription, so it reads it. It shares no code path with the restaurant
// notification pipeline (pinned below), so a plan change still never touches
// a queued restaurant notification.
const SOURCE_ROOT = join(__dirname, '..');
const BILLING_NOTICES = join(SOURCE_ROOT, 'billing-notifications');
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
    if (path === BILLING_NOTICES) return [];
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

describe('SC3c-3: CENTERIVO billing notices are a separate pipeline', () => {
  it('the restaurant pipeline never imports the billing notice pipeline, nor it the outbox or restaurant dispatch', () => {
    const restaurant = sourceFiles(SOURCE_ROOT);
    expect(
      restaurant.filter(
        (file) =>
          /billing-notifications/.test(readFileSync(file, 'utf8')) &&
          !file.endsWith('app.module.ts'),
      ),
    ).toEqual([]);
    const billing = readdirSync(BILLING_NOTICES)
      .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.spec.ts'))
      .map((entry) => readFileSync(join(BILLING_NOTICES, entry), 'utf8'));
    expect(billing.length).toBeGreaterThan(0);
    for (const text of billing) {
      expect(text).not.toMatch(
        /outbox-processor|notification-dispatch|OutboxEvent|NotificationDelivery/,
      );
    }
  });
});
