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
  // S0D-2C-2 — the async outbox/notification pipeline: OutboxEvent
  // (resolved per aggregateType against its own producing aggregate) and
  // NotificationDelivery (copied from its triggering OutboxEvent).
  'OutboxEvent',
  'NotificationDelivery',
  // S0D-2C-3 — NotificationRecipient: a brand-new model, so tenantId is
  // required from inception (no nullable window, no backfill migration —
  // unlike every other entry above).
  'NotificationRecipient',
  // ESP-03 PR 1 — the payment reconciliation case and its append-only event
  // history: brand-new models, tenantId required from inception.
  'PaymentReconciliationCase',
  'PaymentReconciliationEvent',
  // R1 / S5a — the order closure and its refund obligation: brand-new
  // models, tenantId required from inception.
  'OrderClosure',
  'OrderRefundObligation',
  // SC3c-3 — the business's billing contact: a brand-new model, tenantId
  // required from inception.
  'TenantBillingContact',
  // SC4d — a location's opening hours: a brand-new model, tenantId
  // required from inception.
  'LocationOpeningPeriod',
  // ESP-03 PR 4 — the saved checkout a payment pays for: a brand-new
  // model, tenantId required from inception.
  'CheckoutSnapshot',
  // ESP-03 PR 6 — server-owned checkout sessions: a brand-new model,
  // tenantId required from inception.
  'CheckoutSession',
  // ESP-03 PR 8 — pre-charge financial holds: a brand-new model, tenantId
  // required from inception.
  "FinancialHold",
  // ESP-03 PR 5 — platform support's notes on a reconciliation case: a
  // brand-new model, tenantId required from inception.
  'PaymentReconciliationNote',
  // S0D-2E — the internal admin identity/authorization chain. InternalUser
  // and InternalRole have no owning parent (backfilled straight to
  // Tenant #1, like Customer in S0D-2B-1); InternalRolePermission and
  // InternalUserRoleAssignment inherit their parent's tenant (InternalRole
  // and InternalUser respectively).
  'InternalUser',
  'InternalRole',
  'InternalRolePermission',
  'InternalUserRoleAssignment',
  // Tenant isolation phase 2 — every remaining tenant-owned model. Roots
  // are stamped from the request TenantContext (or, for customer-facing
  // writes, the server-validated Location / Customer / GiftCardPurchase);
  // children and order snapshots copy their validated parent. The
  // backfill derives every legacy NULL from a reliable relationship and
  // aborts on anything ambiguous — it never assumes Tenant #1.
  'InternalAuditEvent',
  'ApprovalRequest',
  'MediaAsset',
  'CmsPage',
  'CustomerLoyaltyAccount',
  'MochaBeanLedgerEntry',
  'LoyaltyConfiguration',
  'LoyaltyReward',
  'LoyaltyRewardProduct',
  'LoyaltyRewardCategory',
  'OrderLoyaltyRewardRedemption',
  'LoyaltyBonusPromotion',
  'LoyaltyBonusPromotionProduct',
  'LoyaltyBonusPromotionLocation',
  'OrderLoyaltyBonus',
  'OrderLoyaltyBonusItem',
  'Promotion',
  'PromotionProduct',
  'PromotionCategory',
  'PromotionLocation',
  'PromotionCustomerUsage',
  'OrderPromotionRedemption',
  'GiftCard',
  'GiftCardTransaction',
  'OrderGiftCardRedemption',
  'GiftCardConfiguration',
  'Campaign',
  'CampaignProduct',
];
