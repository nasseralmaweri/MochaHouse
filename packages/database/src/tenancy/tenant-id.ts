// Tenant ids are canonical lowercase UUID strings (the same `@default(uuid(7))`
// string ids every other model uses). Validation is deliberately strict —
// lowercase only, correct version/variant nibbles — because a tenant id is
// compared as a plain string everywhere (Tenant.id is `String`, not a native
// uuid column), so "the same" UUID in a different case would silently be a
// different tenant.
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isValidTenantId(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID.test(value);
}
