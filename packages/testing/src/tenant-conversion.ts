// TEST-ONLY record of S0D progress: the tenant-owned models whose tenantId
// is REQUIRED (NOT NULL) so far. Schema-introspection tests assert exactly
// these are NOT NULL and every other tenant-owned model is still nullable.
// Each S0D-2 slice appends its models here, in the same change that sets
// them NOT NULL.
export const TENANT_ID_REQUIRED_MODELS: readonly string[] = [
  // S0D-2A — locations, catalog, menu, pricing & store operations.
  'Location',
  'Category',
  'Product',
  'Menu',
  'ModifierGroup',
  'ModifierOption',
  'ProductModifierGroup',
  'MenuProduct',
  'LocationMenu',
  'LocationProductPriceOverride',
  'LocationProductAvailabilityOverride',
  'ChecklistTemplate',
  'ChecklistTemplateItem',
  'ChecklistInstance',
  'ChecklistInstanceItem',
  'OperationsTask',
  // S0D-2B-1 — customer core (JIT-created under the request TenantContext).
  'Customer',
  // S0D-2B-2 — customer children (tenant inherited from the parent Customer).
  'CustomerPreferredLocation',
  'CustomerNote',
  // S0D-2C-1 — order & payment core (tenant from the validated Location /
  // the request TenantContext, inherited by the Order and its children).
  'PaymentAttempt',
  'Order',
  'OrderLine',
  'OrderStatusHistory',
  // S0D-2D — careers & franchising (tenant from the request TenantContext,
  // cross-checked against the Location when a JobOpening names one;
  // inherited by JobApplication / JobApplicationNote and
  // FranchiseInquiryNote from their validated parent).
  'JobOpening',
  'JobApplication',
  'JobApplicationNote',
  'FranchiseInquiry',
  'FranchiseInquiryNote',
  // S0D-2C-1B — payment core closure: GiftCardPurchase (PaymentAttempt's
  // other child, copied from its validated PaymentAttempt — the same
  // authoritative chain Order already uses).
  'GiftCardPurchase',
];
