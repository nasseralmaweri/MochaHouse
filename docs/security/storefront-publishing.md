# Storefront publishing (SC4f-3a)

Platform operators assign approved storefront addresses to a business, then
publish or unpublish them, from the Platform Console (business page, then
"Storefront addresses and publishing"). This builds on the hostname registry
and routing from SC4f-1 (`docs/security/storefront-host-routing.md`).

> **Publishing is not going live.** A published registry row is publicly
> served only while the deployment's `STOREFRONT_HOST_ROUTING_ENABLED` is on.
> It ships off. The console shows each address as "Live", "Published in the
> registry — not live (host routing is off)", or "Not published".

## Controls (every change)

| Control | Where enforced |
| --- | --- |
| Active operator with the `storefront.manage` permission | `PlatformAuthGuard` and `RequirePlatformPermission`, re-read on every request. A refusal is audited. |
| Recent sign-in (15 minutes) | `assertRecentSignIn`. Viewing does not need it. |
| Written reason, 10–500 characters, no control characters | Request parser and a database CHECK |
| The business's slug typed to confirm | Service, compared with the business named by the route |
| Exact request shapes (unknown fields refused; no body field names a business) | Request parser |
| Append-only history row plus platform audit event, in the same transaction | `StorefrontHostChange` (database guard) and `PlatformAuditEvent` with target `storefront_host` |
| Rate limited | `platform-lifecycle` for changes, `platform-onboarding-report` for reads |

Business staff and customers never reach these routes. No TenantContext is
established for them.

## Approved addresses only

- **Platform address**: `{business slug}.{STOREFRONT_DOMAIN}`.
  - It is always derived from the business's slug, never typed by the
    operator. One per business.
  - Refused when `STOREFRONT_DOMAIN` is unset, when the slug is not a usable
    DNS label (reserved names are blocked), or when the address is one of
    Mocha House's approved existing addresses.
- **Existing Mocha House address** (kind `LEGACY`):
  - Only addresses listed in `LEGACY_STOREFRONT_HOSTNAMES`, trusted
    deployment configuration.
  - Only for the business named by `LEGACY_STOREFRONT_TENANT_ID` (Mocha
    House's tenant id, trusted configuration, required whenever legacy
    addresses are listed). Application code names no default business.
  - Never taken from a request's Host header.
- Custom domains are not managed.
- Both settings are validated at startup; a malformed value refuses to start.
  A Mocha House address may not fall inside, or above, the platform domain,
  so a dedicated platform storefront domain is required.
- If an address in the legacy list is already held by another business, Mocha
  House cannot register it; the console shows it as unavailable.
  They change no DNS, TLS or routing.

## Ownership

- Each address belongs to exactly one business. The unique hostname in the
  database decides concurrent claims, and a duplicate gets
  `409 STOREFRONT_HOST_TAKEN`.
- The registry's database guard refuses any change of owner, hostname or
  kind, and any deletion. An address can never be moved to another business.
- A business's routes can see and change only its own addresses. Another
  business's address answers exactly like a missing one (404).

## Publishing checks (owner decision H2)

Checked by the server at the moment of publishing, and shown to the operator
as a checklist:

1. the business is active (not suspended);
2. billing or a trial is verified: an ACTIVE or TRIALING subscription that has
   passed the SC4d authorization rule. A business with no subscription fails
   closed;
3. an active location is set up (address, phone, time zone and opening
   hours);
4. that location has an assigned menu with at least one product a customer
   could buy.

Rules around the checks:
- **Online ordering is not required**: a published storefront may be
  browse-only.
- A refusal is `409 STOREFRONT_NOT_ELIGIBLE` with the unmet checks.
- Unpublishing is always allowed.
- Nothing is published or unpublished automatically.
- Suspension, billing and ordering rules keep applying to a published
  storefront while it runs.

Concurrency: publish and unpublish lock the address row, so concurrent
changes apply one at a time. The second sees the first's result and gets
`409 STOREFRONT_HOST_UNCHANGED`. A publish also holds the business and its
subscription rows while it checks, so a suspension or billing change either
commits first (and is seen) or waits for the publish. Location and menu edits
are not locked: they cannot make a business suspended or unbilled.

## Rollout notes

- Mocha House's existing addresses must be registered as `LEGACY`, and
  published, before host routing is turned on. Otherwise those addresses stop
  resolving once routing is on.
- Mocha House must also meet the publishing checks. The seeded Mocha House
  locations have no address, phone, time zone or opening hours yet; those are
  required by check 3.
- `storefront.manage` is granted only through the existing audited grant flows
  (provisioning CLI or the console's permission management).

Migration: `20261112090000_storefront_publishing` (additive). Rollback:
`prisma/rollbacks/20261112090000_storefront_publishing.down.sql` refuses
while any history or `storefront.manage` grant exists. SC4f-1's registry
rollback must come after it, because the history references the registry.

## Tests

- `apps/api/src/platform-storefront/platform-storefront.spec.ts`: end to end.
  Covers:
  - permissions, recent sign-in, reason, slug and exact shapes;
  - platform and legacy assignment;
  - wrong-business attempts;
  - fail-closed billing for a business with no subscription;
  - a suspension racing a publish;
  - the ownership guard;
  - eligibility (browse-only, not set up, self-service billing, suspended);
  - no automatic unpublish;
  - concurrent publishes;
  - routing off;
  - append-only, per-business history.
- `apps/api/src/platform-storefront/application/storefront-publishing.spec.ts`:
  configuration and request shapes.
- `apps/api/src/tenancy/storefront-publishing-migration.spec.ts`: database
  rules, guard and rollback.
- `apps/web/src/lib/platform/storefront.spec.ts`: console wording and answers.
