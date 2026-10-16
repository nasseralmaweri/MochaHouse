import { cookieName, isProductionEnv } from "@/lib/security/cookies";

// SC1b — the CENTERIVO platform-operator cookies. A SEPARATE set from the
// customer (lib/auth) and tenant-staff (lib/internal-auth) sessions: other
// names, other API boundary, never interchangeable.
//
//   session    — the platform ID token (after password AND TOTP), HttpOnly,
//                for at most the token's own lifetime (Cognito: 1 hour; no
//                refresh token is ever stored, so a session ends with it).
//   challenge  — the opaque, single-use handle to the server-side sign-in
//                challenge (the API holds the Cognito session and, on a
//                first sign-in, the authenticator secret); 3 minutes.
//
// Both are HttpOnly (never readable by browser JavaScript), Secure and
// __Host- prefixed in production, and SameSite=Strict: the platform console
// is never entered from another site with a session attached.
//
// Pure module (no server-only) so specs can import it.

export const PLATFORM_SESSION_COOKIE_BASE = "cx_platform_session";
export const PLATFORM_CHALLENGE_COOKIE_BASE = "cx_platform_challenge";

export const PLATFORM_CHALLENGE_MAX_AGE_SECONDS = 180;
// The cookie may never outlive the token inside it; it expires a little
// earlier so a page never renders with a token about to lapse mid-request.
const SESSION_EXPIRY_MARGIN_SECONDS = 60;
const SESSION_MAX_SECONDS = 3600;

export interface PlatformCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: "strict";
  path: "/";
  maxAge: number;
}

export function platformCookieName(
  base: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return cookieName(base, env);
}

export function platformCookieOptions(
  maxAge: number,
  env: NodeJS.ProcessEnv = process.env,
): PlatformCookieOptions {
  return {
    httpOnly: true,
    secure: isProductionEnv(env),
    sameSite: "strict",
    path: "/",
    maxAge,
  };
}

export function platformSessionMaxAge(expiresInSeconds: number): number {
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(SESSION_MAX_SECONDS, Math.floor(expiresInSeconds)) -
      SESSION_EXPIRY_MARGIN_SECONDS,
  );
}

interface CookieStore {
  set(name: string, value: string, options: object): unknown;
}

// Expired with the attributes it was set with (a bare delete() omits Secure,
// which browsers reject for a __Host- cookie).
export function clearPlatformCookie(
  store: CookieStore,
  base: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  store.set(platformCookieName(base, env), "", {
    ...platformCookieOptions(0, env),
    expires: new Date(0),
  });
}
