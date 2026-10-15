# Secure guest order tracking (R1 / S3c)

A guest can follow an order without an account. The order's access token is the
only credential, so the aim is that it never sits in a page URL, a poll's query
string, a Referer, a log line or browser history.

## The experience

1. Checkout succeeds. The **web server** (not the browser) puts the token in an
   HttpOnly cookie and the page goes to `/order/confirmation/<orderId>` — a clean URL.
2. The page polls `/api/orders/<orderId>/status` (same origin, no credential in
   the request). Everything from S2 is unchanged: auto-refresh, freshness
   indicator, degraded/offline recovery, stop on a terminal status.
3. Reload, back/forward and a bookmark of the clean URL all work **on that browser**.
4. **Another device**: "Copy tracking link" gives
   `/order/confirmation/<orderId>#t=<token>`. The fragment is never sent to a
   server or in a Referer. Opening it starts a session there and the fragment is
   removed from the address bar and history.
5. **Old links** (`?token=...`, from before this change) still open: the page
   exchanges the token for the cookie and rewrites the URL to the clean form.

## Why this design (and what was rejected)

* Moving the token from the query to a header alone does not help: the page URL
  would still hold it (history, Referer, shared screenshots, server logs). So the
  credential moves to an HttpOnly cookie that script cannot read.
* The cookie is set by the **checkout proxy on the server**, so the token never
  needs to reach the URL, and the checkout response body is unchanged
  (compatible with existing clients).
* A cookie cannot be scoped per order by the browser, so it holds a small map
  `{orderId -> token}` (newest first, at most 10). The server only ever looks a
  token up **by the order id in the request path** and the API independently
  requires the exact (tenant, order, token); one order's entry cannot read
  another order or another tenant, and a forged or edited cookie gives a forger
  nothing they did not already hold.
* Fragments are used only for deliberate sharing: they carry the credential but
  are never transmitted. They are not used for ordinary navigation because they
  would put a reusable credential in history and screenshots.
* A cookie alone cannot cover "open on my phone", hence the explicit copy-link
  action (the only place the token is handed to page script, POST + origin
  checked, never cached).

## Security model

| Concern | Control |
|---|---|
| Cookie | `__Host-mh_guest_orders` in production (Secure, `Path=/`, no Domain → no tossing); plain name in dev. HttpOnly, SameSite=Lax (links from email must open), 7-day expiry. |
| Fixation / planting | A token is stored only after the API accepts it for that exact order; wrong/unknown/malformed → identical `404`, nothing set. |
| Enumeration | No cookie, no entry for the order, wrong token, unknown order, tampered cookie: the same `404 {"message":"Order not found."}`; no API call is made without a credential. |
| Brute force | Bootstrap and polling go through the API's S3a order-status limits (per order, unsuccessful lookups per client IP — signed client IP is forwarded — and per tenant). |
| CSRF / origin | Bootstrap and share-link are POST routes behind the S3b `rejectUntrustedOrigin` check; status is a read-only GET. |
| Caching | Status, bootstrap and share-link responses are `no-store`; the confirmation page and `/api` are `no-store`/`no-referrer` (S3b headers); the API status response is `no-store`. |
| Logging | The API receives the token in the `X-Order-Access-Token` header, not a URL. The web app never logs it. Legacy `?token=` links are still sent to the web server once on arrival (unavoidable) and are rewritten immediately. |
| Tenant isolation | The API still resolves the tenant server-side and requires `(tenantId, orderId, token)`; the cookie is per host, so each tenant domain has its own jar. |
| Replay | A copied tracking link or cookie works until the cookie/link is discarded — inherent to bearer credentials; the token only reveals that order's status. |

## Compatibility strategy

* `GET /api/v1/orders/:id?accessToken=` still works (**deprecated**) so nothing
  that already calls the API breaks; the web app no longer uses it. The header
  wins when both are sent. Plan to remove the query form once old links and
  clients age out.
* Legacy `/order/confirmation/<id>?token=` links are converted on first visit.
* The checkout API response (including `accessToken`) is unchanged.

## Deployment prerequisites

* `CSRF_ALLOWED_ORIGINS` is not needed for a normal single-origin deployment
  (own origin is derived from `X-Forwarded-Host`/`Host` and
  `X-Forwarded-Proto`); behind a proxy make sure it forwards those headers
  correctly. Verify in staging.
* HTTPS is required for the `__Host-` cookie in production.
* Configure the client-IP forwarding (S3a) so per-client limits on lookups apply.

## Limits

* Cookie holds the 10 most recent orders (roughly 1.2 KB); older ones need their shared link. The cookie is read-modify-written per request, so two simultaneous bootstraps or a bootstrap racing a checkout can drop one entry; the customer simply reopens the link. Someone who sends a victim many `#t=` links for their own orders could push the victim's entries out of the cap (nothing is read across orders); the victim reopens their original link.
* Sign-out/clear-cookies on a shared device ends tracking there; the order
  itself is unaffected.
* An XSS on the web origin could call the share-link route; the S3b header and
  origin protections reduce but do not remove that.

## Launch requirement: client-IP forwarding

The API limits unsuccessful lookups per client IP (S3a). Without the web tier's
signed client-IP forwarding (`CLIENT_IP_FORWARD_SECRET`, `CLIENT_IP_HEADER`,
`CLIENT_IP_TRUSTED_HOPS`), every guest lookup reaches the API from the web
server's address, so one abuser could use up that shared failure budget and
cause 429s for real customers. Configure forwarding before launch; the
per-tenant and per-order limits still apply regardless.

## Deprecation

The API's `?accessToken=` fallback should be removed (with a usage log first)
once old links have aged out; until then legacy `?token=` links still send the
token to the web server once on arrival.
