import { isSafeDevAuthContext } from '../../config/dev-auth-context';

// Fail-closed convention (shared with the internal-auth boundary's
// internal-auth-provider-mode.ts): the local/test-only auth boundary (no
// live AWS Cognito required) is only ever selected when BOTH conditions
// hold, checked fresh on every call — never cached, never assumed from a
// previous check.
//   - The environment is a verified safe development context
//     (config/dev-auth-context.ts): no production-like signal in NODE_ENV or
//     the deployment variables, AND either a declared isolated test run or
//     NODE_ENV=development with ALLOW_DEV_AUTH=1 on a loopback database. An
//     unset or unknown NODE_ENV is not safe. This is the same classifier the
//     startup validation (config/auth-startup-guard.ts) uses.
//   - AUTH_PROVIDER is exactly "dev" — a safe context is never sufficient by
//     itself.
// Any other/unset AUTH_PROVIDER value always selects the real Cognito
// boundary, including in production.
export function isDevCustomerAuthEnabled(): boolean {
  return (
    process.env.AUTH_PROVIDER === 'dev' && isSafeDevAuthContext(process.env)
  );
}
