import type { Prisma } from '../generated/prisma/client';

// How each Prisma model relates to tenancy (S0A §5, S0B ADR-4/ADR-8).
//
//   tenant   — business data that belongs to exactly one tenant. Every one
//              of these will carry its own tenantId (S0D) and become
//              tenant-enforced (S0E). This deliberately includes the
//              internal-user models: under the ADR-4 amendment InternalUser
//              is the tenant-scoped membership, and roles / role permissions
//              / role assignments are tenant-owned.
//   platform — platform-plane metadata that is not any one tenant's data
//              (Tenant itself now; StaffIdentity, TenantSession and
//              PlatformOperator when they are introduced).
//
// A `Record` over Prisma.ModelName, so adding a model to the schema without
// classifying it here is a TYPE ERROR — a new model can never silently fall
// outside tenant accounting.
export type ModelTenancy = 'tenant' | 'platform';

export const MODEL_TENANCY: Readonly<Record<Prisma.ModelName, ModelTenancy>> =
  Object.freeze({
    // Platform plane
    Tenant: 'platform',
    // SC1a — CENTERIVO platform operators and their audit trail. No tenantId
    // and no reference to any business record (see the security test's
    // APPROVED_GLOBAL_MODELS).
    PlatformOperator: 'platform',
    PlatformAuditEvent: 'platform',
    // SC1d — one row per completed business provisioning (idempotency).
    TenantProvisioningOperation: 'platform',
    // SC2a — SaaS plans, subscriptions, add-on grants and their history.
    SubscriptionPlan: 'platform',
    SubscriptionPlanVersion: 'platform',
    TenantSubscription: 'platform',
    TenantModuleGrant: 'platform',
    TenantSubscriptionEvent: 'platform',
    // SC3a — SaaS billing: list prices, the billing policy, one-trial claims
    // and the billing-provider event ledger. Reach a business only through
    // TenantSubscription; nothing here touches restaurant payments.
    SubscriptionPlanPrice: 'platform',
    BillingPolicy: 'platform',
    BillingTrialClaim: 'platform',
    BillingProviderEvent: 'platform',
    // SC3b — Checkout sessions we created and review-only reconciliation
    // cases.
    BillingCheckoutSession: 'platform',
    BillingReconciliationCase: 'platform',
    // SC3c-3 — grace extensions and the billing notification queue.
    BillingGraceExtension: 'platform',
    BillingPlanChange: 'platform',
    // SC3e-1 — the subscription invoice history.
    BillingInvoice: 'platform',
    // SC3e-2 — operator permissions, complimentary grants, case actions.
    PlatformOperatorPermission: 'platform',
    BillingComplimentaryGrant: 'platform',
    BillingReconciliationCaseAction: 'platform',
    // SC3e-3 — refunds and credits, their decisions and history.
    BillingAdjustment: 'platform',
    BillingAdjustmentDecision: 'platform',
    BillingAdjustmentEvent: 'platform',
    // SC3e-4 — when billing enforcement ran.
    BillingEnforcementActivation: 'platform',
    BillingNotification: 'platform',

    // Catalog & locations
    Location: 'tenant',
    Category: 'tenant',
    Product: 'tenant',
    Menu: 'tenant',
    ModifierGroup: 'tenant',
    ModifierOption: 'tenant',
    ProductModifierGroup: 'tenant',
    MenuProduct: 'tenant',
    LocationMenu: 'tenant',
    LocationProductPriceOverride: 'tenant',
    LocationProductAvailabilityOverride: 'tenant',

    // Customers
    Customer: 'tenant',
    CustomerPreferredLocation: 'tenant',

    // Checkout, orders, outbox & notifications
    PaymentAttempt: 'tenant',
    Order: 'tenant',
    OrderLine: 'tenant',
    OrderStatusHistory: 'tenant',
    OutboxEvent: 'tenant',
    NotificationDelivery: 'tenant',
    NotificationRecipient: 'tenant',
    // SC3c-3 — the business's designated billing contact (its own staff).
    TenantBillingContact: 'tenant',
    // ESP-03 — payment recovery: reconciliation cases and their append-only
    // history, tenant-owned from inception.
    PaymentReconciliationCase: 'tenant',
    PaymentReconciliationEvent: 'tenant',
    // R1 / S5a — order closure foundation.
    OrderClosure: 'tenant',
    OrderRefundObligation: 'tenant',

    // Internal users, authorization & audit (tenant-scoped per ADR-4)
    InternalUser: 'tenant',
    InternalAuditEvent: 'tenant',
    InternalRole: 'tenant',
    InternalRolePermission: 'tenant',
    InternalUserRoleAssignment: 'tenant',

    // Store operations
    ChecklistTemplate: 'tenant',
    ChecklistTemplateItem: 'tenant',
    ChecklistInstance: 'tenant',
    ChecklistInstanceItem: 'tenant',
    OperationsTask: 'tenant',

    // Loyalty
    CustomerLoyaltyAccount: 'tenant',
    MochaBeanLedgerEntry: 'tenant',
    LoyaltyConfiguration: 'tenant',
    LoyaltyReward: 'tenant',
    LoyaltyRewardProduct: 'tenant',
    LoyaltyRewardCategory: 'tenant',
    OrderLoyaltyRewardRedemption: 'tenant',
    LoyaltyBonusPromotion: 'tenant',
    LoyaltyBonusPromotionProduct: 'tenant',
    LoyaltyBonusPromotionLocation: 'tenant',
    OrderLoyaltyBonus: 'tenant',
    OrderLoyaltyBonusItem: 'tenant',

    // Promotions
    Promotion: 'tenant',
    PromotionProduct: 'tenant',
    PromotionCategory: 'tenant',
    PromotionLocation: 'tenant',
    PromotionCustomerUsage: 'tenant',
    OrderPromotionRedemption: 'tenant',

    // Gift cards
    GiftCard: 'tenant',
    GiftCardTransaction: 'tenant',
    OrderGiftCardRedemption: 'tenant',
    GiftCardPurchase: 'tenant',
    GiftCardConfiguration: 'tenant',

    // Careers, CRM, franchising
    JobOpening: 'tenant',
    JobApplication: 'tenant',
    JobApplicationNote: 'tenant',
    CustomerNote: 'tenant',
    FranchiseInquiry: 'tenant',
    FranchiseInquiryNote: 'tenant',

    // Content, media, marketing, approvals
    CmsPage: 'tenant',
    MediaAsset: 'tenant',
    Campaign: 'tenant',
    CampaignProduct: 'tenant',
    ApprovalRequest: 'tenant',
  });

// Classification for a model name as Prisma reports it at runtime. An
// unrecognised name returns `undefined` so callers can treat it as the
// unsafe case rather than assuming it is platform data.
export function classifyModel(model: string | undefined): ModelTenancy | undefined {
  if (!model || !Object.prototype.hasOwnProperty.call(MODEL_TENANCY, model)) {
    return undefined;
  }
  return MODEL_TENANCY[model as Prisma.ModelName];
}
