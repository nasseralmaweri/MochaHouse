import { isValidTenantId } from './tenant-id';

// Who (or what) is executing within a tenant. The discriminator exists so
// that future member / platform-support / worker / system execution is
// distinguishable in diagnostics, audit and enforcement without reshaping
// TenantContext (S0B ADR-4 / ADR-5).
//
//   member    — an authenticated staff membership (TenantSession, S0F).
//   support   — a platform support/incident session (ADR-5, S0N).
//   customer  — an authenticated tenant customer (ADR-1/2, S0G).
//   anonymous — an HTTP request whose tenant was established WITHOUT binding
//               an authenticated principal to it. Every S0C API request is
//               this: the existing auth guards still authenticate on their
//               own, but that identity is not yet tenant-bound.
//   worker    — background processing (outbox dispatch, future jobs).
//   system    — bootstrap/maintenance execution (seed, migrations tooling).
export const TENANT_PRINCIPAL_TYPES = [
  'member',
  'support',
  'customer',
  'anonymous',
  'worker',
  'system',
] as const;

export type TenantPrincipalType = (typeof TENANT_PRINCIPAL_TYPES)[number];

// The server-controlled statement "this execution is operating inside
// exactly this one tenant". It is established ONLY by a server-side resolver
// (S0C: the validated SINGLE_TENANT_ID for HTTP requests; S0D-2C-2: a
// worker event's own persisted tenantId for background processing; later:
// TenantSession, host/domain resolution, a support session) — never from a
// client-supplied tenant id. Consumers must not know or care which
// resolver produced it.
//
// Deliberately minimal. Identity fields (internalUserId, staffIdentityId)
// are added when TenantSession exists (S0F) rather than faked here.
export interface TenantContext {
  readonly tenantId: string;
  readonly principalType: TenantPrincipalType;
  readonly requestId: string;
}

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

// The only way to construct a TenantContext. Fails closed on anything
// malformed, and returns a frozen value so no consumer can re-point an
// existing context at another tenant.
export function createTenantContext(input: {
  tenantId: string;
  principalType: TenantPrincipalType;
  requestId: string;
}): TenantContext {
  if (!isValidTenantId(input.tenantId)) {
    throw new TenantContextError(
      'A TenantContext requires a canonical lowercase UUID tenant id.',
    );
  }
  if (!(TENANT_PRINCIPAL_TYPES as readonly string[]).includes(input.principalType)) {
    throw new TenantContextError(
      `Unknown tenant principal type "${String(input.principalType)}".`,
    );
  }
  if (typeof input.requestId !== 'string' || input.requestId.trim().length === 0) {
    throw new TenantContextError('A TenantContext requires a request id.');
  }

  return Object.freeze({
    tenantId: input.tenantId,
    principalType: input.principalType,
    requestId: input.requestId,
  });
}
