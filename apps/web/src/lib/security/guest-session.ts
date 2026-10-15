// Guest order-tracking session (R1 / S3c).
//
// A guest has no account, so the order's access token is their only
// credential. Instead of carrying it in the page URL and in every poll's query
// string, the web tier keeps it in an HttpOnly cookie: a map of
// { orderId -> accessToken } for the few most recent orders on this browser.
// The tracking URL is then just /order/confirmation/<orderId>.
//
// Binding: a token is only ever looked up by the orderId in the request path
// and forwarded to the API, which independently requires that exact
// (tenant, order, token) triple. A cookie entry for one order therefore cannot
// read another order or another tenant, and a forged/edited cookie grants
// nothing the forger did not already know. Entries are only added after the
// API has accepted the token for that order (see the guest-session route).
//
// The cookie is `__Host-` prefixed in production (no tossing), Secure, Path=/,
// SameSite=Lax (an emailed/shared link must still open signed-in-as-guest) and
// expires after GUEST_SESSION_MAX_AGE_SECONDS.
//
// Pure module: no `server-only`.

import { cookieName, sessionCookieOptions } from "./cookies";

export const GUEST_SESSION_COOKIE_BASE = "mh_guest_orders";
export const GUEST_SESSION_COOKIE = cookieName(GUEST_SESSION_COOKIE_BASE);

// Long enough to come back to a pickup order the same day or the next few;
// a shared fragment link keeps working beyond it.
export const GUEST_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const MAX_TRACKED_ORDERS = 10;

// Shapes only. These bound what is ever placed in a header, URL path or cookie.
const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACCESS_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

export function isValidOrderId(value: unknown): value is string {
  return typeof value === "string" && ORDER_ID.test(value);
}

export function isValidAccessToken(value: unknown): value is string {
  return typeof value === "string" && ACCESS_TOKEN.test(value);
}

// Ordered, most recent first.
export type GuestOrders = ReadonlyArray<readonly [orderId: string, token: string]>;

export function parseGuestSession(raw: string | undefined | null): GuestOrders {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const entries: Array<readonly [string, string]> = [];
    for (const item of parsed) {
      if (
        Array.isArray(item) &&
        item.length === 2 &&
        isValidOrderId(item[0]) &&
        isValidAccessToken(item[1]) &&
        !seen.has(item[0])
      ) {
        seen.add(item[0]);
        entries.push([item[0], item[1]]);
      }
      if (entries.length >= MAX_TRACKED_ORDERS) break;
    }
    return entries;
  } catch {
    return [];
  }
}

export function serializeGuestSession(orders: GuestOrders): string {
  return Buffer.from(JSON.stringify(orders), "utf8").toString("base64url");
}

export function tokenForOrder(
  orders: GuestOrders,
  orderId: string,
): string | null {
  if (!isValidOrderId(orderId)) return null;
  const entry = orders.find(([id]) => id === orderId);
  return entry ? entry[1] : null;
}

// Adds (or refreshes) one order, newest first, capped.
export function withGuestOrder(
  orders: GuestOrders,
  orderId: string,
  token: string,
): GuestOrders {
  if (!isValidOrderId(orderId) || !isValidAccessToken(token)) return orders;
  return [
    [orderId, token] as const,
    ...orders.filter(([id]) => id !== orderId),
  ].slice(0, MAX_TRACKED_ORDERS);
}

export function guestSessionCookieOptions() {
  return sessionCookieOptions(GUEST_SESSION_MAX_AGE_SECONDS);
}

interface CookieWriter {
  set(name: string, value: string, options: object): unknown;
}
interface CookieReader {
  get(name: string): { value: string } | undefined;
}

export function readGuestSession(store: CookieReader): GuestOrders {
  return parseGuestSession(store.get(GUEST_SESSION_COOKIE)?.value);
}

export function writeGuestOrder(
  store: CookieReader & CookieWriter,
  orderId: string,
  token: string,
): void {
  const next = withGuestOrder(readGuestSession(store), orderId, token);
  store.set(
    GUEST_SESSION_COOKIE,
    serializeGuestSession(next),
    guestSessionCookieOptions(),
  );
}
