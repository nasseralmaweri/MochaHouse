// Mirrors the customer boundary's auth-provider-mode.ts fail-closed
// convention, but with its OWN environment variable so the two boundaries
// are configured independently: the local/test-only internal auth provider
// (no live AWS Cognito required) is selected only when BOTH hold, checked
// fresh on every call — never cached, never assumed from a previous check.
//   - NODE_ENV is not "production" — an absolute floor, not overridable.
//   - INTERNAL_AUTH_PROVIDER is exactly "dev" — being non-production is
//     never sufficient by itself.
// Any other/unset INTERNAL_AUTH_PROVIDER value always selects the real
// internal Cognito boundary, including in production. AUTH_PROVIDER (the
// customer switch) has no effect here.
export function isDevInternalAuthEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.INTERNAL_AUTH_PROVIDER === 'dev'
  );
}
