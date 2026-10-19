// Security 4B — the classification of EVERY HTTP route the API registers.
//
// route-inventory.spec.ts fails when a route exists that is not listed here (a new
// endpoint must be classified before it can merge) or when a listed route no longer
// exists. A classification documents the intended boundary; it is NOT an
// authorization check — runtime guards and tenant-scoped services still enforce it.

export type RouteScope =
  'tenant' | 'location' | 'token' | 'public-auth' | 'platform' | 'system';

export interface RouteClassification {
  scope: RouteScope;
  note?: string;
}

export const ROUTE_INVENTORY: Record<string, RouteClassification> = {
  // --- Tenant/company-scoped — the business comes from the server-resolved TenantContext:
  // the validated X-Tenant-Id (Admin, InternalAuthGuard) or the deployment's storefront
  // business (TenancyModule), plus the signed-in customer's own records.
  'DELETE /api/v1/customers/me/locations/:locationId': { scope: 'tenant' },
  'GET /api/v1/admin/approvals': { scope: 'tenant' },
  // SC3b — the business's own CENTERIVO subscription billing.
  'GET /api/v1/admin/billing': { scope: 'tenant' },
  'POST /api/v1/admin/billing/checkout': { scope: 'tenant' },
  'POST /api/v1/admin/billing/recovery/invoice': { scope: 'tenant' },
  'POST /api/v1/admin/billing/recovery/portal': { scope: 'tenant' },
  // SC3d-1 — plan change preview (nothing charged or changed).
  'POST /api/v1/admin/billing/plan-change/preview': { scope: 'tenant' },
  // SC3d-2 — plan options, the business's confirmation (the only charge
  // path) and the waiting change's invoice page.
  'GET /api/v1/admin/billing/plan-options': { scope: 'tenant' },
  // SC4c — a self-service business's first payment setup: the plans it may
  // choose and changing its choice before paying.
  'GET /api/v1/admin/billing/initial-plan-options': { scope: 'tenant' },
  'POST /api/v1/admin/billing/initial-plan': { scope: 'tenant' },
  'POST /api/v1/admin/billing/plan-change/confirm': { scope: 'tenant' },
  'POST /api/v1/admin/billing/plan-change/pay': { scope: 'tenant' },
  // SC3d-3 — cancelling a scheduled change.
  'POST /api/v1/admin/billing/plan-change/cancel': { scope: 'tenant' },
  // SC3e-1 — billing history, invoice documents, payment method (read-only).
  'GET /api/v1/admin/billing/invoices': { scope: 'tenant' },
  'POST /api/v1/admin/billing/invoices/:invoiceId/document': {
    scope: 'tenant',
  },
  'GET /api/v1/admin/billing/payment-method': { scope: 'tenant' },
  'GET /api/v1/admin/approvals/:approvalRequestId': { scope: 'tenant' },
  'GET /api/v1/admin/audit': { scope: 'tenant' },
  'GET /api/v1/admin/careers/applications': { scope: 'tenant' },
  'GET /api/v1/admin/careers/applications/:applicationId': { scope: 'tenant' },
  'GET /api/v1/admin/careers/applications/:applicationId/notes': {
    scope: 'tenant',
  },
  'GET /api/v1/admin/careers/jobs': { scope: 'tenant' },
  'GET /api/v1/admin/careers/jobs/:jobId': { scope: 'tenant' },
  'GET /api/v1/admin/careers/jobs/options': { scope: 'tenant' },
  'GET /api/v1/admin/catalog/categories': { scope: 'tenant' },
  // SC4d — first location setup: create the business's first location, a
  // business menu, and the getting-started checklist (computed, read-only).
  'POST /api/v1/admin/locations': { scope: 'tenant' },
  'POST /api/v1/admin/catalog/menus': { scope: 'tenant' },
  'GET /api/v1/admin/getting-started': { scope: 'tenant' },
  'GET /api/v1/admin/catalog/menus': { scope: 'tenant' },
  'GET /api/v1/admin/catalog/menus/:menuId': { scope: 'tenant' },
  'GET /api/v1/admin/catalog/modifier-groups': { scope: 'tenant' },
  'GET /api/v1/admin/catalog/modifier-groups/:groupId': { scope: 'tenant' },
  'GET /api/v1/admin/catalog/products': { scope: 'tenant' },
  'GET /api/v1/admin/catalog/products/:productId': { scope: 'tenant' },
  'GET /api/v1/admin/catalog/products/:productId/modifier-groups': {
    scope: 'tenant',
  },
  'GET /api/v1/admin/content': { scope: 'tenant' },
  'GET /api/v1/admin/content/:pageKey': { scope: 'tenant' },
  'GET /api/v1/admin/customers': { scope: 'tenant' },
  'GET /api/v1/admin/customers/:customerId': { scope: 'tenant' },
  'GET /api/v1/admin/customers/:customerId/notes': { scope: 'tenant' },
  'GET /api/v1/admin/franchising/inquiries': { scope: 'tenant' },
  'GET /api/v1/admin/franchising/inquiries/:inquiryId': { scope: 'tenant' },
  'GET /api/v1/admin/franchising/inquiries/:inquiryId/notes': {
    scope: 'tenant',
  },
  'GET /api/v1/admin/gift-cards/:giftCardId': { scope: 'tenant' },
  'GET /api/v1/admin/gift-cards/configuration': { scope: 'tenant' },
  'GET /api/v1/admin/internal-roles': { scope: 'tenant' },
  'GET /api/v1/admin/internal-roles/:internalRoleId': { scope: 'tenant' },
  'GET /api/v1/admin/internal-users': { scope: 'tenant' },
  'GET /api/v1/admin/internal-users/:internalUserId': { scope: 'tenant' },
  'GET /api/v1/admin/internal-users/access-options': { scope: 'tenant' },
  'GET /api/v1/admin/locations': { scope: 'tenant' },
  'GET /api/v1/admin/loyalty/bonus-promotion-options': { scope: 'tenant' },
  'GET /api/v1/admin/loyalty/bonus-promotions': { scope: 'tenant' },
  'GET /api/v1/admin/loyalty/catalog-options': { scope: 'tenant' },
  'GET /api/v1/admin/loyalty/customers': { scope: 'tenant' },
  'GET /api/v1/admin/loyalty/customers/:customerId': { scope: 'tenant' },
  'GET /api/v1/admin/loyalty/rewards': { scope: 'tenant' },
  'GET /api/v1/admin/loyalty/settings': { scope: 'tenant' },
  // SC4f-3b — the business's loyalty points name (loyalty.configure).
  'GET /api/v1/admin/loyalty/settings/points-label': { scope: 'tenant' },
  'GET /api/v1/admin/marketing/campaigns': { scope: 'tenant' },
  'GET /api/v1/admin/marketing/campaigns/:campaignId': { scope: 'tenant' },
  'GET /api/v1/admin/marketing/campaigns/options': { scope: 'tenant' },
  'GET /api/v1/admin/media': { scope: 'tenant' },
  'GET /api/v1/admin/media/:mediaAssetId': { scope: 'tenant' },
  'GET /api/v1/admin/notifications/health': { scope: 'tenant' },
  'GET /api/v1/admin/notifications/recipients': { scope: 'tenant' },
  'GET /api/v1/admin/operations/closing-checklist/template': {
    scope: 'tenant',
  },
  'GET /api/v1/admin/operations/opening-checklist/template': {
    scope: 'tenant',
  },
  'GET /api/v1/admin/platform/status': { scope: 'tenant' },
  'GET /api/v1/admin/promotions': { scope: 'tenant' },
  'GET /api/v1/admin/promotions/options': { scope: 'tenant' },
  'GET /api/v1/admin/reports/customer-growth': { scope: 'tenant' },
  'GET /api/v1/admin/reports/customer-growth/export': { scope: 'tenant' },
  'GET /api/v1/admin/reports/location-performance': { scope: 'tenant' },
  'GET /api/v1/admin/reports/location-performance/export': { scope: 'tenant' },
  'GET /api/v1/admin/reports/operations-checklists': { scope: 'tenant' },
  'GET /api/v1/admin/reports/operations-checklists/export': { scope: 'tenant' },
  'GET /api/v1/admin/reports/orders-overview': { scope: 'tenant' },
  'GET /api/v1/admin/reports/orders-overview/export': { scope: 'tenant' },
  'GET /api/v1/careers/jobs': { scope: 'tenant' },
  'GET /api/v1/careers/jobs/:jobId': { scope: 'tenant' },
  'GET /api/v1/catalog/categories': { scope: 'tenant' },
  'GET /api/v1/catalog/menus': { scope: 'tenant' },
  'GET /api/v1/catalog/modifier-groups': { scope: 'tenant' },
  'GET /api/v1/catalog/products': { scope: 'tenant' },
  'GET /api/v1/content/:pageKey': { scope: 'tenant' },
  'GET /api/v1/customers/me': { scope: 'tenant' },
  // SC4f-3b — the storefront's own business name, ordering availability and
  // loyalty points name (public; resolved business only).
  'GET /api/v1/storefront/profile': { scope: 'tenant' },
  'GET /api/v1/customers/me/locations': { scope: 'tenant' },
  'GET /api/v1/customers/me/loyalty': { scope: 'tenant' },
  'GET /api/v1/customers/me/orders': { scope: 'tenant' },
  'GET /api/v1/customers/me/orders/:orderId': { scope: 'tenant' },
  'GET /api/v1/customers/me/preferences': { scope: 'tenant' },
  'GET /api/v1/gift-cards/purchase-options': { scope: 'tenant' },
  'GET /api/v1/internal/me': {
    scope: 'tenant',
    note: 'The signed-in staff member in the validated active business.',
  },
  'GET /api/v1/locations': { scope: 'tenant' },
  'GET /api/v1/locations/:locationId/menu': { scope: 'tenant' },
  'GET /api/v1/storefront/features': { scope: 'tenant' },
  'PATCH /api/v1/admin/careers/jobs/:jobId': { scope: 'tenant' },
  'PATCH /api/v1/admin/catalog/menus/:menuId/products/:productId/assignment': {
    scope: 'tenant',
  },
  'PATCH /api/v1/admin/catalog/products/:productId': { scope: 'tenant' },
  // Product Modifier Management — the business's own modifier groups.
  'PATCH /api/v1/admin/catalog/modifier-groups/:groupId': { scope: 'tenant' },
  'PATCH /api/v1/admin/catalog/modifier-groups/:groupId/options/:optionId': {
    scope: 'tenant',
  },
  'PATCH /api/v1/admin/content/:pageKey': { scope: 'tenant' },
  'PATCH /api/v1/admin/internal-users/:internalUserId/status': {
    scope: 'tenant',
  },
  'PATCH /api/v1/admin/loyalty/bonus-promotions/:promotionId': {
    scope: 'tenant',
  },
  'PATCH /api/v1/admin/loyalty/rewards/:rewardId': { scope: 'tenant' },
  'PATCH /api/v1/admin/marketing/campaigns/:campaignId': { scope: 'tenant' },
  'PATCH /api/v1/admin/media/:mediaAssetId': { scope: 'tenant' },
  'PATCH /api/v1/admin/operations/closing-checklist/template/items/:itemId': {
    scope: 'tenant',
  },
  'PATCH /api/v1/admin/operations/opening-checklist/template/items/:itemId': {
    scope: 'tenant',
  },
  'PATCH /api/v1/admin/promotions/:promotionId': { scope: 'tenant' },
  'PATCH /api/v1/customers/me': { scope: 'tenant' },
  'PATCH /api/v1/customers/me/preferences': { scope: 'tenant' },
  'POST /api/v1/admin/approvals/:approvalRequestId/approve': {
    scope: 'tenant',
  },
  'POST /api/v1/admin/approvals/:approvalRequestId/reject': { scope: 'tenant' },
  'POST /api/v1/admin/careers/applications/:applicationId/notes': {
    scope: 'tenant',
  },
  'POST /api/v1/admin/careers/applications/:applicationId/status': {
    scope: 'tenant',
  },
  'POST /api/v1/admin/careers/jobs': { scope: 'tenant' },
  'POST /api/v1/admin/careers/jobs/:jobId/archive': { scope: 'tenant' },
  'POST /api/v1/admin/careers/jobs/:jobId/publish': { scope: 'tenant' },
  'POST /api/v1/admin/careers/jobs/:jobId/unpublish': { scope: 'tenant' },
  'POST /api/v1/admin/catalog/categories': { scope: 'tenant' },
  'POST /api/v1/admin/catalog/menus/:menuId/products': { scope: 'tenant' },
  'POST /api/v1/admin/catalog/products': { scope: 'tenant' },
  'POST /api/v1/admin/catalog/modifier-groups': { scope: 'tenant' },
  'POST /api/v1/admin/catalog/modifier-groups/:groupId/options': {
    scope: 'tenant',
  },
  'POST /api/v1/admin/catalog/products/:productId/modifier-groups': {
    scope: 'tenant',
  },
  'POST /api/v1/admin/content/:pageKey/publish': { scope: 'tenant' },
  'POST /api/v1/admin/customers/:customerId/notes': { scope: 'tenant' },
  'POST /api/v1/admin/franchising/inquiries/:inquiryId/notes': {
    scope: 'tenant',
  },
  'POST /api/v1/admin/franchising/inquiries/:inquiryId/status': {
    scope: 'tenant',
  },
  'POST /api/v1/admin/gift-cards': { scope: 'tenant' },
  'POST /api/v1/admin/gift-cards/:giftCardId/corrections': { scope: 'tenant' },
  'POST /api/v1/admin/gift-cards/:giftCardId/deactivate': { scope: 'tenant' },
  'POST /api/v1/admin/gift-cards/:giftCardId/reactivate': { scope: 'tenant' },
  'POST /api/v1/admin/gift-cards/search': { scope: 'tenant' },
  'POST /api/v1/admin/internal-users/:internalUserId/role-assignments': {
    scope: 'tenant',
  },
  'POST /api/v1/admin/internal-users/:internalUserId/role-assignments/:assignmentId/remove':
    { scope: 'tenant' },
  'POST /api/v1/admin/loyalty/bonus-promotions': { scope: 'tenant' },
  'POST /api/v1/admin/loyalty/customers/:customerId/adjustments': {
    scope: 'tenant',
  },
  'POST /api/v1/admin/loyalty/rewards': { scope: 'tenant' },
  'POST /api/v1/admin/marketing/campaigns': { scope: 'tenant' },
  'POST /api/v1/admin/marketing/campaigns/:campaignId/request-approval': {
    scope: 'tenant',
  },
  'POST /api/v1/admin/marketing/campaigns/:campaignId/status': {
    scope: 'tenant',
  },
  'POST /api/v1/admin/media': { scope: 'tenant' },
  'POST /api/v1/admin/media/:mediaAssetId/deactivate': { scope: 'tenant' },
  'POST /api/v1/admin/operations/closing-checklist/template/items': {
    scope: 'tenant',
  },
  'POST /api/v1/admin/operations/closing-checklist/template/items/:itemId/move':
    { scope: 'tenant' },
  'POST /api/v1/admin/operations/closing-checklist/template/sections/move': {
    scope: 'tenant',
  },
  'POST /api/v1/admin/operations/closing-checklist/template/sections/rename': {
    scope: 'tenant',
  },
  'POST /api/v1/admin/operations/opening-checklist/template/items': {
    scope: 'tenant',
  },
  'POST /api/v1/admin/operations/opening-checklist/template/items/:itemId/move':
    { scope: 'tenant' },
  'POST /api/v1/admin/operations/opening-checklist/template/sections/move': {
    scope: 'tenant',
  },
  'POST /api/v1/admin/operations/opening-checklist/template/sections/rename': {
    scope: 'tenant',
  },
  'POST /api/v1/admin/promotions': { scope: 'tenant' },
  'POST /api/v1/careers/jobs/:jobId/applications': { scope: 'tenant' },
  // SC4f-2 — a signed-in customer joining the resolved business.
  'POST /api/v1/customers/me/enrollment': { scope: 'tenant' },
  'POST /api/v1/customers/me/locations': { scope: 'tenant' },
  'POST /api/v1/customers/me/orders/:orderId/reorder': { scope: 'tenant' },
  'POST /api/v1/franchising/inquiries': { scope: 'tenant' },
  'POST /api/v1/gift-cards/balance': { scope: 'tenant' },
  'POST /api/v1/gift-cards/purchase': { scope: 'tenant' },
  'POST /api/v1/gift-cards/purchase-intents': { scope: 'tenant' },
  'POST /api/v1/orders': { scope: 'tenant' },
  'POST /api/v1/orders/checkout-quote': { scope: 'tenant' },
  'POST /api/v1/orders/reward-eligibility': { scope: 'tenant' },
  'PUT /api/v1/admin/gift-cards/configuration': { scope: 'tenant' },
  'PUT /api/v1/admin/loyalty/settings': { scope: 'tenant' },
  'PUT /api/v1/admin/loyalty/settings/points-label': { scope: 'tenant' },
  'PUT /api/v1/admin/catalog/modifier-groups/:groupId/option-order': {
    scope: 'tenant',
  },
  'PUT /api/v1/admin/catalog/products/:productId/modifier-group-order': {
    scope: 'tenant',
  },
  'DELETE /api/v1/admin/catalog/products/:productId/modifier-groups/:groupId': {
    scope: 'tenant',
  },
  'PUT /api/v1/admin/notifications/recipients/:purpose': { scope: 'tenant' },
  // --- Location-scoped — Admin routes where a location in the request decides access
  // (AuthorizationContext.assertCanActOnLocation, bounded to the active business).
  'DELETE /api/v1/admin/catalog/locations/:locationId/menus/:menuId/products/:productId/availability-override':
    { scope: 'location' },
  'DELETE /api/v1/admin/catalog/locations/:locationId/menus/:menuId/products/:productId/price-override':
    { scope: 'location' },
  'GET /api/v1/admin/catalog/locations/:locationId/menu': { scope: 'location' },
  // SC4d — a location's profile, opening hours and menu (corporate-only
  // permissions; the location must belong to the active business).
  'PUT /api/v1/admin/locations/:locationId/profile': { scope: 'location' },
  'PUT /api/v1/admin/locations/:locationId/hours': { scope: 'location' },
  'PUT /api/v1/admin/catalog/locations/:locationId/menu': { scope: 'location' },
  'GET /api/v1/admin/locations/:locationId': { scope: 'location' },
  'GET /api/v1/admin/operations/closing-checklist': { scope: 'location' },
  'GET /api/v1/admin/operations/opening-checklist': { scope: 'location' },
  'GET /api/v1/admin/operations/tasks': { scope: 'location' },
  'GET /api/v1/admin/orders': { scope: 'location' },
  'GET /api/v1/admin/orders/:orderId': { scope: 'location' },
  'PATCH /api/v1/admin/locations/:locationId': { scope: 'location' },
  'PATCH /api/v1/admin/locations/:locationId/digital-ordering': {
    scope: 'location',
  },
  'POST /api/v1/admin/operations/closing-checklist/items/:instanceItemId/complete':
    { scope: 'location' },
  'POST /api/v1/admin/operations/closing-checklist/items/:instanceItemId/exception':
    { scope: 'location' },
  'POST /api/v1/admin/operations/closing-checklist/items/:instanceItemId/exception/clear':
    { scope: 'location' },
  'POST /api/v1/admin/operations/closing-checklist/items/:instanceItemId/undo':
    { scope: 'location' },
  'POST /api/v1/admin/operations/opening-checklist/items/:instanceItemId/complete':
    { scope: 'location' },
  'POST /api/v1/admin/operations/opening-checklist/items/:instanceItemId/exception':
    { scope: 'location' },
  'POST /api/v1/admin/operations/opening-checklist/items/:instanceItemId/exception/clear':
    { scope: 'location' },
  'POST /api/v1/admin/operations/opening-checklist/items/:instanceItemId/undo':
    { scope: 'location' },
  'POST /api/v1/admin/operations/tasks': { scope: 'location' },
  'POST /api/v1/admin/operations/tasks/:taskId/complete': { scope: 'location' },
  'POST /api/v1/admin/operations/tasks/:taskId/delete': { scope: 'location' },
  'POST /api/v1/admin/operations/tasks/:taskId/reopen': { scope: 'location' },
  'POST /api/v1/admin/orders/:orderId/advance': { scope: 'location' },
  // R1 / S5b — orders.cancel at the order's location; off unless
  // ORDER_CLOSURE_ENABLED=1.
  'POST /api/v1/admin/orders/:orderId/cancel': { scope: 'location' },
  'POST /api/v1/admin/orders/:orderId/reject': { scope: 'location' },
  'PUT /api/v1/admin/catalog/locations/:locationId/menus/:menuId/products/:productId/availability-override':
    { scope: 'location' },
  'PUT /api/v1/admin/catalog/locations/:locationId/menus/:menuId/products/:productId/price-override':
    { scope: 'location' },
  // --- Token-protected — access requires a secret held by the caller.
  'GET /api/v1/media/objects/:folder/:file': {
    scope: 'token',
    note: 'Dev/local media bytes by unguessable object key (S3/CDN in production).',
  },
  'POST /api/v1/billing/webhooks/:provider': {
    scope: 'token',
    note: "SC3b — billing-provider webhooks: the provider's signature over the raw body is the only credential; the business comes from our stored provider ids, never the request.",
  },
  'GET /api/v1/orders/:orderId': {
    scope: 'token',
    note: 'Guest order status: requires the order accessToken.',
  },
  // --- Public identity/authentication — establish who the caller is; no business data.
  'GET /api/v1/internal/businesses': { scope: 'public-auth' },
  'POST /api/v1/auth/forgot-password': { scope: 'public-auth' },
  'POST /api/v1/auth/register': { scope: 'public-auth' },
  'POST /api/v1/auth/reset-password': { scope: 'public-auth' },
  'POST /api/v1/auth/sign-in': { scope: 'public-auth' },
  'POST /api/v1/auth/verification/resend': { scope: 'public-auth' },
  'POST /api/v1/auth/verify': { scope: 'public-auth' },
  'POST /api/v1/internal/auth/sign-in': { scope: 'public-auth' },
  // SC4a — business owner self-service registration: 404 unless enabled
  // server-side; creates a staff-pool login and a platform record only (no
  // business, staff member or role). Rate limited; enumeration-safe.
  'GET /api/v1/internal/registration': { scope: 'public-auth' },
  'POST /api/v1/internal/registration/start': { scope: 'public-auth' },
  'POST /api/v1/internal/registration/complete': { scope: 'public-auth' },
  // SC4b — a verified self-registered owner's restricted onboarding: their
  // own login only (InternalIdentityGuard), no business context; creating
  // their ONE business goes through TenantProvisioningService.
  'GET /api/v1/internal/onboarding': { scope: 'public-auth' },
  'POST /api/v1/internal/onboarding/business': { scope: 'public-auth' },
  // SC1b — CENTERIVO platform-operator sign-in (dedicated platform pool,
  // mandatory TOTP). Rate limited; never returns a token before MFA.
  'POST /api/v1/platform/auth/sign-in': { scope: 'public-auth' },
  'POST /api/v1/platform/auth/mfa': { scope: 'public-auth' },
  'POST /api/v1/platform/auth/mfa-setup': { scope: 'public-auth' },
  'POST /api/v1/platform/auth/mfa-setup/display': { scope: 'public-auth' },
  'POST /api/v1/platform/auth/mfa-setup/verify': { scope: 'public-auth' },
  // --- Platform-only — CENTERIVO platform operators (SC1a). PlatformAuthGuard
  // only: no tenant, no tenant header, no tenant role.
  'GET /api/v1/platform/me': {
    scope: 'platform',
    note: 'The signed-in ACTIVE platform operator (dedicated platform pool).',
  },
  'POST /api/v1/platform/session/sign-out': {
    scope: 'platform',
    note: 'SC1b — records the end of the operator session.',
  },
  // SC1c — the read-only tenant registry: business registry records and a
  // business's location summary; no customer, order or financial data.
  'POST /api/v1/platform/tenants': {
    scope: 'platform',
    note: 'SC1d — provision a business: roles, first owner, audit; idempotent.',
  },
  // SC1e — business lifecycle (recent sign-in required for changes).
  'GET /api/v1/platform/tenants/:tenantId/lifecycle': {
    scope: 'platform',
    note: 'SC1e — status, first owner and suspension impact counts.',
  },
  'POST /api/v1/platform/tenants/:tenantId/suspend': {
    scope: 'platform',
    note: 'SC1e — suspend with a reason; never Tenant #1; audited.',
  },
  'POST /api/v1/platform/tenants/:tenantId/reactivate': {
    scope: 'platform',
    note: 'SC1e — reactivate; audited.',
  },
  'POST /api/v1/platform/tenants/:tenantId/owner-email': {
    scope: 'platform',
    note: "SC1e — correct a never-signed-in first owner's email; audited.",
  },
  // SC2a — SaaS plans and subscriptions (recent sign-in for changes).
  'PUT /api/v1/platform/plans/:planId/self-service': { scope: 'platform' },
  'GET /api/v1/platform/plans': {
    scope: 'platform',
    note: 'SC2a — every plan and version, with subscriber counts.',
  },
  'POST /api/v1/platform/plans': {
    scope: 'platform',
    note: 'SC2a — a new plan with a draft version 1; audited.',
  },
  'POST /api/v1/platform/plans/:planId/versions': {
    scope: 'platform',
    note: 'SC2a — a new draft version; audited.',
  },
  'PUT /api/v1/platform/plans/:planId/versions/:versionId': {
    scope: 'platform',
    note: "SC2a — edit a draft version's modules; audited.",
  },
  'POST /api/v1/platform/plans/:planId/versions/:versionId/publish': {
    scope: 'platform',
    note: 'SC2a — publish (then immutable); audited.',
  },
  'POST /api/v1/platform/plans/:planId/versions/:versionId/retire': {
    scope: 'platform',
    note: 'SC2a — stop offering a version; audited.',
  },
  // SC3a — SaaS list prices and billing policy (recent sign-in for changes).
  'POST /api/v1/platform/plans/:planId/prices': {
    scope: 'platform',
    note: 'SC3a — a new list price (archives the previous one); audited.',
  },
  'POST /api/v1/platform/plans/:planId/prices/:priceId/archive': {
    scope: 'platform',
    note: 'SC3a — stop offering a price (subscribers keep it); audited.',
  },
  'GET /api/v1/platform/billing/policy': {
    scope: 'platform',
    note: 'SC3a — trial and grace-period settings.',
  },
  'PUT /api/v1/platform/billing/policy': {
    scope: 'platform',
    note: 'SC3a — change trial and grace-period settings; audited.',
  },
  // SC3b — starting a business's billing and review-only reconciliation.
  'GET /api/v1/platform/tenants/:tenantId/billing': {
    scope: 'platform',
    note: "SC3b — a business's billing state.",
  },
  // SC3e-4 — payment setup deadlines.
  // SC4e — onboarding oversight (onboarding.view; the pause also needs
  // onboarding.manage and a recent sign-in, audited).
  'GET /api/v1/platform/onboarding/registrations': {
    scope: 'platform',
    note: 'SC4e — owner registrations (onboarding.view; unverified emails masked; each view audited).',
  },
  'GET /api/v1/platform/onboarding/businesses': {
    scope: 'platform',
    note: 'SC4e — self-service businesses and their getting-started progress (onboarding.view; read-only).',
  },
  'GET /api/v1/platform/onboarding/registration-control': {
    scope: 'platform',
    note: 'SC4e — registration availability, pause history, quota and issue counts (onboarding.view).',
  },
  'POST /api/v1/platform/onboarding/registration-control': {
    scope: 'platform',
    note: 'SC4e — pause / resume NEW owner registrations (onboarding.manage, recent sign-in, reason; audited). Cannot enable registration while the deployment flag is off.',
  },
  // SC4f-3a — storefront publishing (storefront.manage; every change also
  // needs a recent sign-in, a reason and the business's slug; audited).
  'GET /api/v1/platform/tenants/:tenantId/storefront': {
    scope: 'platform',
    note: "SC4f-3a — a business's storefront addresses, publishing eligibility, routing state and history (storefront.manage).",
  },
  'POST /api/v1/platform/tenants/:tenantId/storefront/hosts': {
    scope: 'platform',
    note: 'SC4f-3a — assign an approved address: the platform subdomain, or a configured existing Mocha House address (storefront.manage, recent sign-in, reason, slug; audited).',
  },
  'POST /api/v1/platform/tenants/:tenantId/storefront/hosts/:hostId/publish': {
    scope: 'platform',
    note: 'SC4f-3a — publish an address in the registry after the eligibility checks (storefront.manage, recent sign-in, reason, slug; audited). Not public while host routing is off.',
  },
  'POST /api/v1/platform/tenants/:tenantId/storefront/hosts/:hostId/unpublish':
    {
      scope: 'platform',
      note: 'SC4f-3a — unpublish an address (storefront.manage, recent sign-in, reason, slug; audited).',
    },
  // ESP-03 PR 5 — restaurant payment reconciliation support
  // (payments.reconciliation.view to read; .manage, a recent sign-in and a
  // reason to act; audited). A recovery never charges.
  'GET /api/v1/platform/payment-cases': {
    scope: 'platform',
    note: 'ESP-03 PR 5 — payment reconciliation cases across businesses, filtered by business, status, category and date (payments.reconciliation.view; no card, code or contact data).',
  },
  'GET /api/v1/platform/payment-cases/:caseId': {
    scope: 'platform',
    note: 'ESP-03 PR 5 — one case: payment and order references, reason codes, recovery history and internal notes (payments.reconciliation.view).',
  },
  'POST /api/v1/platform/payment-cases/:caseId/recover': {
    scope: 'platform',
    note: 'ESP-03 PR 5 — a safe recovery attempt for a confirmed payment with no order / gift card (payments.reconciliation.manage, recent sign-in, reason; audited). Never charges; refuses uncertain payments.',
  },
  'POST /api/v1/platform/payment-cases/:caseId/notes': {
    scope: 'platform',
    note: 'ESP-03 PR 5 — add an append-only internal note to a case (payments.reconciliation.manage, recent sign-in; audited).',
  },
  'GET /api/v1/platform/billing/payment-setup': {
    scope: 'platform',
    note: 'SC3e-4 — businesses awaiting payment setup and their deadlines (read-only).',
  },
  'POST /api/v1/platform/tenants/:tenantId/billing/payment-setup/extension': {
    scope: 'platform',
    note: 'SC3e-4 — extend a payment setup deadline (billing.accounts.manage, recent sign-in; max 30 days).',
  },
  // SC3e-2 — complimentary arrangements and review-case actions.
  'GET /api/v1/platform/billing/complimentary': {
    scope: 'platform',
    note: 'SC3e-2 — every open complimentary arrangement (read-only).',
  },
  'GET /api/v1/platform/tenants/:tenantId/billing/complimentary': {
    scope: 'platform',
    note: "SC3e-2 — a business's complimentary arrangements (read-only).",
  },
  'POST /api/v1/platform/tenants/:tenantId/billing/complimentary': {
    scope: 'platform',
    note: 'SC3e-2 — grant (billing.complimentary.manage, recent sign-in).',
  },
  'POST /api/v1/platform/tenants/:tenantId/billing/complimentary/:grantId/withdraw':
    {
      scope: 'platform',
      note: 'SC3e-2 — withdraw a scheduled grant (billing.complimentary.manage).',
    },
  'POST /api/v1/platform/tenants/:tenantId/billing/complimentary/:grantId/revoke':
    {
      scope: 'platform',
      note: 'SC3e-2 — revoke an active grant (billing.complimentary.manage).',
    },
  // SC3f — CENTERIVO-wide SaaS revenue reporting (read-only).
  'GET /api/v1/platform/billing/reports/revenue': {
    scope: 'platform',
    note: 'SC3f — revenue report totals (billing.reports.view; audited; no business detail).',
  },
  // SC3e-3 — refunds and credits, and operator permissions.
  'GET /api/v1/platform/billing/adjustments': {
    scope: 'platform',
    note: 'SC3e-3 — refund/credit requests (read-only).',
  },
  'GET /api/v1/platform/billing/adjustments/:adjustmentId': {
    scope: 'platform',
    note: 'SC3e-3 — one refund/credit and its history (read-only).',
  },
  'GET /api/v1/platform/tenants/:tenantId/billing/adjustments': {
    scope: 'platform',
    note: "SC3e-3 — a business's refunds and credits (read-only).",
  },
  'GET /api/v1/platform/tenants/:tenantId/billing/invoices/:invoiceId/adjustable':
    {
      scope: 'platform',
      note: 'SC3e-3 — the invoice read live from the provider (billing.adjustments.request).',
    },
  'POST /api/v1/platform/tenants/:tenantId/billing/invoices/:invoiceId/adjustments/preview':
    {
      scope: 'platform',
      note: "SC3e-3 — the provider's credit-note preview (billing.adjustments.request; nothing recorded).",
    },
  'POST /api/v1/platform/tenants/:tenantId/billing/invoices/:invoiceId/adjustments':
    {
      scope: 'platform',
      note: 'SC3e-3 — request a refund/credit (billing.adjustments.request, recent sign-in, reason).',
    },
  'POST /api/v1/platform/billing/adjustments/:adjustmentId/approve': {
    scope: 'platform',
    note: 'SC3e-3 — approve; the final approval executes it (billing.adjustments.approve, never the requester).',
  },
  'POST /api/v1/platform/billing/adjustments/:adjustmentId/reject': {
    scope: 'platform',
    note: 'SC3e-3 — reject (billing.adjustments.approve, never the requester).',
  },
  'POST /api/v1/platform/billing/adjustments/:adjustmentId/cancel': {
    scope: 'platform',
    note: 'SC3e-3 — the requester withdraws its pending request.',
  },
  'POST /api/v1/platform/billing/adjustments/:adjustmentId/resolve-not-issued':
    {
      scope: 'platform',
      note: 'SC3e-3 — close a reviewed adjustment after re-reading the provider (billing.adjustments.approve).',
    },
  'GET /api/v1/platform/operators': {
    scope: 'platform',
    note: 'SC3e-3 — operators and their permissions (platform.permissions.manage).',
  },
  'POST /api/v1/platform/operators/:operatorId/permissions': {
    scope: 'platform',
    note: 'SC3e-3 — grant a permission to ANOTHER operator (platform.permissions.manage, recent sign-in).',
  },
  'POST /api/v1/platform/operators/:operatorId/permissions/revoke': {
    scope: 'platform',
    note: "SC3e-3 — revoke ANOTHER operator's permission (platform.permissions.manage, recent sign-in).",
  },
  'GET /api/v1/platform/billing/reconciliation-cases/:caseId': {
    scope: 'platform',
    note: 'SC3e-2 — a review case, its actions and the live schedule.',
  },
  'POST /api/v1/platform/billing/reconciliation-cases/:caseId/recheck': {
    scope: 'platform',
    note: 'SC3e-2 — re-read the provider (billing.cases.manage; no write).',
  },
  'POST /api/v1/platform/billing/reconciliation-cases/:caseId/release-schedule':
    {
      scope: 'platform',
      note: 'SC3e-2 — release the leftover schedule (billing.schedules.release).',
    },
  'GET /api/v1/platform/tenants/:tenantId/billing/invoices': {
    scope: 'platform',
    note: "SC3e-1 — a business's invoice history (read-only).",
  },
  'POST /api/v1/platform/tenants/:tenantId/billing/start': {
    scope: 'platform',
    note: 'SC3b — start billing a business at one price; audited.',
  },
  'POST /api/v1/platform/billing/reconcile': {
    scope: 'platform',
    note: 'SC3b — review-only reconciliation sweep (never moves money); audited.',
  },
  'POST /api/v1/platform/billing/enforcement/sweep': {
    scope: 'platform',
    note: 'SC3c-1 — apply due grace / trial-recovery expiries now (no-op while enforcement is off); audited.',
  },
  // SC3c-3 — billing contact, grace extensions, console overview.
  'PUT /api/v1/platform/tenants/:tenantId/billing/contact': {
    scope: 'platform',
    note: "SC3c-3 — designate the business's billing contact (its own staff only); audited.",
  },
  'POST /api/v1/platform/tenants/:tenantId/billing/grace-extension': {
    scope: 'platform',
    note: 'SC3c-3 — extend a PAST_DUE grace period / grant an UNPAID grace exception (14 days each, 60 per episode; never marks paid); audited.',
  },
  // SC3d-1 — plan change previews (nothing charged or changed).
  'POST /api/v1/platform/tenants/:tenantId/billing/plan-change/preview': {
    scope: 'platform',
    note: "SC3d-1 — preview a business's plan change with the provider's own calculation; audited.",
  },
  'GET /api/v1/platform/billing/overview': {
    scope: 'platform',
    note: 'SC3c-3 — billing attention counts for the console.',
  },
  'GET /api/v1/platform/billing/reconciliation-cases': {
    scope: 'platform',
    note: 'SC3b — billing cases to review.',
  },
  'POST /api/v1/platform/billing/reconciliation-cases/:caseId/resolve': {
    scope: 'platform',
    note: 'SC3b — mark a case reviewed (changes nothing else); audited.',
  },
  'GET /api/v1/platform/tenants/:tenantId/subscription': {
    scope: 'platform',
    note: "SC2a — a business's plan, add-ons, effective modules and history.",
  },
  'POST /api/v1/platform/tenants/:tenantId/subscription/preview': {
    scope: 'platform',
    note: 'SC2a — what a plan or add-on change would do; changes nothing.',
  },
  'PUT /api/v1/platform/tenants/:tenantId/subscription': {
    scope: 'platform',
    note: 'SC2a — assign or change the plan; audited.',
  },
  'POST /api/v1/platform/tenants/:tenantId/subscription/add-ons': {
    scope: 'platform',
    note: 'SC2a — grant an add-on module; audited.',
  },
  'DELETE /api/v1/platform/tenants/:tenantId/subscription/add-ons/:moduleKey': {
    scope: 'platform',
    note: 'SC2a — revoke an add-on module; audited.',
  },
  'GET /api/v1/platform/tenants': {
    scope: 'platform',
    note: 'SC1c — every business on the platform, searchable and paged.',
  },
  'GET /api/v1/platform/tenants/:tenantId': {
    scope: 'platform',
    note: 'SC1c — one business: status and location counts.',
  },
  'GET /api/v1/platform/tenants/:tenantId/locations': {
    scope: 'platform',
    note: "SC1c — that business's locations only, paged.",
  },
  // --- Internal/system.
  'GET /': {
    scope: 'system',
    note: 'Default Nest scaffold route; returns a static string.',
  },
};
