// ESP-03 PR 6 — the checkout-session cookie.
//
// A food-order payment and all of its retries are bound to a server-owned
// checkout session. The session's token is a bearer secret, so browser code
// never sees it: this web server keeps it in an HttpOnly cookie and adds it
// to the API calls it proxies (see app/api/checkout/session/route.ts and
// app/api/checkout/route.ts). The cookie survives a refresh, a closed tab and
// an interrupted response on this device, so a retry always reaches the same
// checkout and can never start a second charge.
//
// Value: a short list of [locationId, token] pairs, most recent first (a
// visitor may have a checkout open at more than one location). The API binds
// every token to its business, location and customer, so an entry used on
// another restaurant's storefront, or edited by hand, grants nothing.
//
// Attributes: `__Host-` prefixed in production (Secure, Path=/, no Domain,
// so a sibling subdomain cannot set or shadow it), host-only, HttpOnly,
// SameSite=Strict (it is only ever needed by this site's own checkout
// requests), and expires with the token's own recognition window (7 days).
//
// Pure module: no `server-only`.

import type { CheckoutSessionState } from "@mocha-house/contracts";
import { cookieName, isProductionEnv } from "./cookies";

export const CHECKOUT_SESSION_COOKIE_BASE = "mh_checkout";
export const CHECKOUT_SESSION_COOKIE = cookieName(CHECKOUT_SESSION_COOKIE_BASE);
export const CHECKOUT_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const MAX_CHECKOUT_SESSIONS = 5;

const LOCATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CHECKOUT_TOKEN = /^cs_[A-Za-z0-9_-]{43}$/;

export function isValidLocationId(value: unknown): value is string {
  return typeof value === "string" && LOCATION_ID.test(value);
}

export function isValidCheckoutToken(value: unknown): value is string {
  return typeof value === "string" && CHECKOUT_TOKEN.test(value);
}

export type CheckoutSessions = ReadonlyArray<readonly [locationId: string, token: string]>;

export function parseCheckoutSessions(raw: string | undefined | null): CheckoutSessions {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const entries: Array<readonly [string, string]> = [];
    for (const item of parsed) {
      if (
        Array.isArray(item) &&
        item.length === 2 &&
        isValidLocationId(item[0]) &&
        isValidCheckoutToken(item[1]) &&
        !seen.has(item[0])
      ) {
        seen.add(item[0]);
        entries.push([item[0], item[1]]);
      }
      if (entries.length >= MAX_CHECKOUT_SESSIONS) break;
    }
    return entries;
  } catch {
    return [];
  }
}

export function serializeCheckoutSessions(sessions: CheckoutSessions): string {
  return Buffer.from(JSON.stringify(sessions), "utf8").toString("base64url");
}

export function tokenForLocation(sessions: CheckoutSessions, locationId: string): string | null {
  return sessions.find(([id]) => id === locationId)?.[1] ?? null;
}

export function withCheckoutSession(
  sessions: CheckoutSessions,
  locationId: string,
  token: string,
): CheckoutSessions {
  return [
    [locationId, token] as const,
    ...sessions.filter(([id]) => id !== locationId),
  ].slice(0, MAX_CHECKOUT_SESSIONS);
}

export function withoutCheckoutSession(
  sessions: CheckoutSessions,
  locationId: string,
): CheckoutSessions {
  return sessions.filter(([id]) => id !== locationId);
}

export interface CheckoutSessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: "strict";
  path: "/";
  maxAge: number;
}

export function checkoutSessionCookieOptions(
  maxAge: number = CHECKOUT_SESSION_MAX_AGE_SECONDS,
  env: NodeJS.ProcessEnv = process.env,
): CheckoutSessionCookieOptions {
  return {
    httpOnly: true,
    secure: isProductionEnv(env),
    sameSite: "strict",
    path: "/",
    maxAge,
  };
}

interface CookieWriter {
  set(name: string, value: string, options: object): unknown;
}

// Writes the list, or expires the cookie (with its own attributes, so a
// `__Host-` deletion is accepted) when the list is empty.
export function writeCheckoutSessions(store: CookieWriter, sessions: CheckoutSessions): void {
  if (sessions.length === 0) {
    store.set(CHECKOUT_SESSION_COOKIE, "", {
      ...checkoutSessionCookieOptions(0),
      expires: new Date(0),
    });
    return;
  }
  store.set(
    CHECKOUT_SESSION_COOKIE,
    serializeCheckoutSessions(sessions),
    checkoutSessionCookieOptions(),
  );
}

// What browser code learns about its checkout (from /api/checkout/session):
// never the token, never an order access token (a completed order's access
// goes into the HttpOnly guest-session cookie instead).
export interface BrowserCheckoutSession {
  state: CheckoutSessionState;
  acceptsNewPaymentsUntil: string;
  orderId: string | null;
}
