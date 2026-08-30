// Fails loudly and specifically the moment a required internal-auth
// configuration value is actually needed, rather than at module wiring
// time — so an unconfigured internal Cognito/dev boundary never silently
// no-ops, but also never blocks unrelated app startup. A separate copy of
// the customer boundary's require-env for the same isolation reason the
// rest of this module keeps its own low-level helpers.
export function requireInternalEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is not set.`);
  }
  return value;
}
