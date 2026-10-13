import { isSafeDevAuthContext } from '../../config/dev-auth-context';

// Mirrors the customer boundary's auth-provider-mode.ts fail-closed
// convention, but with its OWN environment variable so the two boundaries
// are configured independently: the local/test-only internal auth provider
// (no live AWS Cognito required) is selected only when BOTH hold, checked
// fresh on every call — never cached, never assumed from a previous check.
//   - The environment is a verified safe development context
//     (config/dev-auth-context.ts): no production-like signal in NODE_ENV or
//     the deployment variables, AND either a declared isolated test run or
//     NODE_ENV=development with ALLOW_DEV_AUTH=1 on a loopback database. An
//     unset or unknown NODE_ENV is not safe. This is the same classifier the
//     startup validation (config/auth-startup-guard.ts) uses.
//   - INTERNAL_AUTH_PROVIDER is exactly "dev" — a safe context is never
//     sufficient by itself.
// Any other/unset INTERNAL_AUTH_PROVIDER value always selects the real
// internal Cognito boundary, including in production. AUTH_PROVIDER (the
// customer switch) has no effect here.
export function isDevInternalAuthEnabled(): boolean {
  return (
    process.env.INTERNAL_AUTH_PROVIDER === 'dev' &&
    isSafeDevAuthContext(process.env)
  );
}
