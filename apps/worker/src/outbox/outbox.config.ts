// R1 / S4b — configuration of the reliable notification worker. Every value is
// validated at startup and a malformed one REFUSES to start rather than falling
// back to something looser (same convention as the API's rate-limit config).

export const OUTBOX_CONFIG = Symbol('OUTBOX_CONFIG');

export interface OutboxConfig {
  // Master switch. false = the worker boots (health, migrations check) but
  // claims nothing. Default true; set OUTBOX_WORKER_ENABLED=0 during a cut-over.
  readonly enabled: boolean;
  // Independent claim loops in THIS process. Each loop handles one event at a
  // time, so this is also the maximum number of simultaneous provider calls.
  readonly concurrency: number;
  // How long an idle loop waits before asking for work again.
  readonly pollIntervalMs: number;
  // Lease length. Must comfortably exceed one attempt (resolve + send).
  readonly leaseSeconds: number;
  // Provider call timeout. A timeout is an AMBIGUOUS outcome.
  readonly sendTimeoutMs: number;
  // A send is only begun if at least this much lease is left, so a send can
  // never outlive its lease.
  readonly minLeaseRemainingMs: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
  // How long shutdown waits for in-flight attempts to finish.
  readonly shutdownGraceMs: number;
  // Events created before this instant are never claimed (they are left for an
  // operator to classify at cut-over; see docs/operations). null = no cut-off.
  readonly historicalCutoff: Date | null;
  readonly workerId: string;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a whole number (got "${raw}").`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new Error(
      `${name} must be between ${min} and ${max} (got ${value}).`,
    );
  }
  return value;
}

// Fail-safe: anything that is not CLEARLY a development or test environment
// (including an unset or misspelt NODE_ENV such as "prod") is treated as
// production-like.
export function isProductionLike(env: NodeJS.ProcessEnv): boolean {
  const mode = (env.NODE_ENV ?? '').trim().toLowerCase();
  return !['development', 'test', 'local'].includes(mode);
}

// The kill switch is strict: a typo must not start a worker.
function parseSwitch(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error(`${name} must be 0, 1, true or false (got "${raw}").`);
}

export function loadOutboxConfig(
  env: NodeJS.ProcessEnv = process.env,
  hostname = 'worker',
  pid: number = process.pid,
): OutboxConfig {
  const cutoffRaw = env.OUTBOX_HISTORICAL_CUTOFF;
  let historicalCutoff: Date | null = null;
  if (cutoffRaw !== undefined && cutoffRaw !== '' && cutoffRaw !== 'none') {
    const parsed = new Date(cutoffRaw);
    // A zone designator (Z or +hh:mm) is mandatory: without one the instant
    // would silently depend on the host's local time zone.
    if (
      Number.isNaN(parsed.getTime()) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(
        cutoffRaw,
      )
    ) {
      throw new Error(
        `OUTBOX_HISTORICAL_CUTOFF must be an ISO-8601 timestamp with a time zone, for example 2026-10-20T14:00:00Z (got "${cutoffRaw}").`,
      );
    }
    // A cut-off in the future would hold back every new event: almost
    // certainly a typo. (A few minutes of clock skew are tolerated.)
    if (parsed.getTime() > Date.now() + 5 * 60_000) {
      throw new Error(
        `OUTBOX_HISTORICAL_CUTOFF (${cutoffRaw}) is in the future; events created before it are never sent, so this would hold back new notifications.`,
      );
    }
    historicalCutoff = parsed;
  }

  const enabled = parseSwitch(env, 'OUTBOX_WORKER_ENABLED', true);
  // Production-like environments must say how pre-existing PENDING events are
  // treated; processing them unclassified could email customers about old
  // orders. Declaring "none" explicitly is allowed.
  if (
    enabled &&
    isProductionLike(env) &&
    historicalCutoff === null &&
    env.OUTBOX_HISTORICAL_CUTOFF !== 'none'
  ) {
    throw new Error(
      'OUTBOX_HISTORICAL_CUTOFF is required in production-like environments: set an ISO-8601 instant (events created earlier are left for operator classification) or "none" once the PENDING backlog has been classified. See docs/operations/notification-worker-cutover.md.',
    );
  }

  const config: OutboxConfig = {
    enabled,
    concurrency: integer(env, 'OUTBOX_CONCURRENCY', 2, 1, 10),
    pollIntervalMs: integer(env, 'OUTBOX_POLL_INTERVAL_MS', 2000, 100, 60_000),
    leaseSeconds: integer(env, 'OUTBOX_LEASE_SECONDS', 60, 20, 600),
    sendTimeoutMs: integer(env, 'OUTBOX_SEND_TIMEOUT_MS', 10_000, 1000, 60_000),
    minLeaseRemainingMs: 0,
    maxAttempts: integer(env, 'OUTBOX_MAX_ATTEMPTS', 7, 1, 20),
    backoffBaseMs: integer(
      env,
      'OUTBOX_BACKOFF_BASE_MS',
      30_000,
      100,
      3_600_000,
    ),
    backoffCapMs: integer(
      env,
      'OUTBOX_BACKOFF_CAP_MS',
      6 * 3_600_000,
      1000,
      24 * 3_600_000,
    ),
    shutdownGraceMs: integer(
      env,
      'OUTBOX_SHUTDOWN_GRACE_MS',
      20_000,
      1000,
      120_000,
    ),
    historicalCutoff,
    workerId: `${hostname}:${pid}`,
  };
  if (config.backoffCapMs < config.backoffBaseMs) {
    throw new Error(
      'OUTBOX_BACKOFF_CAP_MS must not be below OUTBOX_BACKOFF_BASE_MS.',
    );
  }
  // The send timeout plus a safety margin must fit inside the lease.
  const minLeaseRemainingMs = config.sendTimeoutMs + 5000;
  if (config.leaseSeconds * 1000 < minLeaseRemainingMs * 2) {
    throw new Error(
      'OUTBOX_LEASE_SECONDS is too short for OUTBOX_SEND_TIMEOUT_MS: the lease must be at least twice (send timeout + 5 s).',
    );
  }
  return { ...config, minLeaseRemainingMs };
}
