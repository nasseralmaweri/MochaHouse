import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@mocha-house/database';
import type { PrismaService } from './prisma.service';

// Security follow-up F-2 — a Serializable transaction that re-runs on a
// serialization failure instead of surfacing it.
//
// Under SERIALIZABLE, PostgreSQL aborts one of two transactions that would
// otherwise produce an outcome no sequential order could (SQLSTATE 40001;
// 40P01 for a deadlock). That is not a business outcome — it means "this
// attempt lost a race, its reads are stale". The correct response is to
// run the whole transaction again from a fresh snapshot: the re-run then reaches the decision the request would
// have reached had it run after the winner (for example "already has that
// access" or "assignment not found"), so the caller sees the same answers
// as with sequential requests.
//
// Only serialization failures and deadlocks are retried by default.
// Prisma 7 with the pg driver adapter reports them in more than one shape,
// all recognised here (verified against Prisma 7.9 / PostgreSQL 16):
//   - P2034 (PrismaClientKnownRequestError) when a statement inside the
//     transaction is refused;
//   - a bare DriverAdapterError whose cause has kind
//     "TransactionWriteConflict" (SQLSTATE 40001) when the refusal comes at
//     COMMIT — it carries no Prisma error code at all;
//   - the raw SQLSTATE (40001 / 40P01) on the driver error's cause, which
//     is how a deadlock (not mapped by the adapter) arrives.
// Business conflicts are never retried here: they are the transaction's
// own decisions (thrown HttpExceptions) and pass straight through, as does
// any other database error (for example a unique violation, P2002). A
// caller may name further errors that mean "re-decide from fresh data"
// (`retryIf`), for example a unique violation on the very rows the
// transaction checks for. Everything else propagates unchanged.
//
// After MAX_ATTEMPTS lost races the request fails with a generic 503 —
// never a database message — and changes nothing (every attempt rolled
// back). Attempts are spaced by a short, jittered, capped backoff so
// simultaneous losers do not collide again in lock-step. Each lost race means
// another transaction committed, so a burst of N simultaneous requests needs
// at most N-1 retries; MAX_ATTEMPTS covers a burst well beyond what an
// administration screen produces.

export const SERIALIZABLE_MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 10;
const MAX_DELAY_MS = 250;

export const CONCURRENT_CHANGE_MESSAGE =
  'This change could not be completed because of other changes made at the same time. Please try again.';

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);

// Checked structurally (not `instanceof Prisma.PrismaClientKnownRequestError`)
// for the same reason as isUniqueConstraintViolation in the loyalty
// service: the error can surface through a different module identity — and
// at COMMIT it is not a Prisma error at all.
export function isSerializationFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as {
    code?: unknown;
    cause?: unknown;
    meta?: { driverAdapterError?: { cause?: unknown } };
  };
  if (e.code === 'P2034') return true;
  for (const cause of [e.cause, e.meta?.driverAdapterError?.cause]) {
    if (typeof cause !== 'object' || cause === null) continue;
    const c = cause as {
      kind?: unknown;
      originalCode?: unknown;
      code?: unknown;
    };
    if (c.kind === 'TransactionWriteConflict') return true;
    if (
      RETRYABLE_SQLSTATES.has(String(c.originalCode)) ||
      RETRYABLE_SQLSTATES.has(String(c.code))
    ) {
      return true;
    }
  }
  return false;
}

export interface SerializableOptions {
  readonly retryIf?: (error: unknown) => boolean;
  readonly maxAttempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runSerializable<T>(
  prisma: Pick<PrismaService, '$transaction'>,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  options: SerializableOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? SERIALIZABLE_MAX_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: 'Serializable',
      });
    } catch (error) {
      const retryable =
        isSerializationFailure(error) || (options.retryIf?.(error) ?? false);
      if (!retryable) throw error;
      if (attempt >= maxAttempts) {
        throw new ServiceUnavailableException(CONCURRENT_CHANGE_MESSAGE);
      }
      await sleep(
        Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1)) +
          Math.random() * BASE_DELAY_MS,
      );
    }
  }
}
