// Mirrors orders/infrastructure/dev-internal.guard.ts's fail-closed
// convention: the local/test-only auth boundary (no live AWS Cognito
// required) is only ever selected when BOTH conditions hold, checked fresh
// on every call — never cached, never assumed from a previous check.
//   - NODE_ENV is not "production" — an absolute floor, not overridable.
//   - AUTH_PROVIDER is exactly "dev" — being non-production is never
//     sufficient by itself.
// Any other/unset AUTH_PROVIDER value always selects the real Cognito
// boundary, including in production.
export function isDevCustomerAuthEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' && process.env.AUTH_PROVIDER === 'dev'
  );
}
