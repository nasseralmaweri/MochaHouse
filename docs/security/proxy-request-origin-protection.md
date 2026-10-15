# Proxy and request-origin protection (R1 / S3b)

Protects the web app's cookie-authenticated `/api/*` route handlers (which turn
an HttpOnly session cookie into a bearer token for the API) against forged
cross-site requests and path escape. Code: `apps/web/src/lib/security/`.

## Threat model

The API is bearer-only, so it has no CSRF exposure of its own. The exposure is
the web tier: a browser attaches the session cookie to *any* request it makes,
including one a hostile page triggers. Next.js checks `Origin` for Server
Actions but **not** for route handlers. `SameSite=Lax` does not close this:
it separates *sites*, not *origins*, so a sibling subdomain, another port on
the same host, or an XSS on any same-site property is still trusted.

## State-changing requests (`request-origin.ts`)

Every POST/PUT/PATCH/DELETE handler under `app/api` calls
`rejectUntrustedOrigin(request)` first. It is accepted only when:

1. the custom header `x-centerivo-request: 1` is present (a cross-site page
   cannot add it without a CORS preflight, which this app never answers);
2. `Sec-Fetch-Site`, if present, is `same-origin` or `none`;
3. `Origin`, if present, equals the request's own origin or an entry of
   `CSRF_ALLOWED_ORIGINS`;
4. at least one of `Sec-Fetch-Site` / `Origin` is present. A request with
   neither is refused (these proxies serve only the app's own pages; there is
   no legitimate non-browser caller).

Refusal is a generic `403 {"message":"Request not allowed."}`. GET/HEAD/OPTIONS
are not gated. The own origin is whatever host the browser addressed, so it
works for any tenant domain with no configuration.

Browser code reaches the proxies through `lib/security/marked-fetch.ts`
(`api-client.ts` and `GiftCardsClient.tsx` import it as `fetch`): it adds the
header to non-safe calls to same-origin `/api/` URLs and never to any other
host. A spec scans `app/api` and fails if a mutating handler lacks the guard.

Covered: admin catch-all, media upload, checkout, checkout-quote, loyalty
rewards, gift-card balance/purchase/purchase-intents, careers apply,
franchising inquiry. Server Actions keep Next's built-in Origin check;
`CSRF_ALLOWED_ORIGINS` hosts are also passed to
`experimental.serverActions.allowedOrigins`.

## Admin proxy path safety (`path-safety.ts`)

The WHATWG URL parser collapses dot segments, so
`<api>/admin/../internal/me` silently becomes `<api>/internal/me` (verified).
Segments are now rejected (404) if, after repeated decoding (bounded), they are
empty, `.`/`..`, only dots/space, or contain a separator, backslash, `;`,
control character or NUL; and the rebuilt URL must still be on the API origin
under `<apiBase>/admin/`. Observed behaviour: Next itself normalises decoded
`%2e%2e` in the request URL before routing (404 page, handler never runs);
`..%2f` and double-encoded forms *do* reach the handler and are refused there.

## Cookies (`cookies.ts`)

In production the cookies are `__Host-mh_customer_session`,
`__Host-mh_internal_session`, `__Host-mh_admin_business`,
`__Host-mh_admin_location`: Secure, `Path=/`, no `Domain`, so a sibling
subdomain cannot overwrite them (cookie tossing). Attributes otherwise
unchanged: HttpOnly, `SameSite=Lax` (Strict would break links from email),
original `maxAge`. Outside production the plain names are used so local http
development works.

There is deliberately **no fallback** to the old plain names in production: a
fallback would accept an attacker-planted cookie. Legacy names are deleted on
sign-in and sign-out.

**Compatibility:** deploying signs every user holding an old-name cookie out
once (and clears their saved business/location choice). Acceptable before
launch; schedule it outside peak hours afterwards.

## Response headers (`headers.ts`, wired in `next.config.ts`)

All responses: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Content-Security-Policy: frame-ancestors 'none'` (framing only; **no** full CSP,
which needs separate validation against inline scripts and image hosts),
`Referrer-Policy: strict-origin-when-cross-origin`, a restrictive
`Permissions-Policy`. `/order/confirmation/*` and `/account/*`:
`Referrer-Policy: no-referrer`, `Cache-Control: no-store`. `/api/*`:
`Cache-Control: no-store`. `X-Powered-By` removed. HSTS is **opt-in**
(`HSTS_MAX_AGE_SECONDS`) because it is only correct once every host is HTTPS.

## Configuration

| Variable | Meaning |
|---|---|
| `CSRF_ALLOWED_ORIGINS` | Optional comma-separated extra trusted origins (scheme + host), e.g. a front proxy. Empty by default. |
| `HSTS_MAX_AGE_SECONDS` | Optional; enables `Strict-Transport-Security`. |

## Reuse (S3c guest tracking session)

`checkRequestOrigin` / `rejectUntrustedOrigin` take only a method, headers and
origin, so a future guest-session route can use them unchanged;
`sessionCookieOptions` and `cookieName` give it the same `__Host-` handling.

## Deployment notes

- **Behind a TLS-terminating or Host-rewriting proxy** the origin the app sees
  (`http://internal-host`) can differ from the browser's (`https://site`).
  The check then fails closed (403 on every mutation). Set
  `CSRF_ALLOWED_ORIGINS` to the public origin(s) and verify in staging before
  launch.
- `__Host-` cookies need HTTPS: a production build served over plain http
  (some e2e harnesses, Safari on http) cannot store them. Use `next dev`, or
  HTTPS, for those.
- Sign-out expires the `__Host-` cookie with its original `Secure`/`Path`
  attributes; a bare delete is ignored by browsers for this prefix (covered by a
  spec against Next's real cookie jar).

## Remaining limitations

- No full CSP (needs inline-script/nonce work and its own validation).
- Anonymous public forms (careers, franchising) are origin-checked, so a
  non-browser client cannot call them through the web app.
- A same-origin XSS defeats all of these; it is outside this layer.
- HSTS, the allowed-origins list and the client-IP topology are deployment
  decisions still to be made.
