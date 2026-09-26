// The fixed, environment-independent id of Tenant #1 (Mocha House).
//
// The same value is written literally in the migration that creates the
// Tenant table (20260926233828_add_tenant_foundation), and it is what
// SINGLE_TENANT_ID is configured to today. S0D backfills, seeds and future
// recovery tooling reference it from here.
//
// NOT a default. Application request/worker paths must never import this
// to fill in a missing tenant — they receive a TenantContext from a
// resolver, and a missing context is an error. A test
// (well-known-tenants.spec.ts in apps/api) fails if this constant is
// referenced from API or worker source outside the allow-listed files.
export const TENANT_1_MOCHA_HOUSE_ID = '01a0db02-f800-7000-8000-000000000001';

export const TENANT_1_MOCHA_HOUSE_SLUG = 'mocha-house';
export const TENANT_1_MOCHA_HOUSE_NAME = 'Mocha House';
