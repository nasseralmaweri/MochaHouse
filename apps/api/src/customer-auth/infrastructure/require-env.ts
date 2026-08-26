// Fails loudly and specifically the moment a required configuration value
// is actually needed, rather than at module wiring time — so an
// unconfigured Cognito/dev auth boundary never silently no-ops, but also
// never blocks unrelated app startup (e.g. an e2e smoke test that never
// touches an authenticated route).
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is not set.`);
  }
  return value;
}
