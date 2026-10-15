// Baseline response security headers (R1 / S3b), applied through
// next.config.ts `headers()` so they cover pages and route handlers alike.
//
// Deliberately NOT a full Content-Security-Policy: the app has inline scripts
// and third-party image hosts, and an unvalidated CSP breaks pages. Only the
// framing directive is set, which is safe and independent of page content.

export interface HeaderEntry {
  key: string;
  value: string;
}

export interface HeaderRule {
  source: string;
  headers: HeaderEntry[];
}

export const BASELINE_HEADERS: readonly HeaderEntry[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
];

// Pages whose URL carries a capability (an order-tracking token) must not leak
// it in a Referer header or be stored by shared caches.
export const PRIVATE_URL_HEADERS: readonly HeaderEntry[] = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cache-Control", value: "no-store" },
];

export const API_ROUTE_HEADERS: readonly HeaderEntry[] = [
  { key: "Cache-Control", value: "no-store" },
];

// HSTS is opt-in: it is only correct once the deployment serves HTTPS on every
// host it covers, which this repository cannot know.
export function hstsHeader(env: NodeJS.ProcessEnv = process.env): HeaderEntry[] {
  const raw = env.HSTS_MAX_AGE_SECONDS;
  if (!raw || !/^\d+$/.test(raw)) return [];
  const maxAge = Number(raw);
  if (maxAge <= 0) return [];
  return [{ key: "Strict-Transport-Security", value: `max-age=${maxAge}` }];
}

export function buildHeaderRules(
  env: NodeJS.ProcessEnv = process.env,
): HeaderRule[] {
  return [
    {
      source: "/:path*",
      headers: [...BASELINE_HEADERS, ...hstsHeader(env)],
    },
    // The confirmation URL carries the order id (a tracking capability); account
    // pages are per-customer.
    { source: "/order/confirmation/:path*", headers: [...PRIVATE_URL_HEADERS] },
    { source: "/account/:path*", headers: [...PRIVATE_URL_HEADERS] },
    { source: "/api/:path*", headers: [...API_ROUTE_HEADERS] },
  ];
}
