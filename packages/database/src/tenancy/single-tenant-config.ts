import { isValidTenantId } from './tenant-id';

// S0C — the transitional single-tenant resolver's configuration.
//
// SINGLE_TENANT_ID names the ONE tenant this deployment currently operates
// as. It is explicit configuration, never inferred: there is no default,
// no "fall back to Mocha House", and no silent recovery. A missing,
// malformed or unknown value is a startup failure. Later milestones replace
// this resolver with TenantSession / host / event resolution; nothing
// outside the resolvers should ever read SINGLE_TENANT_ID.
export const SINGLE_TENANT_ID_ENV = 'SINGLE_TENANT_ID';

export class TenantConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantConfigurationError';
  }
}

export interface SingleTenantResolution {
  readonly tenantId: string;
}

// `findTenant` is the persistence lookup (by exact id), injected so this
// stays framework- and client-agnostic.
export async function resolveSingleTenant(
  rawValue: string | undefined,
  findTenant: (tenantId: string) => Promise<{ id: string } | null>,
): Promise<SingleTenantResolution> {
  if (rawValue === undefined || rawValue.trim() === '') {
    throw new TenantConfigurationError(
      `${SINGLE_TENANT_ID_ENV} is not configured. Set it to the id of the tenant this deployment operates as.`,
    );
  }

  // No trimming/lower-casing "repair": the configured value must already be
  // the exact canonical id, so what is configured is what is used.
  if (!isValidTenantId(rawValue)) {
    throw new TenantConfigurationError(
      `${SINGLE_TENANT_ID_ENV} must be a canonical lowercase UUID.`,
    );
  }

  const tenant = await findTenant(rawValue);
  if (!tenant || tenant.id !== rawValue) {
    throw new TenantConfigurationError(
      `${SINGLE_TENANT_ID_ENV} does not reference an existing tenant.`,
    );
  }

  return Object.freeze({ tenantId: tenant.id });
}
