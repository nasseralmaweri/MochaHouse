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
  'GET /api/v1/admin/catalog/menus': { scope: 'tenant' },
  'GET /api/v1/admin/catalog/menus/:menuId': { scope: 'tenant' },
  'GET /api/v1/admin/catalog/products': { scope: 'tenant' },
  'GET /api/v1/admin/catalog/products/:productId': { scope: 'tenant' },
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
  'GET /api/v1/admin/marketing/campaigns': { scope: 'tenant' },
  'GET /api/v1/admin/marketing/campaigns/:campaignId': { scope: 'tenant' },
  'GET /api/v1/admin/marketing/campaigns/options': { scope: 'tenant' },
  'GET /api/v1/admin/media': { scope: 'tenant' },
  'GET /api/v1/admin/media/:mediaAssetId': { scope: 'tenant' },
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
  'PATCH /api/v1/admin/careers/jobs/:jobId': { scope: 'tenant' },
  'PATCH /api/v1/admin/catalog/menus/:menuId/products/:productId/assignment': {
    scope: 'tenant',
  },
  'PATCH /api/v1/admin/catalog/products/:productId': { scope: 'tenant' },
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
  'PUT /api/v1/admin/notifications/recipients/:purpose': { scope: 'tenant' },
  // --- Location-scoped — Admin routes where a location in the request decides access
  // (AuthorizationContext.assertCanActOnLocation, bounded to the active business).
  'DELETE /api/v1/admin/catalog/locations/:locationId/menus/:menuId/products/:productId/availability-override':
    { scope: 'location' },
  'DELETE /api/v1/admin/catalog/locations/:locationId/menus/:menuId/products/:productId/price-override':
    { scope: 'location' },
  'GET /api/v1/admin/catalog/locations/:locationId/menu': { scope: 'location' },
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
  'PUT /api/v1/admin/catalog/locations/:locationId/menus/:menuId/products/:productId/availability-override':
    { scope: 'location' },
  'PUT /api/v1/admin/catalog/locations/:locationId/menus/:menuId/products/:productId/price-override':
    { scope: 'location' },
  // --- Token-protected — access requires a secret held by the caller.
  'GET /api/v1/media/objects/:folder/:file': {
    scope: 'token',
    note: 'Dev/local media bytes by unguessable object key (S3/CDN in production).',
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
  // --- Platform-only — none today.
  // --- Internal/system.
  'GET /': {
    scope: 'system',
    note: 'Default Nest scaffold route; returns a static string.',
  },
};
