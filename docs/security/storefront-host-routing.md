# Storefront host routing (SC4f-1)

CENTERIVO serves each business's public storefront at its own address. SC4f-1
adds the secure foundation for that: an approved hostname registry, server-side
resolution of the business from the hostname, and an authenticated web-to-API
storefront context. It ships **off**.

## Rollout switch

| Setting (API and web) | Default | Meaning |
| --- | --- | --- |
| `STOREFRONT_HOST_ROUTING_ENABLED` | off | Off: every storefront request is the deployment's single business (`SINGLE_TENANT_ID`), exactly as before SC4f. Storefront headers are ignored and the web app reads no request header for this. |
| `STOREFRONT_CONTEXT_SECRET` | unset | Shared HMAC secret, at least 32 characters, separate from `CLIENT_IP_FORWARD_SECRET`. Required when routing is on: the API refuses to start without it, and the web app refuses to sign without it. |
| `STOREFRONT_FORWARDED_HOST_HEADER` (web) | unset | Unset: the hostname is the `Host` header. Set it only when your own edge proxy rewrites `Host` and passes the original in a header it controls. |
| `STOREFRONT_FORWARDED_HOST_TRUSTED_HOPS` (web) | 1 | How many of your proxies append to that header; the hostname is read that many entries from the end. |

Turn routing on for the API and the web app together, and only after the
business's addresses (including Mocha House's existing addresses, as `LEGACY`
rows) are registered and published. **With routing on there is no default
business:** the legacy business is served only at its own registered
addresses.

## Approved hostname registry (`StorefrontHost`)

Platform data (no `tenantId`; it references the business as
`storefrontTenantId`, like `TenantSubscription`).

- `hostname` is unique and is checked by the database to be a normalized DNS
  name (lower case, no port, no trailing dot, labels of 1–63 characters, never
  an IP address) or `localhost`. Matching is exact.
- `kind`: `PLATFORM_SUBDOMAIN` (`{slug}.{storefront domain}`), `LEGACY` (an
  existing address kept), `CUSTOM` (a business's own domain — the schema
  supports it; it is not managed yet).
- `published` / `publishedAt` (always consistent). Only a published hostname
  resolves; unpublishing takes effect on the next request.
- A database guard refuses any change to `hostname`, `storefrontTenantId`,
  `kind`, `id` or `createdAt`, and any delete or truncate: an address that once
  served a business never silently starts serving another. The owning business
  cannot be deleted while it has hostnames.
- Rows are written only by platform operators. The audited operator controls
  (`storefront.manage`, recent sign-in, written reason, history) arrive with
  SC4f-3, together with the publishing checks; SC4f-1 adds no API that writes
  the registry.

Rollback: `packages/database/prisma/rollbacks/20261110090000_storefront_hosts.down.sql`
(refuses while any row exists).

## How a storefront request is resolved

1. The browser calls the web app at the storefront's address. It never calls
   the storefront API directly: the cart's menu revalidation now goes through
   the web app's `/api/locations/:id/menu` route, so the API's address is no
   longer sent to the browser (`NEXT_PUBLIC_API_URL` is unused).
2. Every server-side storefront API call (Server Components, Server Actions,
   route handlers) goes through `storefrontApiFetch`
   (`apps/web/src/lib/storefront-context.ts`). With routing on it adds:
   - `x-centerivo-storefront-host` — the normalized hostname of the incoming
     request;
   - `x-centerivo-storefront-ts` — the current time in seconds;
   - `x-centerivo-storefront-sig` — HMAC-SHA256 over
     `storefront-host:v1:{seconds}:{hostname}`,
   overriding any value a caller set, and disables caching for the call.
3. `TenantContextMiddleware` verifies the context (exact headers, normalized
   hostname, 60-second window, constant-time comparison) and passes **only the
   verified hostname** to `StorefrontHostHttpContextResolver`, which looks it
   up in the registry.
4. No business — a missing, forged, stale or tampered context, an unknown or
   unpublished hostname — is one uniform `404 STOREFRONT_NOT_FOUND`
   (`Cache-Control: no-store`) that never says which check failed.
5. The existing per-business rules then apply to the resolved business
   unchanged: suspension (503 `BUSINESS_UNAVAILABLE`), feature entitlements,
   ordering and billing gates.

The only storefront-surface routes answered without a context are the probe
(`GET /`) and local/dev media bytes (`GET /api/v1/media/objects/:folder/:file`);
they get no TenantContext at all. Local media keys are not per business, and in
production the same bytes come from a public bucket whatever the business's
state, so — unlike other routes — they are not closed by a suspension while
routing is on. Member (`/api/v1/admin`, `/api/v1/internal`),
platform (`/api/v1/platform`) and billing-webhook routes are unchanged: they
never used the storefront resolver.

## Threats considered

| Threat | Outcome |
| --- | --- |
| Browser sets `Host`, `X-Forwarded-Host` or the storefront headers on an API call | Ignored: only a valid signature counts, and the browser has no secret. |
| Browser spoofs `Host` to the web app | It reaches another **published** storefront — what typing that address does. Session cookies are host-only, so they stay with the address the browser used. |
| Replay of a captured context | A context is not bound to one request (method, path or body): for 60 seconds a captured context can be reused against any storefront route, but only as an anonymous caller of that same published storefront — which the public web app already offers to anyone. It carries no customer session, no client IP (separately signed) and no other business. Binding the request or adding a nonce is a possible later hardening; the headers must therefore never be logged. |
| Signature for one hostname presented for another | Refused (the hostname is in the signed message). |
| A client-IP signature presented as a storefront signature | Refused (separate secret and domain-separated message). |
| Unknown or unpublished hostname | 404, never the legacy business. |
| Customer token from business A on business B's storefront | 403 (a login belongs to one business — `CustomersService`); nothing is created for B. Separate per-business profiles are SC4f-2. |
| Cross-business prices in the cart | The menu is read through the web app with the shopper's storefront; another business's location reads like a missing one. |
| Shared-cache leakage | Every host-resolved API answer is `no-store` and `Vary: x-centerivo-storefront-host`; web calls are uncached; the menu proxy is `no-store`. |

## Reviewed, unchanged in SC4f-1

- **CSRF** (`apps/web/src/lib/security/request-origin.ts`): already compares the
  browser's `Origin` with the request's own origin, per address.
- **Cookies**: customer and internal session cookies are host-only (no
  `Domain`), so one storefront's cookies are never sent to another.
- **CORS**: the browser no longer calls the storefront API; the API's static
  `CORS_ORIGIN` list can be narrowed when routing is turned on.
- **Redirects, email links and payment return URLs**: still built from
  configured addresses, never from the request's `Host`. Making them
  business-aware is SC4f-3.

## Tests

- `apps/api/src/tenancy/storefront-host-routing.spec.ts` — end to end through
  the real middleware and registry (spoofing, forged/stale/tampered contexts,
  unknown/unpublished hosts, cross-business menus and prices, session
  isolation, cache headers, suspension, legacy mode).
- `apps/api/src/tenancy/storefront-context.spec.ts` — switch, verification,
  hostname rules, shared test vector.
- `apps/api/src/tenancy/storefront-hosts-migration.spec.ts` — database rules,
  guard and rollback.
- `apps/web/src/lib/storefront-context.spec.ts` — host derivation, signing,
  `storefrontApiFetch`, the menu proxy, shared test vector.
