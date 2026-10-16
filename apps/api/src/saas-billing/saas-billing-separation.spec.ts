import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// SC3a — SaaS subscription billing (charging BUSINESSES for CENTERIVO) must
// stay completely separate from restaurant/customer payments (charging a
// business's CUSTOMERS). This pins both directions at the source level:
//   * saas-billing never imports the restaurant payment boundary, checkout,
//     orders, gift cards, loyalty, promotions or the PaymentProvider types,
//     and never reads PAYMENT_PROVIDER configuration;
//   * no restaurant-payment module imports saas-billing.
// The database side is pinned by the relationship inventory (no billing
// table references PaymentAttempt, orders or refunds).
const SRC = join(__dirname, '..');
const BILLING = join(SRC, 'saas-billing');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return files(path);
    return entry.endsWith('.ts') && !entry.endsWith('.spec.ts') ? [path] : [];
  });
}

const RESTAURANT_PAYMENT_DIRS = [
  'payment',
  'orders',
  'gift-cards',
  'loyalty',
  'promotions',
];

// Any module specifier (import / export-from / require / dynamic import)
// naming a restaurant-payment directory at any depth, with or without a
// trailing path.
const RESTAURANT_SPECIFIER =
  /(?:from|require\(|import\()\s*['"][^'"]*(?:^|\/)(?:payment|orders|gift-cards|loyalty|promotions|checkout|refunds?)(?:\/[^'"]*)?['"]/;

const FORBIDDEN_IN_BILLING = [
  RESTAURANT_SPECIFIER,
  /PaymentProvider\b/,
  /PAYMENT_PROVIDER\b/,
  /PaymentAttempt/i,
  /paymentAttempt/,
  /chargeAttempt/,
];

describe('SaaS billing is separate from restaurant payments (SC3a)', () => {
  it('saas-billing never reaches restaurant payment code or configuration', () => {
    const offenders: string[] = [];
    for (const file of files(BILLING)) {
      const text = readFileSync(file, 'utf8')
        // Comments may name the boundary they keep apart from.
        .replace(/^\s*\/\/.*$/gm, '');
      for (const pattern of FORBIDDEN_IN_BILLING) {
        if (pattern.test(text)) {
          offenders.push(`${relative(SRC, file)} matches ${pattern}`);
        }
      }
    }
    expect(files(BILLING).length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it('no restaurant payment module imports saas-billing', () => {
    const offenders: string[] = [];
    for (const dir of RESTAURANT_PAYMENT_DIRS) {
      for (const file of files(join(SRC, dir))) {
        if (/saas-billing/.test(readFileSync(file, 'utf8'))) {
          offenders.push(relative(SRC, file).split(sep).join('/'));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // SC3b — the Stripe SDK is the SaaS billing account's client only: no other
  // module (in particular no restaurant payment code) imports it, so a
  // future restaurant processor can never share this client or its keys.
  it('only saas-billing imports the Stripe SDK', () => {
    const offenders = files(SRC)
      .filter((file) => !file.startsWith(BILLING + sep))
      .filter((file) =>
        /(?:from|require\(|import\()\s*['"]stripe(?:\/[^'"]*)?['"]/.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => relative(SRC, file).split(sep).join('/'));
    expect(offenders).toEqual([]);
  });
});
