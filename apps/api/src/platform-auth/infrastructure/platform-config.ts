// SC1a — platform-boundary configuration, read fresh when a request needs
// it. A missing or unsafe value fails the REQUEST closed (503, see
// PlatformAuthGuard) rather than refusing API startup, so the platform
// boundary can ship before its Cognito pool exists without affecting any
// tenant route. The startup guard (config/auth-startup-guard.ts) adds the
// production-time checks.

export class PlatformAuthNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformAuthNotConfiguredError';
  }
}

export function requirePlatformEnv(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    throw new PlatformAuthNotConfiguredError(`${name} is not set.`);
  }
  return value;
}

// The platform pool and app client must be dedicated: never the customer's
// or the tenant staff's. A token is bound to exactly one pool (issuer) and
// app client (audience), so sharing either would let one population's
// tokens reach the other's boundary.
export function platformCognitoConfig(): {
  userPoolId: string;
  clientId: string;
} {
  const userPoolId = requirePlatformEnv('PLATFORM_COGNITO_USER_POOL_ID');
  const clientId = requirePlatformEnv('PLATFORM_COGNITO_CLIENT_ID');
  const others = {
    pools: [
      process.env.COGNITO_USER_POOL_ID,
      process.env.INTERNAL_COGNITO_USER_POOL_ID,
    ],
    clients: [
      process.env.COGNITO_CLIENT_ID,
      process.env.INTERNAL_COGNITO_CLIENT_ID,
    ],
  };
  if (others.pools.some((pool) => pool?.trim() === userPoolId)) {
    throw new PlatformAuthNotConfiguredError(
      'PLATFORM_COGNITO_USER_POOL_ID must be a dedicated pool, not the customer or staff pool.',
    );
  }
  if (others.clients.some((client) => client?.trim() === clientId)) {
    throw new PlatformAuthNotConfiguredError(
      'PLATFORM_COGNITO_CLIENT_ID must be a dedicated app client, not the customer or staff client.',
    );
  }
  return { userPoolId, clientId };
}
