import { isSafeDevAuthContext } from '../../config/dev-auth-context';

// SC1a — the platform-operator boundary's own provider switch, configured
// independently of the customer (AUTH_PROVIDER) and tenant-staff
// (INTERNAL_AUTH_PROVIDER) boundaries. The local/test-only platform provider
// is selected only when BOTH hold, checked fresh on every call:
//   - the environment is a verified safe development context
//     (config/dev-auth-context.ts — the same classifier the startup guard
//     uses), and
//   - PLATFORM_AUTH_PROVIDER is exactly "dev".
// Anything else selects the dedicated platform Cognito pool — including in
// production, where a "dev" value additionally refuses startup
// (config/auth-startup-guard.ts). There is no fallback from Cognito to dev.
export function isDevPlatformAuthEnabled(): boolean {
  return (
    process.env.PLATFORM_AUTH_PROVIDER === 'dev' &&
    isSafeDevAuthContext(process.env)
  );
}
