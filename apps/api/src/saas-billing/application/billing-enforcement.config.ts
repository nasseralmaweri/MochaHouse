// SC3c-1 — billing enforcement is OFF unless explicitly enabled for an
// environment (BILLING_ENFORCEMENT_ENABLED=1); enabling it anywhere
// persistent needs separate approval. While off, billing state still moves
// exactly as in SC3b, but nothing is enforced on the business: no
// suspension is applied or lifted, no entitlement changes, and the expiry
// sweep does nothing.
export const BILLING_ENFORCEMENT_ENV = 'BILLING_ENFORCEMENT_ENABLED';
export const BILLING_ENFORCEMENT_SWEEP_INTERVAL_ENV =
  'BILLING_ENFORCEMENT_SWEEP_INTERVAL_MS';

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MIN_SWEEP_INTERVAL_MS = 30 * 1000;

export function billingEnforcementEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[BILLING_ENFORCEMENT_ENV] === '1';
}

export function billingEnforcementSweepIntervalMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[BILLING_ENFORCEMENT_SWEEP_INTERVAL_ENV];
  if (raw === undefined || raw === '') return DEFAULT_SWEEP_INTERVAL_MS;
  const value = Number(raw);
  return Number.isInteger(value) && value >= MIN_SWEEP_INTERVAL_MS
    ? value
    : DEFAULT_SWEEP_INTERVAL_MS;
}
