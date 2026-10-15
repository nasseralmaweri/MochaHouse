// Session-cookie naming and attributes (R1 / S3b).
//
// In production every cookie is issued as `__Host-<name>`: browsers then only
// accept it when it is Secure, has Path=/ and carries no Domain attribute, so
// a sibling subdomain (or a man-in-the-middle on plain HTTP) can neither
// overwrite nor shadow it ("cookie tossing"). Outside production the plain
// name is used because a __Host- cookie cannot be set over http://localhost.
//
// There is deliberately NO fallback that also reads the legacy plain name in
// production: a fallback would let an attacker-planted plain cookie be used and
// defeat the protection. The legacy names are cleared on sign-in and sign-out
// instead. (Deploying this signs everyone in with the old cookie out once.)
//
// Pure module: no `server-only`, so route handlers, server actions and specs
// can all import it.

const HOST_PREFIX = "__Host-";

export function isProductionEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.NODE_ENV === "production";
}

export function cookieName(
  base: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return isProductionEnv(env) ? `${HOST_PREFIX}${base}` : base;
}

// The names to remove when a cookie is cleared: the current one plus the
// pre-S3b plain name, so an old cookie cannot linger after sign-out.
export function cookieNamesToClear(
  base: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const current = cookieName(base, env);
  return current === base ? [base] : [current, base];
}

export interface SessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
}

// Lax (not Strict) so a deep link from an email or another site still arrives
// signed in. State-changing requests are protected by lib/security/request-origin
// and the server-action origin check, not by SameSite alone.
export function sessionCookieOptions(
  maxAge: number,
  env: NodeJS.ProcessEnv = process.env,
): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: isProductionEnv(env),
    sameSite: "lax",
    path: "/",
    maxAge,
  };
}

interface CookieStore {
  set(name: string, value: string, options: object): unknown;
  delete(name: string): unknown;
}

// A bare delete() emits "Expires=1970" WITHOUT Secure, and browsers reject any
// __Host- Set-Cookie lacking Secure (deletions included), so the cookie would
// survive sign-out. The current name is therefore expired with the same
// attributes it was set with; only the legacy plain name uses delete().
export function clearSessionCookie(
  store: CookieStore,
  base: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const current = cookieName(base, env);
  store.set(current, "", { ...sessionCookieOptions(0, env), expires: new Date(0) });
  if (current !== base) store.delete(base);
}

// On sign-in: remove a pre-S3b plain-named cookie (production only), so it
// cannot linger beside the new __Host- one.
export function clearLegacySessionCookie(
  store: CookieStore,
  base: string,
): void {
  if (cookieName(base) !== base) store.delete(base);
}
