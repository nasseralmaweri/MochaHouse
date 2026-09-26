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
