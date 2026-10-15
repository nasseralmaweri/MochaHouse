// Request-origin protection for cookie-authenticated proxy routes (R1 / S3b).
//
// The web app's route handlers turn an HttpOnly session cookie into a bearer
// token for the API. Browsers attach that cookie to any request the user's
// browser makes, including ones a hostile page triggers, so every
// state-changing handler must establish that the request really came from this
// application's own pages. Next.js does this for Server Actions but not for
// route handlers. SameSite=Lax alone is not enough: it does not separate
// "same site" from "same origin", so a sibling subdomain or another port on the
// same host is still trusted.
//
// A mutating request is accepted only when ALL hold:
//   1. it carries the custom header (REQUEST_MARKER_HEADER). A cross-site page
//      cannot add a custom header without a CORS preflight, and this app never
//      answers preflights, so the browser blocks it before it is sent;
//   2. Sec-Fetch-Site, when present, is `same-origin` (or `none`, a
//      user-initiated navigation); `same-site` and `cross-site` are refused;
//   3. Origin, when present, matches this app's own origin or an explicitly
//      allowed one (CSRF_ALLOWED_ORIGINS, a comma-separated list);
//   4. at least one of Sec-Fetch-Site / Origin is present. A request with
//      neither is not from a current browser fetch, and these proxies serve
//      only the app's own pages, so it is refused rather than guessed at.
//
// Safe methods (GET/HEAD/OPTIONS) are not state-changing and pass.
// The refusal is a generic 403 that does not say which check failed.
//
// Tenant-agnostic: the own origin is whatever host the browser addressed, so it
// works unchanged for any tenant domain. Reusable by the later guest-session
// work.

export const REQUEST_MARKER_HEADER = "x-centerivo-request";
export const REQUEST_MARKER_VALUE = "1";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type OriginRefusalReason =
  | "missing-marker"
  | "fetch-site"
  | "origin-mismatch"
  | "no-browser-headers";

export type OriginDecision =
  | { ok: true }
  | { ok: false; reason: OriginRefusalReason };

export function parseAllowedOrigins(
  value: string | undefined | null,
): string[] {
  if (!value) return [];
  const origins: string[] = [];
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      const url = new URL(trimmed);
      if (url.protocol === "http:" || url.protocol === "https:") {
        origins.push(url.origin);
      }
    } catch {
      // A malformed entry grants nothing.
    }
  }
  return origins;
}

interface HeaderReader {
  get(name: string): string | null;
}

export interface OriginCheckInput {
  method: string;
  headers: HeaderReader;
  // The origin this request was addressed to (scheme + host).
  ownOrigin: string;
  allowedOrigins?: readonly string[];
}

export function checkRequestOrigin(input: OriginCheckInput): OriginDecision {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { ok: true };

  if (input.headers.get(REQUEST_MARKER_HEADER) !== REQUEST_MARKER_VALUE) {
    return { ok: false, reason: "missing-marker" };
  }

  const fetchSite = input.headers.get("sec-fetch-site");
  const origin = input.headers.get("origin");

  if (fetchSite !== null) {
    const site = fetchSite.trim().toLowerCase();
    if (site !== "same-origin" && site !== "none") {
      return { ok: false, reason: "fetch-site" };
    }
  }

  if (origin !== null) {
    const trusted = [input.ownOrigin, ...(input.allowedOrigins ?? [])];
    if (!trusted.includes(origin.trim())) {
      return { ok: false, reason: "origin-mismatch" };
    }
  }

  if (fetchSite === null && origin === null) {
    return { ok: false, reason: "no-browser-headers" };
  }
  return { ok: true };
}

interface OriginCheckableRequest {
  method: string;
  headers: HeaderReader;
  nextUrl: { origin: string };
}

// For route handlers: returns a generic 403 to send, or null to continue.
export function rejectUntrustedOrigin(
  request: OriginCheckableRequest,
  allowedOrigins: readonly string[] = parseAllowedOrigins(
    process.env.CSRF_ALLOWED_ORIGINS,
  ),
): Response | null {
  const decision = checkRequestOrigin({
    method: request.method,
    headers: request.headers,
    ownOrigin: request.nextUrl.origin,
    allowedOrigins,
  });
  if (decision.ok) return null;
  return new Response(JSON.stringify({ message: "Request not allowed." }), {
    status: 403,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

// Headers a same-origin browser fetch must send on a mutating proxy call.
export const REQUEST_MARKER_HEADERS: Readonly<Record<string, string>> = {
  [REQUEST_MARKER_HEADER]: REQUEST_MARKER_VALUE,
};
