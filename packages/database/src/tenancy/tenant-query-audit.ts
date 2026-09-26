import { Prisma } from '../generated/prisma/client';
import { classifyModel } from './model-tenancy';
import { getCurrentTenantContext } from './tenant-context-store';
import type { TenantContext, TenantPrincipalType } from './tenant-context';

// S0C — the REPORT-ONLY tenant query safety check (S0B §14).
//
// Observes every model query and records, for tenant-owned models, whether
// it ran inside a TenantContext and whether it carried its own tenant
// predicate. It exists to produce the baseline of code paths S0D/S0E must
// convert. It is purely an observer:
//   - it never modifies, adds to, or re-routes a query (the original `args`
//     object is passed through untouched);
//   - it never supplies a tenant id — not from the context, not from
//     configuration, not "Mocha House";
//   - it never blocks a query. Enforcement (throwing on a tenant-owned query
//     with no matching tenant predicate) arrives per model in S0E.
// Observations never contain query arguments, so no customer data, codes,
// tokens or payment details can reach a log through this path.

export type TenantQueryAuditMode = 'off' | 'report';

export class TenantQueryAuditConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantQueryAuditConfigurationError';
  }
}

// TENANT_QUERY_AUDIT: unset -> 'report' (the safe, informative default);
// 'off' | 'report' explicit; anything else fails startup rather than
// silently disabling the check through a typo.
export function parseTenantQueryAuditMode(
  raw: string | undefined,
): TenantQueryAuditMode {
  if (raw === undefined || raw.trim() === '') {
    return 'report';
  }
  const value = raw.trim();
  if (value === 'off' || value === 'report') {
    return value;
  }
  throw new TenantQueryAuditConfigurationError(
    `TENANT_QUERY_AUDIT must be "off" or "report" (got "${raw}").`,
  );
}

export interface TenantQueryObservation {
  model: string;
  operation: string;
  // 'unclassified' means Prisma reported a model MODEL_TENANCY does not know
  // — treated as reportable, never as platform data.
  classification: 'tenant' | 'unclassified';
  contextPresent: boolean;
  tenantId: string | null;
  principalType: TenantPrincipalType | null;
  requestId: string | null;
  // Whether the query itself carried a top-level `tenantId` in its filter
  // or data. Always false until S0D adds the column; recorded now so the
  // same observation shape serves the S0E enforcement switch.
  tenantPredicate: boolean;
}

function hasOwnTenantId(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, 'tenantId')
  );
}

function carriesTenantPredicate(args: unknown): boolean {
  if (typeof args !== 'object' || args === null) {
    return false;
  }
  const { where, data, create } = args as {
    where?: unknown;
    data?: unknown;
    create?: unknown;
  };
  if (hasOwnTenantId(where) || hasOwnTenantId(create)) {
    return true;
  }
  if (Array.isArray(data)) {
    return data.length > 0 && data.every(hasOwnTenantId);
  }
  return hasOwnTenantId(data);
}

// Pure: derives an observation (or null for platform-plane models) from a
// query. Reads `args` but never writes to it.
export function observeTenantQuery(
  model: string | undefined,
  operation: string,
  args: unknown,
  context: TenantContext | undefined,
): TenantQueryObservation | null {
  const classification = classifyModel(model);
  if (classification === 'platform') {
    return null;
  }
  return {
    model: model ?? '(unknown)',
    operation,
    classification: classification === 'tenant' ? 'tenant' : 'unclassified',
    contextPresent: context !== undefined,
    tenantId: context?.tenantId ?? null,
    principalType: context?.principalType ?? null,
    requestId: context?.requestId ?? null,
    tenantPredicate: carriesTenantPredicate(args),
  };
}

export interface TenantQueryAuditSummary {
  signature: string;
  model: string;
  operation: string;
  classification: TenantQueryObservation['classification'];
  contextPresent: boolean;
  tenantPredicate: boolean;
  count: number;
}

// In-process aggregation keyed by (classification, model, operation,
// context presence, predicate presence). Counts every observation and
// reports whether an observation is the first of its signature, so callers
// can log each distinct unguarded code path once instead of on every query.
export class TenantQueryAuditRecorder {
  private readonly summaries = new Map<string, TenantQueryAuditSummary>();

  record(observation: TenantQueryObservation): boolean {
    const signature = [
      observation.classification,
      observation.model,
      observation.operation,
      observation.contextPresent ? 'context' : 'no-context',
      observation.tenantPredicate ? 'tenant-predicate' : 'no-tenant-predicate',
    ].join('|');

    const existing = this.summaries.get(signature);
    if (existing) {
      existing.count += 1;
      return false;
    }
    this.summaries.set(signature, {
      signature,
      model: observation.model,
      operation: observation.operation,
      classification: observation.classification,
      contextPresent: observation.contextPresent,
      tenantPredicate: observation.tenantPredicate,
      count: 1,
    });
    return true;
  }

  snapshot(): TenantQueryAuditSummary[] {
    return [...this.summaries.values()]
      .map((summary) => ({ ...summary }))
      .sort((a, b) => a.signature.localeCompare(b.signature));
  }

  reset(): void {
    this.summaries.clear();
  }
}

// Process-wide recorder shared by every client in the process, so a baseline
// can be read from one place regardless of how many PrismaService instances
// a process (or a test run) constructs.
export const tenantQueryAuditRecorder = new TenantQueryAuditRecorder();

export interface TenantQueryAuditOptions {
  recorder?: TenantQueryAuditRecorder;
  // Called once per distinct signature with the FIRST observation of it.
  onFirstObservation?: (observation: TenantQueryObservation) => void;
}

// The Prisma client extension. Attach with `client.$extends(...)`. With
// mode 'off' it is not attached at all (see createTenantQueryAudit callers).
export function tenantQueryAuditExtension(options: TenantQueryAuditOptions = {}) {
  const recorder = options.recorder ?? tenantQueryAuditRecorder;
  const onFirstObservation = options.onFirstObservation;

  return Prisma.defineExtension({
    name: 'tenant-query-audit',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          try {
            const observation = observeTenantQuery(
              model,
              operation,
              args,
              getCurrentTenantContext(),
            );
            if (observation && recorder.record(observation)) {
              onFirstObservation?.(observation);
            }
          } catch {
            // Diagnostics must never change query behaviour — an observer
            // failure is swallowed, the query proceeds exactly as issued.
          }
          return query(args);
        },
      },
    },
  });
}
