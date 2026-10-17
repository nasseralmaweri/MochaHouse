export interface LocationSummary {
    id: string;
    name: string;
    slug: string;
    isDigitalOrderingEnabled: boolean;
}
export interface MenuSummary {
    id: string;
    name: string;
    slug: string;
}
export interface CategorySummary {
    id: string;
    name: string;
    slug: string;
    displayOrder: number;
}
export interface ProductSummary {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    basePrice: number | null;
    currency: string;
    category: CategorySummary;
}
export interface ModifierOptionSummary {
    id: string;
    name: string;
    priceAdjustment: number;
    displayOrder: number;
}
export interface ModifierGroupSummary {
    id: string;
    name: string;
    displayOrder: number;
    isRequired: boolean;
    minSelections: number;
    maxSelections: number | null;
    options: ModifierOptionSummary[];
}
export interface EffectiveMenuProduct {
    displayOrder: number;
    effectivePrice: number | null;
    isAvailable: boolean;
    product: ProductSummary;
    modifierGroups: ModifierGroupSummary[];
}
export interface LocationMenuResponse {
    location: LocationSummary;
    menu: {
        id: string;
        name: string;
        slug: string;
        products: EffectiveMenuProduct[];
    };
}
export interface AdminLocationSummary {
    id: string;
    name: string;
    slug: string;
    isActive: boolean;
    isDigitalOrderingEnabled: boolean;
}
export interface AdminLocationAssignedMenu {
    id: string;
    name: string;
    slug: string;
    isActive: boolean;
    productCount: number;
}
export interface AdminLocationDetail extends AdminLocationSummary {
    assignedMenu: AdminLocationAssignedMenu | null;
}
export interface AdminUpdateLocationRequest {
    name?: string;
    isActive?: boolean;
}
export interface AdminProductCategoryRef {
    id: string;
    name: string;
}
export interface AdminProductSummary {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    basePrice: number | null;
    currency: string;
    isActive: boolean;
    category: AdminProductCategoryRef;
}
export type AdminProductDetail = AdminProductSummary;
export interface AdminUpdateProductRequest {
    name?: string;
    description?: string | null;
    basePrice?: number | null;
    isActive?: boolean;
}
export declare const CATALOG_NAME_MAX_LENGTH = 120;
export declare const CATALOG_DESCRIPTION_MAX_LENGTH = 1000;
export declare const CATALOG_SLUG_MAX_LENGTH = 80;
export declare const CATALOG_MAX_PRICE_MINOR_UNITS = 100000;
export declare function isValidCatalogSlug(value: string): boolean;
export declare function slugifyCatalogName(name: string): string;
export interface AdminCategorySummary {
    id: string;
    name: string;
    slug: string;
    displayOrder: number;
    isActive: boolean;
    productCount: number;
}
export interface AdminCreateCategoryRequest {
    name: string;
    slug?: string | null;
    isActive?: boolean;
}
export interface AdminCreateProductRequest {
    name: string;
    categoryId: string;
    description?: string | null;
    basePrice: number | null;
    isActive?: boolean;
    slug?: string | null;
}
export interface AdminAddMenuProductRequest {
    productId: string;
    isActive?: boolean;
}
export interface AdminMenuPlacement {
    menuId: string;
    productId: string;
    displayOrder: number;
    isActive: boolean;
}
export interface AdminAddMenuProductResponse {
    placement: AdminMenuPlacement;
    created: boolean;
}
export interface AdminMenuSummary {
    id: string;
    name: string;
    slug: string;
    isActive: boolean;
}
export interface AdminMenuProduct {
    productId: string;
    productName: string;
    productIsActive: boolean;
    categoryName: string;
    standardPrice: number | null;
    currency: string;
    shownOnMenu: boolean;
    displayOrder: number;
}
export interface AdminMenuDetail extends AdminMenuSummary {
    products: AdminMenuProduct[];
}
export interface AdminLocationMenuProduct {
    productId: string;
    productName: string;
    productIsActive: boolean;
    categoryName: string;
    currency: string;
    shownOnMenu: boolean;
    standardPrice: number | null;
    locationPrice: number | null;
    resultingPrice: number | null;
    locationAvailability: boolean | null;
    resultingAvailability: boolean;
}
export interface AdminLocationMenuResponse {
    location: {
        id: string;
        name: string;
    };
    menu: {
        id: string;
        name: string;
    };
    products: AdminLocationMenuProduct[];
}
export type PaymentAttemptStatus = "PENDING" | "SUCCEEDED" | "DECLINED" | "FAILED";
export type OrderStatus = "RECEIVED" | "ACCEPTED" | "PREPARING" | "READY" | "COMPLETED" | "REJECTED" | "CANCELLED";
export interface GuestContactInput {
    name: string;
    phone: string;
    email?: string | null;
}
export interface CheckoutLineSelectionInput {
    groupId: string;
    optionIds: string[];
}
export interface CheckoutLineInput {
    productId: string;
    quantity: number;
    selections: CheckoutLineSelectionInput[];
}
export interface CheckoutRequest {
    idempotencyKey: string;
    locationId: string;
    guest: GuestContactInput;
    lines: CheckoutLineInput[];
    loyaltyRewardId?: string | null;
    couponCode?: string | null;
    giftCardCode?: string | null;
}
export interface OrderLoyaltyRewardSummary {
    rewardName: string;
    rewardType: LoyaltyRewardType;
    beanCost: number;
    discountMinorUnits: number;
    freeItemName: string | null;
}
export interface OrderGiftCardSummary {
    last4: string;
    amountMinorUnits: number;
}
export type PromotionKind = "AUTOMATIC" | "COUPON";
export type PromotionDiscountType = "PERCENTAGE_OFF" | "FIXED_AMOUNT" | "FREE_ITEM";
export interface OrderPromotionSummary {
    name: string;
    kind: PromotionKind;
    couponCode: string | null;
    discountType: PromotionDiscountType;
    discountValue: number;
    discountMinorUnits: number;
    freeItemName: string | null;
}
export interface OrderLoyaltyBonusItemSummary {
    promotionName: string;
    promotionType: LoyaltyBonusPromotionType;
    bonusValue: number;
    productName: string;
    qualifyingUnits: number;
    bonusBeans: number;
}
export interface OrderLoyaltyBonusSummary {
    totalBonusBeans: number;
    items: OrderLoyaltyBonusItemSummary[];
}
export interface OrderLineSummary {
    productId: string;
    productName: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    currency: string;
    selections: {
        groupName: string;
        optionNames: string[];
    }[];
}
export interface OrderConfirmation {
    orderId: string;
    orderNumber: string;
    accessToken: string;
    status: OrderStatus;
    locationId: string;
    locationName: string;
    guestName: string;
    subtotal: number;
    promotionDiscount: number;
    rewardDiscount: number;
    total: number;
    giftCardTenderMinorUnits: number;
    externalPaymentMinorUnits: number;
    currency: string;
    lines: OrderLineSummary[];
    orderPromotion: OrderPromotionSummary | null;
    loyaltyReward: OrderLoyaltyRewardSummary | null;
    loyaltyBonus: OrderLoyaltyBonusSummary | null;
    orderGiftCard: OrderGiftCardSummary | null;
    createdAt: string;
}
export interface OrderStatusResponse {
    orderId: string;
    orderNumber: string;
    status: OrderStatus;
    paymentStatus: PaymentAttemptStatus;
    locationName: string;
    guestName: string;
    subtotal: number;
    promotionDiscount: number;
    rewardDiscount: number;
    total: number;
    giftCardTenderMinorUnits: number;
    externalPaymentMinorUnits: number;
    currency: string;
    lines: OrderLineSummary[];
    orderPromotion: OrderPromotionSummary | null;
    loyaltyReward: OrderLoyaltyRewardSummary | null;
    loyaltyBonus: OrderLoyaltyBonusSummary | null;
    orderGiftCard: OrderGiftCardSummary | null;
    createdAt: string;
}
export interface CheckoutDeclinedResponse {
    outcome: "declined" | "failed";
    message: string;
}
export type CustomerAccountStatus = "ACTIVE" | "RESTRICTED" | "DEACTIVATED";
export interface CustomerProfile {
    id: string;
    email: string | null;
    displayName: string | null;
    status: CustomerAccountStatus;
    emailVerified: boolean;
    createdAt: string;
}
export type CustomerPreferredLocationsResponse = LocationSummary[];
export interface AddPreferredLocationRequest {
    locationId: string;
}
export interface CustomerCommunicationPreferences {
    marketingEmailOptIn: boolean;
}
export interface CustomerUpdateCommunicationPreferencesRequest {
    marketingEmailOptIn: boolean;
}
export interface CustomerUpdateProfileRequest {
    displayName: string | null;
}
export interface CustomerSignInRequest {
    identifier: string;
    password: string;
}
export interface CustomerSignInResponse {
    idToken: string;
    expiresInSeconds: number;
}
export interface CustomerRegisterRequest {
    email: string;
    password: string;
    displayName: string;
}
export interface CustomerRegisterResponse {
    email: string;
}
export interface CustomerVerifyRequest {
    email: string;
    code: string;
}
export interface CustomerVerifyResponse {
    email: string;
}
export interface CustomerResendVerificationRequest {
    email: string;
}
export interface CustomerResendVerificationResponse {
    email: string;
}
export interface CustomerForgotPasswordRequest {
    email: string;
}
export interface CustomerForgotPasswordResponse {
    message: string;
}
export interface CustomerResetPasswordRequest {
    email: string;
    code: string;
    newPassword: string;
}
export interface CustomerResetPasswordResponse {
    email: string;
}
export interface CustomerOrderSummary {
    orderId: string;
    orderNumber: string;
    createdAt: string;
    locationName: string;
    status: OrderStatus;
    subtotal: number;
    promotionDiscount: number;
    rewardDiscount: number;
    total: number;
    giftCardTenderMinorUnits: number;
    externalPaymentMinorUnits: number;
    currency: string;
}
export interface CustomerOrderDetail extends CustomerOrderSummary {
    lines: OrderLineSummary[];
    orderPromotion: OrderPromotionSummary | null;
    loyaltyReward: OrderLoyaltyRewardSummary | null;
    loyaltyBonus: OrderLoyaltyBonusSummary | null;
    orderGiftCard: OrderGiftCardSummary | null;
}
export type LoyaltyRewardType = "FIXED_AMOUNT" | "FREE_ITEM";
export interface CustomerLoyaltyReward {
    id: string;
    name: string;
    description: string | null;
    type: LoyaltyRewardType;
    beanCost: number;
    fixedAmountMinorUnits: number | null;
    eligibleItemNames: string[];
    canAfford: boolean;
}
export interface CustomerLoyaltySummary {
    balance: number;
    rewards: CustomerLoyaltyReward[];
    available: boolean;
}
export interface CheckoutRewardEligibilityRequest {
    locationId: string;
    lines: CheckoutLineInput[];
}
export interface CheckoutRewardOption {
    rewardId: string;
    name: string;
    description: string | null;
    type: LoyaltyRewardType;
    beanCost: number;
    discountMinorUnits: number;
    freeItemName: string | null;
    canAfford: boolean;
}
export interface CheckoutRewardEligibilityResponse {
    balance: number;
    rewards: CheckoutRewardOption[];
    available: boolean;
}
export interface CheckoutQuoteRequest {
    locationId: string;
    lines: CheckoutLineInput[];
    couponCode?: string | null;
    loyaltyRewardId?: string | null;
    giftCardCode?: string | null;
}
export type CouponQuoteStatus = "applied" | "invalid" | "inactive" | "not_started" | "expired" | "wrong_location" | "not_applicable" | "minimum_not_met" | "usage_limit_reached" | "sign_in_required" | "not_available";
export interface CheckoutQuoteRegularDiscount {
    source: PromotionKind;
    name: string;
    discountType: PromotionDiscountType;
    discountMinorUnits: number;
    freeItemName: string | null;
}
export type GiftCardQuoteStatus = "applied" | "not_found" | "inactive" | "no_balance" | "currency_mismatch";
export interface CheckoutQuoteGiftCard {
    last4: string;
    availableBalanceMinorUnits: number;
    appliedMinorUnits: number;
}
export interface CheckoutQuoteResponse {
    currency: string;
    subtotal: number;
    regularDiscount: CheckoutQuoteRegularDiscount | null;
    couponStatus: CouponQuoteStatus | null;
    couponMessage: string | null;
    balance: number;
    rewards: CheckoutRewardOption[];
    rewardDiscountMinorUnits: number;
    total: number;
    giftCardStatus: GiftCardQuoteStatus | null;
    giftCardMessage: string | null;
    giftCard: CheckoutQuoteGiftCard | null;
    amountDueAfterGiftCardMinorUnits: number;
    loyaltyAvailable: boolean;
    promotionsAvailable: boolean;
}
export interface LoyaltySettings {
    earningRatePerDollar: number;
}
export interface UpdateLoyaltySettingsRequest {
    earningRatePerDollar: number;
}
export interface AdminLoyaltyRewardCatalogRef {
    id: string;
    name: string;
}
export interface AdminLoyaltyReward {
    id: string;
    name: string;
    description: string | null;
    type: LoyaltyRewardType;
    beanCost: number;
    fixedAmountMinorUnits: number | null;
    isActive: boolean;
    sortOrder: number;
    eligibleProducts: AdminLoyaltyRewardCatalogRef[];
    eligibleCategories: AdminLoyaltyRewardCatalogRef[];
    createdAt: string;
    updatedAt: string;
}
export interface AdminLoyaltyRewardsResponse {
    rewards: AdminLoyaltyReward[];
}
export interface AdminLoyaltyCatalogOptions {
    products: AdminLoyaltyRewardCatalogRef[];
    categories: AdminLoyaltyRewardCatalogRef[];
}
export interface CreateLoyaltyRewardRequest {
    name: string;
    description?: string | null;
    type: LoyaltyRewardType;
    beanCost: number;
    fixedAmountMinorUnits?: number | null;
    eligibleProductIds?: string[];
    eligibleCategoryIds?: string[];
    sortOrder?: number;
}
export interface UpdateLoyaltyRewardRequest {
    name?: string;
    description?: string | null;
    beanCost?: number;
    fixedAmountMinorUnits?: number | null;
    eligibleProductIds?: string[];
    eligibleCategoryIds?: string[];
    isActive?: boolean;
    sortOrder?: number;
}
export type LoyaltyBonusPromotionType = "EXTRA_BEANS" | "MULTIPLIER";
export interface AdminLoyaltyBonusPromotion {
    id: string;
    name: string;
    type: LoyaltyBonusPromotionType;
    bonusValue: number;
    isActive: boolean;
    startsAt: string | null;
    endsAt: string | null;
    appliesToAllLocations: boolean;
    eligibleProducts: AdminLoyaltyRewardCatalogRef[];
    eligibleLocations: AdminLoyaltyRewardCatalogRef[];
    createdAt: string;
    updatedAt: string;
}
export interface AdminLoyaltyBonusPromotionsResponse {
    promotions: AdminLoyaltyBonusPromotion[];
}
export interface AdminLoyaltyBonusPromotionOptions {
    products: AdminLoyaltyRewardCatalogRef[];
    locations: AdminLoyaltyRewardCatalogRef[];
}
export interface CreateLoyaltyBonusPromotionRequest {
    name: string;
    type: LoyaltyBonusPromotionType;
    bonusValue: number;
    eligibleProductIds: string[];
    appliesToAllLocations?: boolean;
    eligibleLocationIds?: string[];
    startsAt?: string | null;
    endsAt?: string | null;
}
export interface UpdateLoyaltyBonusPromotionRequest {
    name?: string;
    bonusValue?: number;
    eligibleProductIds?: string[];
    appliesToAllLocations?: boolean;
    eligibleLocationIds?: string[];
    startsAt?: string | null;
    endsAt?: string | null;
    isActive?: boolean;
}
export type PromotionApplicability = "ENTIRE_ORDER" | "SELECTED_PRODUCTS" | "SELECTED_CATEGORIES";
export interface AdminPromotionCatalogRef {
    id: string;
    name: string;
}
export interface AdminPromotion {
    id: string;
    name: string;
    description: string | null;
    kind: PromotionKind;
    code: string | null;
    discountType: PromotionDiscountType;
    discountValue: number;
    maxDiscountMinorUnits: number | null;
    applicability: PromotionApplicability;
    minimumSubtotalMinorUnits: number | null;
    isActive: boolean;
    startsAt: string | null;
    endsAt: string | null;
    appliesToAllLocations: boolean;
    totalRedemptionLimit: number | null;
    perCustomerRedemptionLimit: number | null;
    redemptionCount: number;
    eligibleProducts: AdminPromotionCatalogRef[];
    eligibleCategories: AdminPromotionCatalogRef[];
    eligibleLocations: AdminPromotionCatalogRef[];
    createdAt: string;
    updatedAt: string;
}
export interface AdminPromotionsResponse {
    promotions: AdminPromotion[];
}
export interface AdminPromotionOptions {
    products: AdminPromotionCatalogRef[];
    categories: AdminPromotionCatalogRef[];
    locations: AdminPromotionCatalogRef[];
}
export interface CreatePromotionRequest {
    name: string;
    description?: string | null;
    kind: PromotionKind;
    code?: string | null;
    discountType: PromotionDiscountType;
    discountValue?: number;
    maxDiscountMinorUnits?: number | null;
    applicability?: PromotionApplicability;
    eligibleProductIds?: string[];
    eligibleCategoryIds?: string[];
    minimumSubtotalMinorUnits?: number | null;
    appliesToAllLocations?: boolean;
    eligibleLocationIds?: string[];
    startsAt?: string | null;
    endsAt?: string | null;
    totalRedemptionLimit?: number | null;
    perCustomerRedemptionLimit?: number | null;
}
export interface UpdatePromotionRequest {
    name?: string;
    description?: string | null;
    code?: string | null;
    discountValue?: number;
    maxDiscountMinorUnits?: number | null;
    applicability?: PromotionApplicability;
    eligibleProductIds?: string[];
    eligibleCategoryIds?: string[];
    minimumSubtotalMinorUnits?: number | null;
    appliesToAllLocations?: boolean;
    eligibleLocationIds?: string[];
    startsAt?: string | null;
    endsAt?: string | null;
    totalRedemptionLimit?: number | null;
    perCustomerRedemptionLimit?: number | null;
    isActive?: boolean;
}
export type ReorderIssueCode = "LOCATION_INACTIVE" | "LOCATION_DIGITAL_ORDERING_DISABLED" | "PRODUCT_NOT_ON_MENU" | "PRODUCT_UNAVAILABLE" | "PRICE_CHANGED" | "MODIFIER_GROUP_REMOVED" | "MODIFIER_OPTION_REMOVED" | "MODIFIER_REQUIRED_SELECTION_MISSING" | "MODIFIER_SELECTION_COUNT_INVALID";
export interface ReorderIssue {
    code: ReorderIssueCode;
    message: string;
    productName?: string;
}
export type ReorderItemStatus = "VALID" | "CHANGED" | "UNAVAILABLE";
export interface ReorderPreparedSelection {
    groupId: string;
    groupName: string;
    optionIds: string[];
    optionNames: string[];
}
export interface ReorderPreparedItem {
    status: ReorderItemStatus;
    productId: string;
    productName: string;
    quantity: number;
    currency: string;
    historicalUnitPrice: number;
    currentUnitPrice?: number;
    currentLineSubtotal?: number;
    selections: ReorderPreparedSelection[];
    needsCustomization: boolean;
    issues: ReorderIssue[];
}
export type ReorderPreparationStatus = "READY" | "NEEDS_REVIEW" | "UNAVAILABLE";
export interface ReorderPreparation {
    orderId: string;
    location: LocationSummary;
    menuId?: string;
    status: ReorderPreparationStatus;
    items: ReorderPreparedItem[];
    issues: ReorderIssue[];
    historicalTotal: number;
    currentEstimatedSubtotal: number;
}
export interface StoreOrderSummary {
    orderId: string;
    orderNumber: string;
    status: OrderStatus;
    createdAt: string;
    guestName: string;
    subtotal: number;
    currency: string;
    lines: OrderLineSummary[];
}
export interface StoreOrderDetail extends StoreOrderSummary {
    guestPhone: string;
    promotionDiscount: number;
    rewardDiscount: number;
    total: number;
    giftCardTenderMinorUnits: number;
    externalPaymentMinorUnits: number;
    orderPromotion: OrderPromotionSummary | null;
    loyaltyReward: OrderLoyaltyRewardSummary | null;
    loyaltyBonus: OrderLoyaltyBonusSummary | null;
    orderGiftCard: OrderGiftCardSummary | null;
    closure: StoreOrderClosureSummary | null;
}
export declare const ORDER_REJECTION_REASON_CODES: readonly ["ITEM_UNAVAILABLE", "STORE_TOO_BUSY", "STORE_CLOSING", "DUPLICATE_ORDER", "SUSPECTED_FRAUD", "OTHER"];
export type OrderRejectionReasonCode = (typeof ORDER_REJECTION_REASON_CODES)[number];
export declare const ORDER_CANCELLATION_REASON_CODES: readonly ["CUSTOMER_REQUEST", "ITEM_UNAVAILABLE", "EQUIPMENT_FAILURE", "STORE_CLOSING", "DUPLICATE_ORDER", "SUSPECTED_FRAUD", "OTHER"];
export type OrderCancellationReasonCode = (typeof ORDER_CANCELLATION_REASON_CODES)[number];
export type OrderClosureReasonCode = OrderRejectionReasonCode | OrderCancellationReasonCode;
export declare const ORDER_CLOSURE_REASON_LABELS: Record<OrderClosureReasonCode, string>;
export declare const ORDER_CLOSURE_NOTE_MAX_LENGTH = 500;
export type OrderClosureKind = "REJECTED" | "CANCELLED";
export type OrderRefundObligationStatus = "DUE" | "PROCESSING" | "REFUNDED" | "FAILED";
export interface StoreOrderClosureSummary {
    kind: OrderClosureKind;
    fromStatus: OrderStatus;
    reasonCode: string;
    reasonLabel: string;
    note: string | null;
    closedAt: string;
    refundDueMinorUnits: number;
    refundStatus: OrderRefundObligationStatus | null;
    giftCardRestoredMinorUnits: number;
    loyaltyShortfallBeans: number;
}
export interface RejectOrderRequest {
    locationId: string;
    reasonCode: OrderRejectionReasonCode;
    note?: string | null;
}
export interface CancelOrderRequest {
    locationId: string;
    expectedStatus: OrderStatus;
    reasonCode: OrderCancellationReasonCode;
    note?: string | null;
}
export interface CloseOrderResponse {
    orderId: string;
    status: OrderStatus;
    closed: boolean;
    closure: StoreOrderClosureSummary;
}
export interface AdvanceOrderStatusRequest {
    locationId: string;
    expectedStatus: OrderStatus;
}
export interface AdvanceOrderStatusResponse {
    orderId: string;
    status: OrderStatus;
    advanced: boolean;
}
export type InternalUserStatus = "INVITED" | "ACTIVE" | "SUSPENDED" | "DISABLED";
export interface InternalSignInRequest {
    identifier: string;
    password: string;
}
export interface InternalSignInResponse {
    idToken: string;
    expiresInSeconds: number;
}
export type OwnerRegistrationAvailability = {
    enabled: false;
} | {
    enabled: true;
    termsVersion: string;
    privacyVersion: string;
    termsUrl: string | null;
    privacyUrl: string | null;
};
export interface OwnerRegistrationStartRequest {
    email: string;
}
export interface OwnerRegistrationStartResponse {
    status: "CODE_SENT_IF_ELIGIBLE";
}
export interface OwnerRegistrationCompleteRequest {
    email: string;
    code: string;
    password: string;
    displayName: string;
    termsVersion: string;
    privacyVersion: string;
    acceptLegal: boolean;
}
export interface OwnerRegistrationCompleteResponse {
    status: "VERIFIED";
}
export declare const OWNER_REGISTRATION_CODE_INVALID = "REGISTRATION_CODE_INVALID";
export declare const OWNER_REGISTRATION_INVALID_INPUT = "REGISTRATION_INVALID_INPUT";
export declare const OWNER_REGISTRATION_WEAK_PASSWORD = "REGISTRATION_WEAK_PASSWORD";
export declare const OWNER_REGISTRATION_LEGAL_OUTDATED = "REGISTRATION_LEGAL_OUTDATED";
export declare const OWNER_REGISTRATION_UNAVAILABLE = "REGISTRATION_UNAVAILABLE";
export interface OwnerOnboardingPlanPrice {
    planPriceId: string;
    interval: PlatformBillingInterval;
    currency: string;
    amountMinorUnits: number;
}
export interface OwnerOnboardingPlanOption {
    planId: string;
    planVersionId: string;
    name: string;
    description: string | null;
    modules: SubscriptionModuleKey[];
    prices: OwnerOnboardingPlanPrice[];
}
export type OwnerOnboardingStatus = {
    status: "BUSINESS_REQUIRED";
    ownerName: string;
    email: string;
    plans: OwnerOnboardingPlanOption[];
} | {
    status: "BUSINESS_CREATED";
    business: {
        id: string;
        name: string;
    };
};
export interface OwnerBusinessCreateRequest {
    businessName: string;
    planVersionId: string;
    planPriceId: string;
    expectedPrice: {
        interval: PlatformBillingInterval;
        currency: string;
        amountMinorUnits: number;
    };
}
export interface OwnerBusinessCreateResponse {
    business: {
        id: string;
        name: string;
        slug: string;
    };
    replayed: boolean;
}
export declare const ONBOARDING_NOT_ELIGIBLE = "ONBOARDING_NOT_ELIGIBLE";
export declare const ONBOARDING_PLAN_UNAVAILABLE = "ONBOARDING_PLAN_UNAVAILABLE";
export declare const ONBOARDING_PRICE_CHANGED = "ONBOARDING_PRICE_CHANGED";
export interface InternalUserProfile {
    id: string;
    email: string;
    displayName: string | null;
    status: InternalUserStatus;
}
export interface InternalPermissionCapability {
    corporate: boolean;
    locationIds: string[];
}
export interface InternalAuthorizationSummary {
    permissions: InternalPermissionKey[];
    isCorporate: boolean;
    locations: LocationSummary[];
    capabilities: Partial<Record<InternalPermissionKey, InternalPermissionCapability>>;
}
export type InternalBusinessAccess = "FULL" | "BILLING_WIND_DOWN";
export declare const BUSINESS_BILLING_SUSPENDED = "BUSINESS_BILLING_SUSPENDED";
export interface InternalBusinessSummary {
    id: string;
    name: string;
    slug: string;
    access: InternalBusinessAccess;
}
export interface InternalBusinessesResponse {
    businesses: InternalBusinessSummary[];
}
export interface InternalMeResponse {
    business: InternalBusinessSummary;
    user: InternalUserProfile;
    authorization: InternalAuthorizationSummary;
    entitlements: InternalEntitlementsSummary;
}
export interface PlatformOperatorProfile {
    id: string;
    email: string;
    displayName: string | null;
    status: "ACTIVE";
}
export interface PlatformMeResponse {
    operator: PlatformOperatorProfile;
    permissions: PlatformPermission[];
}
export declare const PLATFORM_PERMISSIONS: readonly ["billing.prices.manage", "billing.policy.manage", "billing.accounts.manage", "billing.reconciliation.run", "billing.cases.manage", "billing.schedules.release", "billing.complimentary.manage", "billing.adjustments.request", "billing.adjustments.approve", "platform.permissions.manage", "billing.reports.view"];
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];
export interface PlatformOperatorPermissionView {
    permission: PlatformPermission;
    grantedAt: string;
    grantedVia: "CLI" | "CLI_BOOTSTRAP" | "CONSOLE";
    grantedBy: {
        id: string;
        email: string;
    } | null;
    reason: string;
}
export interface PlatformOperatorDirectoryEntry {
    id: string;
    email: string;
    displayName: string | null;
    status: "ACTIVE" | "DISABLED";
    permissions: PlatformOperatorPermissionView[];
}
export interface PlatformOperatorDirectoryResponse {
    operators: PlatformOperatorDirectoryEntry[];
}
export interface PlatformPermissionChangeRequest {
    permission: PlatformPermission;
    reason: string;
}
export declare const PLATFORM_PERMISSION_SELF = "PLATFORM_PERMISSION_SELF";
export declare const PLATFORM_OPERATOR_NOT_ACTIVE = "PLATFORM_OPERATOR_NOT_ACTIVE";
export declare const PLATFORM_PERMISSION_REQUIRED = "PLATFORM_PERMISSION_REQUIRED";
export interface PlatformSignInRequest {
    email: string;
    password: string;
}
export interface PlatformSignInStepResponse {
    status: "mfa-required" | "mfa-setup-required";
    challenge: string;
}
export interface PlatformChallengeRequest {
    challenge: string;
}
export interface PlatformMfaSetupResponse {
    challenge: string;
}
export interface PlatformMfaSetupDisplayResponse {
    secret: string;
    otpauthUri: string;
}
export interface PlatformChallengeCodeRequest {
    challenge: string;
    code: string;
}
export interface PlatformSessionResponse {
    idToken: string;
    expiresInSeconds: number;
}
export type PlatformTenantStatus = "ACTIVE" | "SUSPENDED";
export type PlatformTenantSuspensionReason = "SECURITY" | "BILLING" | "REQUESTED";
export interface PlatformTenantSummary {
    id: string;
    slug: string;
    name: string;
    status: PlatformTenantStatus;
    suspensionReason: PlatformTenantSuspensionReason | null;
    createdAt: string;
    locationCount: number;
}
export interface PlatformTenantListResponse {
    tenants: PlatformTenantSummary[];
    page: number;
    pageSize: number;
    total: number;
    registry: {
        total: number;
        active: number;
        suspended: number;
    };
}
export interface PlatformTenantDetailResponse {
    tenant: Omit<PlatformTenantSummary, "locationCount"> & {
        updatedAt: string;
    };
    locations: {
        total: number;
        active: number;
        digitalOrderingEnabled: number;
    };
}
export interface PlatformTenantLocation {
    id: string;
    name: string;
    slug: string;
    isActive: boolean;
    isDigitalOrderingEnabled: boolean;
    createdAt: string;
}
export interface PlatformTenantLocationListResponse {
    locations: PlatformTenantLocation[];
    page: number;
    pageSize: number;
    total: number;
}
export declare const PLATFORM_TENANT_SLUG_TAKEN = "SLUG_TAKEN";
export declare const PLATFORM_IDEMPOTENCY_KEY_REUSED = "IDEMPOTENCY_KEY_REUSED";
export interface PlatformTenantProvisionRequest {
    name: string;
    slug: string;
    ownerEmail: string;
    ownerDisplayName?: string | null;
    planVersionId: string;
}
export interface PlatformTenantProvisionResponse {
    tenant: {
        id: string;
        slug: string;
        name: string;
        status: PlatformTenantStatus;
        createdAt: string;
    };
    owner: {
        email: string;
        displayName: string | null;
    };
    replayed: boolean;
}
export declare const PLATFORM_LIFECYCLE_RECENT_SIGN_IN_SECONDS: number;
export declare const PLATFORM_REAUTHENTICATION_REQUIRED = "REAUTHENTICATION_REQUIRED";
export declare const PLATFORM_TENANT_PROTECTED = "TENANT_PROTECTED";
export declare const PLATFORM_BILLING_SUSPENSION_ACTIVE = "BILLING_SUSPENSION_ACTIVE";
export declare const PLATFORM_BILLING_NOT_EXTENDABLE = "BILLING_NOT_EXTENDABLE";
export declare const PLATFORM_BILLING_EXTENSION_LIMIT = "BILLING_EXTENSION_LIMIT";
export declare const PLATFORM_BILLING_NOT_RECOVERABLE = "BILLING_NOT_RECOVERABLE";
export declare const PLATFORM_BILLING_CONTACT_NOT_ELIGIBLE = "BILLING_CONTACT_NOT_ELIGIBLE";
export declare const PLATFORM_OWNER_ALREADY_SIGNED_IN = "OWNER_ALREADY_SIGNED_IN";
export declare const PLATFORM_OWNER_EMAIL_IN_USE = "OWNER_EMAIL_IN_USE";
export interface PlatformTenantOwner {
    id: string;
    email: string;
    displayName: string | null;
    signedIn: boolean;
}
export interface PlatformTenantLifecycleResponse {
    tenantId: string;
    status: PlatformTenantStatus;
    suspensionReason: PlatformTenantSuspensionReason | null;
    protected: boolean;
    owner: PlatformTenantOwner | null;
    impact: {
        openOrders: number;
        pendingNotifications: number;
    };
}
export interface PlatformTenantSuspendRequest {
    reason: PlatformTenantSuspensionReason;
}
export interface PlatformTenantStatusChangeResponse {
    status: PlatformTenantStatus;
    suspensionReason: PlatformTenantSuspensionReason | null;
    changed: boolean;
}
export interface PlatformTenantOwnerEmailRequest {
    ownerId: string;
    email: string;
}
export interface PlatformTenantOwnerEmailResponse {
    owner: PlatformTenantOwner;
    changed: boolean;
}
export type PlatformPlanVersionStatus = "DRAFT" | "PUBLISHED" | "RETIRED";
export declare const PLATFORM_PLAN_KEY_TAKEN = "PLAN_KEY_TAKEN";
export declare const PLATFORM_PLAN_DRAFT_EXISTS = "PLAN_DRAFT_EXISTS";
export declare const PLATFORM_PLAN_VERSION_NOT_DRAFT = "PLAN_VERSION_NOT_DRAFT";
export declare const PLATFORM_PLAN_VERSION_NOT_PUBLISHED = "PLAN_VERSION_NOT_PUBLISHED";
export declare const PLATFORM_NO_SUBSCRIPTION = "NO_SUBSCRIPTION";
export declare const PLATFORM_ADDON_IN_PLAN = "ADDON_IN_PLAN";
export declare const PLATFORM_SUBSCRIPTION_BILLED = "SUBSCRIPTION_BILLED";
export interface PlatformPlanVersion {
    id: string;
    version: number;
    status: PlatformPlanVersionStatus;
    moduleKeys: OptionalModuleKey[];
    publishedAt: string | null;
    retiredAt: string | null;
    subscriberCount: number;
}
export type PlatformBillingInterval = "MONTH" | "YEAR";
export type PlatformPlanPriceStatus = "ACTIVE" | "ARCHIVED";
export interface PlatformPlanPrice {
    id: string;
    interval: PlatformBillingInterval;
    currency: string;
    amountMinorUnits: number;
    status: PlatformPlanPriceStatus;
    createdAt: string;
    archivedAt: string | null;
    subscriberCount: number;
}
export interface PlatformPlan {
    id: string;
    key: string;
    name: string;
    description: string | null;
    selfServiceAvailable: boolean;
    versions: PlatformPlanVersion[];
    prices: PlatformPlanPrice[];
}
export interface PlatformPlanSelfServiceRequest {
    available: boolean;
}
export declare const PLATFORM_PLAN_NOT_SELF_SERVICE = "PLAN_NOT_SELF_SERVICE";
export declare const PLATFORM_PRICE_NOT_ACTIVE = "PRICE_NOT_ACTIVE";
export declare const PLATFORM_NO_MONTHLY_PRICE = "NO_MONTHLY_PRICE";
export interface PlatformPlanPriceCreateRequest {
    interval: PlatformBillingInterval;
    currency?: string;
    amountMinorUnits?: number;
    annualDiscountBasisPoints?: number;
}
export interface PlatformBillingPolicy {
    trialDays: number;
    trialRequiresPaymentMethod: boolean;
    gracePeriodDays: number;
    updatedAt: string;
}
export interface PlatformBillingPolicyUpdateRequest {
    trialDays: number;
    trialRequiresPaymentMethod: boolean;
    gracePeriodDays: number;
}
export type BusinessBillingState = "COMPLIMENTARY" | "AWAITING_SETUP" | "TRIALING" | "ACTIVE" | "PAST_DUE" | "UNPAID" | "TRIAL_EXPIRED" | "CANCELED";
export interface BusinessBillingSummary {
    state: BusinessBillingState;
    planName: string;
    price: {
        amountMinorUnits: number;
        currency: string;
        interval: PlatformBillingInterval;
    } | null;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
    graceEndsAt: string | null;
    recoveryEndsAt: string | null;
    graceExceptionEndsAt: string | null;
    enforced: boolean;
    premiumPaused: boolean;
    suspendedForBilling: boolean;
    cancelAtPeriodEnd: boolean;
    paymentMethodOnFile: boolean;
    initialSetupPending: boolean;
    paymentSetup: {
        required: boolean;
        since: string | null;
        deadline: string | null;
        expired: boolean;
    };
}
export declare const BILLING_UNAVAILABLE = "BILLING_UNAVAILABLE";
export declare const BILLING_NOT_BILLED = "BILLING_NOT_BILLED";
export declare const BILLING_ALREADY_SET_UP = "BILLING_ALREADY_SET_UP";
export declare const BILLING_CHECKOUT_IN_PROGRESS = "BILLING_CHECKOUT_IN_PROGRESS";
export declare const BILLING_CHECKOUT_PROCESSING = "BILLING_CHECKOUT_PROCESSING";
export declare const BILLING_TRIAL_PENDING_ELSEWHERE = "BILLING_TRIAL_PENDING_ELSEWHERE";
export declare const BILLING_NOTHING_TO_PAY = "BILLING_NOTHING_TO_PAY";
export declare const BILLING_SUBSCRIPTION_NOT_ENDED = "BILLING_SUBSCRIPTION_NOT_ENDED";
export declare const BILLING_RECOVERY_UNDER_REVIEW = "BILLING_RECOVERY_UNDER_REVIEW";
export interface AdminBillingResponse {
    billing: BusinessBillingSummary;
    canSetUpPayment: boolean;
    canRestartSubscription: boolean;
    canPayInvoice: boolean;
    canManagePaymentMethod: boolean;
    canChangePlan: boolean;
    planChange: AdminPlanChangeView | null;
    initialSetup: AdminInitialSetupView | null;
}
export interface AdminInitialSetupView {
    selectionAvailable: boolean;
    trial: {
        days: number;
        requiresPaymentMethod: boolean;
    } | null;
    canChangeSelection: boolean;
}
export interface AdminInitialPlanOptionsResponse {
    plans: OwnerOnboardingPlanOption[];
    current: {
        planVersionId: string;
        planPriceId: string;
    };
}
export interface AdminInitialPlanChangeRequest {
    planVersionId: string;
    planPriceId: string;
    expectedPrice: {
        interval: PlatformBillingInterval;
        currency: string;
        amountMinorUnits: number;
    };
}
export declare const BILLING_SELECTION_UNAVAILABLE = "BILLING_SELECTION_UNAVAILABLE";
export declare const BILLING_SELECTION_LOCKED = "BILLING_SELECTION_LOCKED";
export interface AdminBillingCheckoutResponse {
    url: string;
}
export interface AdminBillingRecoveryResponse {
    url: string;
}
export type BillingInvoiceStatus = "open" | "paid" | "void" | "uncollectible";
export type BillingInvoiceReason = "SUBSCRIPTION_START" | "RENEWAL" | "PLAN_CHANGE" | "OTHER";
export interface BillingInvoiceView {
    id: string;
    number: string | null;
    status: BillingInvoiceStatus;
    reason: BillingInvoiceReason;
    currency: string;
    totalMinorUnits: number;
    amountPaidMinorUnits: number;
    amountRemainingMinorUnits: number;
    refundedOrCreditedMinorUnits: number;
    creditAppliedMinorUnits: number;
    periodStart: string | null;
    periodEnd: string | null;
    issuedAt: string;
    paidAt: string | null;
    adjustments: BillingInvoiceAdjustmentView[];
}
export interface BillingInvoiceListResponse {
    invoices: BillingInvoiceView[];
    nextCursor: string | null;
}
export type BillingInvoiceDocumentKind = "invoice" | "pdf";
export interface BillingInvoiceDocumentRequest {
    kind: BillingInvoiceDocumentKind;
}
export declare const BILLING_DOCUMENT_UNAVAILABLE = "BILLING_DOCUMENT_UNAVAILABLE";
export interface BillingPaymentMethodView {
    kind: "NONE" | "CARD" | "OTHER";
    card: {
        brand: string;
        last4: string;
        expMonth: number;
        expYear: number;
        expired: boolean;
    } | null;
}
export interface AdminBillingPaymentMethodResponse {
    paymentMethod: BillingPaymentMethodView | null;
}
export declare const BILLING_PLAN_CHANGE_UNAVAILABLE = "BILLING_PLAN_CHANGE_UNAVAILABLE";
export declare const BILLING_PLAN_CHANGE_SAME_PRICE = "BILLING_PLAN_CHANGE_SAME_PRICE";
export declare const BILLING_PLAN_CHANGE_CURRENCY = "BILLING_PLAN_CHANGE_CURRENCY";
export declare const BILLING_PLAN_CHANGE_IN_PROGRESS = "BILLING_PLAN_CHANGE_IN_PROGRESS";
export declare const BILLING_PLAN_CHANGE_UNVERIFIED = "BILLING_PLAN_CHANGE_UNVERIFIED";
export declare const BILLING_PLAN_CHANGE_PREVIEW_EXPIRED = "BILLING_PLAN_CHANGE_PREVIEW_EXPIRED";
export declare const BILLING_PLAN_CHANGE_PREVIEW_CHANGED = "BILLING_PLAN_CHANGE_PREVIEW_CHANGED";
export declare const BILLING_PLAN_CHANGE_NOT_PAYABLE = "BILLING_PLAN_CHANGE_NOT_PAYABLE";
export declare const BILLING_PLAN_CHANGE_TOO_LATE = "BILLING_PLAN_CHANGE_TOO_LATE";
export declare const BILLING_PLAN_CHANGE_PAYMENT_METHOD_REQUIRED = "BILLING_PLAN_CHANGE_PAYMENT_METHOD_REQUIRED";
export declare const BILLING_PLAN_CHANGE_NOT_CANCELABLE = "BILLING_PLAN_CHANGE_NOT_CANCELABLE";
export type BillingPlanChangeTiming = "IMMEDIATE" | "PERIOD_END" | "TRIAL_END";
export interface BillingPlanChangePreviewRequest {
    planPriceId: string;
}
export interface BillingPlanChangeSide {
    planName: string;
    price: {
        amountMinorUnits: number;
        currency: string;
        interval: PlatformBillingInterval;
    };
}
export interface BillingPlanChangePreview {
    previewId: string;
    timing: BillingPlanChangeTiming;
    current: BillingPlanChangeSide;
    target: BillingPlanChangeSide;
    chargeNow: {
        amountDueMinorUnits: number;
        totalMinorUnits: number;
        taxMinorUnits: number;
        discountMinorUnits: number;
        prorationMinorUnits: number;
        currency: string;
    } | null;
    modules: {
        lost: {
            key: string;
            label: string;
        }[];
        gained: {
            key: string;
            label: string;
        }[];
    };
    nextRecurring: {
        amountMinorUnits: number;
        currency: string;
        interval: PlatformBillingInterval;
        startsAt: string | null;
    };
    expiresAt: string;
}
export type AdminPlanChangeStatus = "SCHEDULED" | "CANCELED" | "PROCESSING" | "PAYMENT_NEEDED" | "APPLIED" | "REVIEW" | "EXPIRED" | "FAILED";
export interface AdminPlanChangeView {
    id: string;
    status: AdminPlanChangeStatus;
    timing: BillingPlanChangeTiming;
    modulesLost: {
        key: string;
        label: string;
    }[];
    effectiveAt: string | null;
    target: BillingPlanChangeSide;
    amountDueMinorUnits: number | null;
    currency: string;
    confirmedAt: string | null;
    finishedAt: string | null;
}
export interface BillingPlanChangeConfirmRequest {
    previewId: string;
}
export interface BillingPlanChangeConfirmResponse {
    planChange: AdminPlanChangeView;
}
export interface BillingPlanChangeCancelRequest {
    planChangeId: string;
}
export interface AdminPlanOption {
    planPriceId: string;
    planName: string;
    amountMinorUnits: number;
    currency: string;
    interval: PlatformBillingInterval;
    current: boolean;
}
export interface AdminPlanOptionsResponse {
    options: AdminPlanOption[];
}
export interface PlatformPlanChangePreviewRequest {
    planPriceId: string;
    reason: string;
}
export declare const PLATFORM_ALREADY_BILLED = "ALREADY_BILLED";
export declare const PLATFORM_FOUNDING_COMPLIMENTARY = "FOUNDING_COMPLIMENTARY";
export declare const PLATFORM_PRICE_NOT_FOR_PLAN = "PRICE_NOT_FOR_PLAN";
export declare const PLATFORM_NO_OWNER = "NO_OWNER";
export interface PlatformStartBillingRequest {
    planPriceId: string;
}
export interface PlatformTenantBillingResponse {
    tenantId: string;
    billing: BusinessBillingSummary | null;
    contact: PlatformBillingContactView;
    extensions: PlatformGraceExtension[];
    extensionDaysRemaining: number | null;
    paymentSetup: PlatformPaymentSetupView | null;
}
export interface PlatformPaymentSetupView {
    enforced: boolean;
    since: string;
    windowStartedAt: string | null;
    deadline: string | null;
    latestDeadline: string | null;
    expired: boolean;
    extensions: (PlatformGraceExtension & {
        operatorEmail: string;
    })[];
}
export interface PlatformPaymentSetupListResponse {
    enforced: boolean;
    items: (PlatformPaymentSetupView & {
        tenantId: string;
        businessName: string;
        planName: string;
    })[];
}
export type BillingRecipientSource = "CONTACT" | "FALLBACK_ADMINISTRATOR";
export type BillingRecipientIneligibility = "NOT_ACTIVE" | "NO_BILLING_MANAGE" | "EMAIL_NOT_VERIFIED" | "EMAIL_VERIFICATION_STALE";
export interface PlatformBillingStaffMember {
    internalUserId: string;
    email: string;
    displayName: string | null;
    ineligibleReason: BillingRecipientIneligibility | null;
}
export interface PlatformBillingContactView {
    designated: PlatformBillingStaffMember | null;
    recipient: (PlatformBillingStaffMember & {
        source: BillingRecipientSource;
    }) | null;
    candidates: PlatformBillingStaffMember[];
}
export interface PlatformAssignBillingContactRequest {
    internalUserId: string;
}
export type PlatformGraceExtensionKind = "GRACE_EXTENDED" | "GRACE_EXCEPTION" | "PAYMENT_SETUP";
export interface PlatformGraceExtension {
    id: string;
    kind: PlatformGraceExtensionKind;
    days: number;
    previousEndsAt: string;
    newEndsAt: string;
    reason: string;
    createdAt: string;
}
export interface PlatformGraceExtensionRequest {
    days: number;
    reason: string;
}
export interface PlatformBillingOverview {
    complimentary: {
        active: number;
        scheduled: number;
        endingSoon: number;
        attention: number;
    };
    inGrace: number;
    unpaid: number;
    billingSuspended: number;
    graceExceptions: number;
    trialRecoveryWindows: number;
    missingContacts: number;
    failedNotifications: number;
    openCases: {
        kind: string;
        count: number;
    }[];
}
export type PlatformReconciliationCaseStatus = "OPEN" | "RESOLVED";
export interface PlatformReconciliationCase {
    id: string;
    kind: string;
    tenantId: string | null;
    businessName: string | null;
    detail: string | null;
    status: PlatformReconciliationCaseStatus;
    createdAt: string;
    resolvedAt: string | null;
    resolutionOutcome: PlatformCaseOutcome | null;
    resolutionNote: string | null;
}
export declare const PLATFORM_CASE_OUTCOMES: readonly ["FIXED_AT_PROVIDER", "SCHEDULE_RELEASED", "CONSISTENT_ON_RECHECK", "NO_ACTION_NEEDED", "DUPLICATE", "NEEDS_FINANCIAL_ADJUSTMENT"];
export type PlatformCaseOutcome = (typeof PLATFORM_CASE_OUTCOMES)[number];
export interface PlatformCaseActionView {
    action: "RECHECKED" | "SCHEDULE_RELEASED" | "CLOSED";
    result: string;
    note: string | null;
    externalScheduleId: string | null;
    actor: {
        id: string;
        email: string;
    };
    at: string;
}
export interface PlatformCaseDetailResponse {
    case: PlatformReconciliationCase;
    actions: PlatformCaseActionView[];
    provider: {
        schedule: {
            externalScheduleId: string;
            status: string;
        } | null;
        scheduleIsOpenPlanChange: boolean;
    } | null;
    providerUnavailable: boolean;
}
export interface PlatformCaseRecheckResponse {
    result: "CONSISTENT" | "MISMATCH_FOUND" | "PROVIDER_UNAVAILABLE";
    openCases: string[];
}
export interface PlatformCaseReleaseRequest {
    externalScheduleId: string;
    reason: string;
}
export interface PlatformCaseCloseRequest {
    outcome: PlatformCaseOutcome;
    note: string;
}
export declare const BILLING_CASE_SCHEDULE_MISMATCH = "BILLING_CASE_SCHEDULE_MISMATCH";
export declare const BILLING_CASE_NOT_RELEASABLE = "BILLING_CASE_NOT_RELEASABLE";
export type PlatformComplimentaryStatus = "SCHEDULED" | "ACTIVE" | "WITHDRAWN" | "ENDED";
export interface PlatformComplimentaryGrantView {
    id: string;
    status: PlatformComplimentaryStatus;
    plan: {
        planName: string;
        versionId: string;
        version: number;
        moduleKeys: string[];
    };
    endsAt: string | null;
    reason: string;
    grantedBy: {
        id: string;
        email: string;
    };
    createdAt: string;
    previousStatus: string;
    previousPlanName: string;
    previousPrice: {
        amountMinorUnits: number;
        currency: string;
        interval: "MONTH" | "YEAR";
    };
    effectiveAt: string | null;
    cancellationVerified: boolean;
    startedAt: string | null;
    finishedAt: string | null;
    finishCode: string | null;
    finishReason: string | null;
    finishedBy: {
        id: string;
        email: string;
    } | null;
    attention: "CANCELLATION_UNVERIFIED" | "ENDS_SOON" | null;
}
export interface PlatformComplimentaryView {
    billingMode: "BILLED" | "COMPLIMENTARY";
    legacyComplimentary: boolean;
    current: PlatformComplimentaryGrantView | null;
    history: PlatformComplimentaryGrantView[];
    eligibility: {
        eligible: boolean;
        reason: string | null;
    };
}
export interface PlatformComplimentaryGrantRequest {
    planVersionId: string;
    endsAt: string | null;
    reason: string;
}
export interface PlatformComplimentaryReasonRequest {
    reason: string;
}
export declare const BILLING_COMPLIMENTARY_NOT_ELIGIBLE = "BILLING_COMPLIMENTARY_NOT_ELIGIBLE";
export declare const BILLING_COMPLIMENTARY_UNPAID_INVOICES = "BILLING_COMPLIMENTARY_UNPAID_INVOICES";
export declare const BILLING_COMPLIMENTARY_IN_PROGRESS = "BILLING_COMPLIMENTARY_IN_PROGRESS";
export declare const BILLING_COMPLIMENTARY_NOT_WITHDRAWABLE = "BILLING_COMPLIMENTARY_NOT_WITHDRAWABLE";
export declare const BILLING_COMPLIMENTARY_NOT_REVOCABLE = "BILLING_COMPLIMENTARY_NOT_REVOCABLE";
export interface PlatformComplimentaryListResponse {
    grants: (PlatformComplimentaryGrantView & {
        tenantId: string;
        businessName: string;
    })[];
    legacyComplimentary: number;
}
export interface PlatformReconciliationCaseListResponse {
    cases: PlatformReconciliationCase[];
}
export interface PlatformReconciliationRunResponse {
    subscriptionsChecked: number;
    casesOpened: number;
    checkoutsExpired: number;
    invoicesRecorded: number;
    externalAdjustmentsRecorded: number;
}
export interface PlatformBillingEnforcementSweepResponse {
    enabled: boolean;
    applied: number;
    failed: number;
}
export interface PlatformPlanListResponse {
    plans: PlatformPlan[];
    subscriptions: {
        total: number;
    };
}
export interface PlatformPlanCreateRequest {
    key: string;
    name: string;
    description?: string | null;
    moduleKeys: OptionalModuleKey[];
}
export interface PlatformPlanVersionModulesRequest {
    moduleKeys: OptionalModuleKey[];
}
export type PlatformSubscriptionEventType = "PLAN_ASSIGNED" | "PLAN_CHANGED" | "ADDON_GRANTED" | "ADDON_REVOKED" | "TRIAL_STARTED" | "PAYMENT_AUTHORIZED" | "PAYMENT_SUCCEEDED" | "PAYMENT_FAILED" | "GRACE_EXPIRED" | "TRIAL_EXPIRED" | "CANCEL_SCHEDULED" | "CANCEL_UNDONE" | "CANCELED" | "PLAN_CHANGE_PENDING" | "PLAN_CHANGE_APPLIED" | "PLAN_CHANGE_ABANDONED" | "RECOVERY_EXPIRED" | "BILLING_SUSPENDED" | "BILLING_SUSPENSION_LIFTED" | "SUBSCRIPTION_REPLACED" | "GRACE_EXTENDED" | "GRACE_EXCEPTION_GRANTED" | "GRACE_EXCEPTION_EXPIRED" | "COMPLIMENTARY_SCHEDULED" | "COMPLIMENTARY_STARTED" | "COMPLIMENTARY_WITHDRAWN" | "COMPLIMENTARY_ENDED" | "PAYMENT_SETUP_REQUIRED" | "PAYMENT_SETUP_WINDOW_STARTED" | "PAYMENT_SETUP_EXTENDED" | "PAYMENT_SETUP_EXPIRED" | "PAYMENT_SETUP_COMPLETED";
export type PlatformSubscriptionStatus = "ACTIVE" | "TRIALING" | "PAST_DUE" | "UNPAID" | "TRIAL_EXPIRED" | "CANCELED";
export type PlatformBillingMode = "COMPLIMENTARY" | "BILLED";
export interface PlatformTenantSubscription {
    id: string;
    status: PlatformSubscriptionStatus;
    billingMode: PlatformBillingMode;
    startedAt: string;
    plan: {
        id: string;
        key: string;
        name: string;
    };
    version: {
        id: string;
        version: number;
        status: PlatformPlanVersionStatus;
    };
    addOns: OptionalModuleKey[];
}
export interface PlatformTenantSubscriptionResponse {
    tenantId: string;
    subscription: PlatformTenantSubscription | null;
    modules: SubscriptionModuleKey[];
    history: Array<{
        type: PlatformSubscriptionEventType;
        at: string;
        fromVersion: string | null;
        toVersion: string | null;
        moduleKey: OptionalModuleKey | null;
    }>;
}
export interface PlatformSubscriptionChangeRequest {
    planVersionId?: string;
    grant?: OptionalModuleKey;
    revoke?: OptionalModuleKey;
}
export interface PlatformSubscriptionPreviewResponse {
    current: SubscriptionModuleKey[];
    proposed: SubscriptionModuleKey[];
    gained: SubscriptionModuleKey[];
    lost: SubscriptionModuleKey[];
}
export interface PlatformSubscriptionChangeResponse extends PlatformTenantSubscriptionResponse {
    changed: boolean;
}
export type AdminUserLocationAccess = {
    kind: "all";
} | {
    kind: "selected";
    locations: {
        id: string;
        name: string;
    }[];
} | {
    kind: "none";
};
export interface AdminInternalUserSummary {
    id: string;
    displayName: string | null;
    email: string;
    status: InternalUserStatus;
    accessLevels: string[];
    locationAccess: AdminUserLocationAccess;
}
export interface AdminUserCapabilityGroup {
    group: string;
    items: string[];
}
export interface AdminInternalUserDetail extends AdminInternalUserSummary {
    capabilities: AdminUserCapabilityGroup[];
    assignments: AdminInternalUserAccessAssignment[];
}
export interface AdminInternalUserAccessAssignment {
    id: string;
    accessLevel: {
        id: string;
        displayName: string;
        isBuiltIn: boolean;
    };
    location: {
        id: string;
        name: string;
    } | null;
    isCorporate: boolean;
}
export type AdminAccessAssignmentShape = "corporate-only" | "location-only";
export interface AdminAssignableAccessLevel {
    id: string;
    displayName: string;
    description: string | null;
    isBuiltIn: boolean;
    assignmentShape: AdminAccessAssignmentShape;
    capabilities: AdminUserCapabilityGroup[];
}
export interface AdminAccessAssignmentOptions {
    accessLevels: AdminAssignableAccessLevel[];
    locations: {
        id: string;
        name: string;
    }[];
}
export interface AdminAssignInternalUserRoleRequest {
    roleId: string;
    scope: {
        kind: "corporate";
    } | {
        kind: "locations";
        locationIds: string[];
    };
    reason: string;
}
export interface AdminRemoveInternalUserRoleAssignmentRequest {
    reason: string;
}
export type AdminAuditActivityType = "admin_access_status_changed" | "admin_access_granted" | "admin_access_removed";
export interface AdminAuditEventSummary {
    id: string;
    occurredAt: string;
    activityType: AdminAuditActivityType | "other";
    activityLabel: string;
    actor: {
        id: string;
        name: string;
        email: string;
    };
    subject: {
        kind: "admin_user";
        label: string;
    };
    location: {
        name: string;
    } | null;
    reason: string;
    details: {
        label: string;
        value: string;
    }[];
}
export interface AdminAuditEventPage {
    events: AdminAuditEventSummary[];
    nextCursor: string | null;
}
export interface AdminAuditFilterOptions {
    activityTypes: {
        value: AdminAuditActivityType;
        label: string;
    }[];
}
export interface AdminPlatformStatus {
    environmentLabel: string;
    isProduction: boolean;
    authentication: {
        adminLabel: string;
        customerLabel: string;
    };
    payments: {
        providerLabel: string;
        isDevelopmentStandIn: boolean;
    };
    locations: {
        activeCount: number;
        inactiveCount: number;
        digitalOrderingEnabledCount: number;
        digitalOrderingDisabledCount: number;
    };
}
export interface AdminRoleSummary {
    id: string;
    displayName: string;
    description: string | null;
    isBuiltIn: boolean;
    userCount: number;
}
export interface AdminRoleDetail extends AdminRoleSummary {
    capabilities: AdminUserCapabilityGroup[];
}
export interface AdminUpdateInternalUserStatusRequest {
    status: "ACTIVE" | "SUSPENDED" | "DISABLED";
    reason: string;
}
export declare const INTERNAL_PERMISSION_KEYS: readonly ["orders.view", "orders.manage_status", "orders.cancel", "catalog.products.edit", "catalog.menu.manage", "catalog.overrides.manage", "catalog.view", "locations.view", "locations.edit", "locations.manage_digital_ordering", "users.view", "roles.view", "users.manage_status", "users.manage_roles", "audit.view", "platform.view", "operations.view", "operations.tasks.complete", "operations.checklists.configure", "operations.exceptions.manage", "loyalty.view", "loyalty.adjust", "loyalty.configure", "promotions.configure", "giftcards.view", "giftcards.manage", "giftcards.configure", "customers.view", "customers.notes.manage", "careers.view", "careers.manage", "applicants.view", "applicants.manage", "franchising.view", "franchising.manage", "notifications.routing.view", "notifications.routing.manage", "cms.view", "cms.manage", "media.view", "media.manage", "marketing.view", "marketing.manage", "approvals.view", "approvals.decide", "reports.view", "billing.view", "billing.manage"];
export type InternalPermissionKey = (typeof INTERNAL_PERMISSION_KEYS)[number];
export interface BuiltInInternalRole {
    key: string;
    displayName: string;
    description: string;
    permissionKeys: readonly InternalPermissionKey[];
}
export declare const PLATFORM_ADMINISTRATOR_ROLE: BuiltInInternalRole;
export declare const STORE_MANAGER_ROLE: BuiltInInternalRole;
export declare const BUILT_IN_INTERNAL_ROLES: readonly BuiltInInternalRole[];
export type SubscriptionModuleKey = "core" | "operations" | "loyalty" | "promotions" | "giftcards" | "crm" | "careers" | "franchising" | "cms" | "marketing";
export type OptionalModuleKey = Exclude<SubscriptionModuleKey, "core">;
export interface SubscriptionModule {
    key: SubscriptionModuleKey;
    label: string;
    description: string;
}
export declare const SUBSCRIPTION_MODULES: readonly SubscriptionModule[];
export declare const OPTIONAL_MODULE_KEYS: readonly OptionalModuleKey[];
export declare function isOptionalModuleKey(value: unknown): value is OptionalModuleKey;
export declare const PERMISSION_MODULE: Readonly<Record<InternalPermissionKey, SubscriptionModuleKey>>;
export declare const LIFECYCLE_RETAINED_PERMISSIONS: readonly InternalPermissionKey[];
export declare function isPermissionEntitled(key: InternalPermissionKey, modules: ReadonlySet<SubscriptionModuleKey>): boolean;
export declare const MODULE_NOT_ENTITLED = "MODULE_NOT_ENTITLED";
export declare const STOREFRONT_FEATURE_KEYS: readonly ["loyalty", "promotions", "giftcards", "careers", "franchising", "cms"];
export type StorefrontFeatureKey = (typeof STOREFRONT_FEATURE_KEYS)[number];
export declare const FEATURE_NOT_AVAILABLE = "FEATURE_NOT_AVAILABLE";
export interface FeatureNotAvailableError {
    statusCode: 403;
    error: "Forbidden";
    code: typeof FEATURE_NOT_AVAILABLE;
    feature: StorefrontFeatureKey;
    message: string;
}
export interface StorefrontFeaturesResponse {
    features: Record<StorefrontFeatureKey, boolean>;
}
export interface InternalEntitlementsSummary {
    modules: SubscriptionModuleKey[];
    planName: string | null;
    paymentSetupPending: boolean;
}
export declare const SALES_NOT_AVAILABLE = "SALES_NOT_AVAILABLE";
export declare const INTERNAL_SCOPE_TYPES: readonly ["CORPORATE", "LOCATION"];
export type InternalScopeType = (typeof INTERNAL_SCOPE_TYPES)[number];
export interface InternalPermissionMetadata {
    key: InternalPermissionKey;
    description: string;
    allowedScopeTypes: readonly InternalScopeType[];
}
export declare const INTERNAL_PERMISSION_METADATA: Record<InternalPermissionKey, InternalPermissionMetadata>;
export type OpeningChecklistItemStatus = "open" | "completed" | "exception";
export interface OpeningChecklistItemView {
    id: string;
    label: string;
    status: OpeningChecklistItemStatus;
    resolved: boolean;
    completed: boolean;
    completedBy: {
        name: string;
    } | null;
    completedAt: string | null;
    exception: {
        reason: string;
        by: {
            name: string;
        } | null;
        at: string;
    } | null;
}
export interface OpeningChecklistSectionView {
    name: string;
    items: OpeningChecklistItemView[];
}
export interface OpeningChecklistProgress {
    completed: number;
    resolved: number;
    total: number;
    isComplete: boolean;
}
export interface OpeningChecklistResponse {
    locationId: string;
    locationName: string;
    businessDate: string;
    title: string;
    progress: OpeningChecklistProgress;
    sections: OpeningChecklistSectionView[];
}
export interface OpeningChecklistItemActionRequest {
    locationId: string;
}
export interface LogOpeningChecklistExceptionRequest {
    locationId: string;
    reason: string;
}
export interface ClearOpeningChecklistExceptionRequest {
    locationId: string;
}
export interface OperationsTaskView {
    id: string;
    title: string;
    note: string | null;
    done: boolean;
    completedBy: {
        name: string;
    } | null;
    completedAt: string | null;
    createdBy: {
        name: string;
    } | null;
    createdAt: string;
}
export interface OperationsTasksResponse {
    locationId: string;
    locationName: string;
    businessDate: string;
    tasks: OperationsTaskView[];
    openCount: number;
    doneCount: number;
}
export interface CreateOperationsTaskRequest {
    locationId: string;
    title: string;
    note?: string;
}
export interface OperationsTaskActionRequest {
    locationId: string;
}
export interface OpeningChecklistTemplateItemConfig {
    id: string;
    label: string;
    isActive: boolean;
    canMoveUp: boolean;
    canMoveDown: boolean;
}
export interface OpeningChecklistTemplateSectionConfig {
    name: string;
    canMoveUp: boolean;
    canMoveDown: boolean;
    items: OpeningChecklistTemplateItemConfig[];
}
export interface OpeningChecklistTemplateConfigResponse {
    title: string;
    sections: OpeningChecklistTemplateSectionConfig[];
}
export interface UpdateOpeningChecklistTemplateItemRequest {
    label?: string;
    isActive?: boolean;
}
export interface AddOpeningChecklistTemplateItemRequest {
    section: string;
    label: string;
}
export interface MoveOpeningChecklistTemplateItemRequest {
    direction: "up" | "down";
}
export interface MoveOpeningChecklistTemplateSectionRequest {
    section: string;
    direction: "up" | "down";
}
export interface RenameOpeningChecklistTemplateSectionRequest {
    from: string;
    to: string;
}
export type MochaBeanLedgerEntryType = "EARN" | "MANUAL_ADJUSTMENT" | "REDEEM" | "BONUS_EARN" | "REDEEM_REVERSAL" | "EARN_REVERSAL" | "BONUS_EARN_REVERSAL";
export interface AdminMochaBeanLedgerEntry {
    id: string;
    type: MochaBeanLedgerEntryType;
    amount: number;
    reason: string | null;
    orderNumber: string | null;
    actorLabel: string | null;
    createdAt: string;
}
export interface AdminLoyaltyCustomer {
    id: string;
    email: string | null;
    displayName: string | null;
    status: CustomerAccountStatus;
    balance: number;
}
export interface AdminLoyaltyCustomerSearchResponse {
    customers: AdminLoyaltyCustomer[];
}
export interface AdminLoyaltyCustomerDetail {
    customer: AdminLoyaltyCustomer;
    entries: AdminMochaBeanLedgerEntry[];
}
export interface AdminAdjustMochaBeansRequest {
    deltaBeans: number;
    reason: string;
    operationKey: string;
}
export declare const GIFT_CARD_MAX_VALUE_MINOR_UNITS = 200000;
export type GiftCardStatus = "ACTIVE" | "INACTIVE";
export type GiftCardTransactionType = "ISSUANCE" | "ADJUSTMENT" | "REDEMPTION" | "REDEMPTION_REVERSAL";
export interface AdminGiftCard {
    id: string;
    maskedCode: string;
    last4: string;
    status: GiftCardStatus;
    originalValueMinorUnits: number;
    balanceMinorUnits: number;
    currency: string;
    createdAt: string;
}
export interface AdminGiftCardTransaction {
    id: string;
    type: GiftCardTransactionType;
    amountMinorUnits: number;
    balanceAfterMinorUnits: number;
    reason: string | null;
    actorLabel: string | null;
    orderNumber: string | null;
    createdAt: string;
}
export interface GiftCardSearchRequest {
    code?: string;
    giftCardId?: string;
}
export interface AdminGiftCardSearchResponse {
    giftCards: AdminGiftCard[];
}
export interface AdminGiftCardDetail {
    giftCard: AdminGiftCard;
    transactions: AdminGiftCardTransaction[];
}
export interface IssueGiftCardRequest {
    originalValueMinorUnits: number;
    currency?: string;
}
export interface IssueGiftCardResponse {
    giftCard: AdminGiftCard;
    code: string;
}
export interface GiftCardStatusChangeRequest {
    reason?: string;
}
export interface AdjustGiftCardBalanceRequest {
    deltaMinorUnits: number;
    reason: string;
    operationKey: string;
}
export interface GiftCardConfiguration {
    presetAmountsMinorUnits: number[];
    customAmountEnabled: boolean;
}
export interface UpdateGiftCardConfigurationRequest {
    presetAmountsMinorUnits: number[];
    customAmountEnabled: boolean;
}
export declare const GIFT_CARD_CUSTOM_MIN_MINOR_UNITS = 500;
export declare const GIFT_CARD_CUSTOM_MAX_MINOR_UNITS = 50000;
export interface GiftCardPurchaseOptions {
    presetAmountsMinorUnits: number[];
    customAmountEnabled: boolean;
    customAmountMinMinorUnits: number;
    customAmountMaxMinorUnits: number;
    currency: string;
}
export interface CreateGiftCardPurchaseIntentRequest {
    idempotencyKey: string;
    amountMinorUnits: number;
    purchaserEmail: string;
    purchaserName?: string | null;
}
export type GiftCardPurchaseStatus = "PENDING" | "ISSUED" | "RECONCILIATION_REQUIRED";
export interface GiftCardPurchaseIntentResponse {
    purchaseId: string;
    status: GiftCardPurchaseStatus;
    amountMinorUnits: number;
    currency: string;
    customerOwned: boolean;
    recoveryCredential: string | null;
}
export interface PurchaseGiftCardRequest {
    idempotencyKey: string;
    recoveryCredential?: string | null;
}
export interface PurchaseGiftCardResponse {
    purchaseId: string;
    status: GiftCardPurchaseStatus;
    amountMinorUnits: number;
    currency: string;
    maskedCode: string;
    last4: string;
    code: string | null;
    codeRetrievable: boolean;
    codeRetrievableUntil: string | null;
}
export interface GiftCardBalanceRequest {
    code: string;
}
export type GiftCardPublicStatus = "active" | "inactive" | "depleted";
export interface GiftCardBalanceResponse {
    found: boolean;
    maskedCode?: string;
    last4?: string;
    balanceMinorUnits?: number;
    currency?: string;
    status?: GiftCardPublicStatus;
}
export interface AdminCustomerSummary {
    id: string;
    email: string | null;
    displayName: string | null;
    status: CustomerAccountStatus;
    emailVerified: boolean;
    marketingEmailOptIn: boolean;
    createdAt: string;
}
export interface AdminCustomerListResponse {
    customers: AdminCustomerSummary[];
    nextCursor: string | null;
}
export interface AdminCustomerGiftCardPurchase {
    purchaseId: string;
    status: GiftCardPurchaseStatus;
    amountMinorUnits: number;
    currency: string;
    maskedCode: string | null;
    last4: string | null;
    createdAt: string;
}
export interface AdminCustomerGiftCardRedemption {
    orderId: string;
    orderNumber: string;
    last4: string;
    amountMinorUnits: number;
    currency: string;
    createdAt: string;
}
export interface AdminCustomerGiftCardSummary {
    purchases: AdminCustomerGiftCardPurchase[];
    redemptions: AdminCustomerGiftCardRedemption[];
}
export interface AdminCustomerActivityItem {
    id: string;
    summary: string;
    reason: string | null;
    actorLabel: string | null;
    createdAt: string;
}
export interface CustomerNote {
    id: string;
    body: string;
    authorLabel: string | null;
    createdAt: string;
}
export interface CreateCustomerNoteRequest {
    body: string;
}
export declare const CUSTOMER_NOTE_MAX_LENGTH = 2000;
export interface AdminCustomerDetail {
    customer: AdminCustomerSummary;
    orders: {
        count: number;
        recent: CustomerOrderSummary[];
    };
    mochaBeans: {
        balance: number;
        recentActivity: AdminMochaBeanLedgerEntry[];
    };
    affordableRewards: CustomerLoyaltyReward[];
    giftCards: AdminCustomerGiftCardSummary;
    preferredLocations: LocationSummary[];
    communicationPreferences: CustomerCommunicationPreferences;
    notes: CustomerNote[];
    activity: AdminCustomerActivityItem[];
}
export type JobOpeningStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
export type JobEmploymentType = "FULL_TIME" | "PART_TIME" | "TEMPORARY" | "SEASONAL";
export interface JobOpeningLocationRef {
    id: string;
    name: string;
}
export interface AdminJobOpening {
    id: string;
    title: string;
    employmentType: JobEmploymentType;
    location: JobOpeningLocationRef | null;
    summary: string;
    description: string;
    responsibilities: string;
    qualifications: string;
    status: JobOpeningStatus;
    publishedAt: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface AdminJobOpeningsResponse {
    jobs: AdminJobOpening[];
}
export interface AdminJobOpeningOptions {
    locations: JobOpeningLocationRef[];
    employmentTypes: JobEmploymentType[];
}
export interface CreateJobOpeningRequest {
    title: string;
    employmentType: JobEmploymentType;
    locationId?: string | null;
    summary: string;
    description: string;
    responsibilities: string;
    qualifications: string;
}
export interface UpdateJobOpeningRequest {
    title?: string;
    employmentType?: JobEmploymentType;
    locationId?: string | null;
    summary?: string;
    description?: string;
    responsibilities?: string;
    qualifications?: string;
}
export declare const JOB_OPENING_TITLE_MAX_LENGTH = 160;
export declare const JOB_OPENING_SUMMARY_MAX_LENGTH = 400;
export declare const JOB_OPENING_LONG_TEXT_MAX_LENGTH = 8000;
export interface PublicJobOpeningSummary {
    id: string;
    title: string;
    employmentType: JobEmploymentType;
    locationName: string | null;
    summary: string;
    publishedAt: string | null;
}
export interface PublicJobOpeningsResponse {
    jobs: PublicJobOpeningSummary[];
}
export interface PublicJobOpeningDetail extends PublicJobOpeningSummary {
    description: string;
    responsibilities: string;
    qualifications: string;
}
export type JobApplicationStatus = "NEW" | "REVIEWING" | "CONTACTED" | "HIRED" | "REJECTED";
export declare const JOB_APPLICATION_STATUSES: readonly JobApplicationStatus[];
export declare const JOB_APPLICATION_NAME_MAX_LENGTH = 120;
export declare const JOB_APPLICATION_SHORT_MAX_LENGTH = 200;
export declare const JOB_APPLICATION_MESSAGE_MAX_LENGTH = 4000;
export declare const JOB_APPLICATION_URL_MAX_LENGTH = 2048;
export declare const JOB_APPLICATION_NOTE_MAX_LENGTH = 2000;
export interface SubmitJobApplicationRequest {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    location: string;
    workAuthorized: boolean;
    availability: string;
    message: string;
    resumeUrl?: string | null;
}
export interface SubmitJobApplicationResponse {
    ok: true;
}
export interface AdminJobApplicationSummary {
    id: string;
    applicantName: string;
    email: string;
    jobOpeningId: string;
    jobTitleSnapshot: string;
    status: JobApplicationStatus;
    createdAt: string;
}
export interface AdminJobApplicationsResponse {
    applications: AdminJobApplicationSummary[];
    nextCursor: string | null;
}
export interface AdminJobApplicationDetail {
    id: string;
    status: JobApplicationStatus;
    jobOpeningId: string;
    jobTitleSnapshot: string;
    jobStatus: JobOpeningStatus | null;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    location: string;
    workAuthorized: boolean;
    availability: string;
    message: string;
    resumeUrl: string | null;
    createdAt: string;
    updatedAt: string;
    notes: JobApplicationNote[];
    activity: AdminJobApplicationActivityItem[];
}
export interface UpdateJobApplicationStatusRequest {
    status: JobApplicationStatus;
}
export interface JobApplicationNote {
    id: string;
    body: string;
    authorLabel: string | null;
    createdAt: string;
}
export interface CreateJobApplicationNoteRequest {
    body: string;
}
export interface AdminJobApplicationActivityItem {
    id: string;
    summary: string;
    actorLabel: string | null;
    createdAt: string;
}
export type FranchiseInquiryStatus = "NEW" | "REVIEWING" | "CONTACTED" | "QUALIFIED" | "CLOSED";
export declare const FRANCHISE_INQUIRY_STATUSES: readonly FranchiseInquiryStatus[];
export declare const FRANCHISE_INQUIRY_NAME_MAX_LENGTH = 120;
export declare const FRANCHISE_INQUIRY_SHORT_MAX_LENGTH = 200;
export declare const FRANCHISE_INQUIRY_MESSAGE_MAX_LENGTH = 4000;
export declare const FRANCHISE_INQUIRY_NOTE_MAX_LENGTH = 2000;
export interface SubmitFranchiseInquiryRequest {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    city: string;
    state: string;
    country: string;
    preferredMarket: string;
    investmentRange?: string | null;
    timeframe?: string | null;
    businessExperience?: string | null;
    message?: string | null;
    consentAcknowledged: boolean;
}
export interface SubmitFranchiseInquiryResponse {
    ok: true;
}
export interface AdminFranchiseInquirySummary {
    id: string;
    prospectName: string;
    email: string;
    preferredMarket: string;
    status: FranchiseInquiryStatus;
    createdAt: string;
}
export interface AdminFranchiseInquiriesResponse {
    inquiries: AdminFranchiseInquirySummary[];
    nextCursor: string | null;
}
export interface AdminFranchiseInquiryDetail {
    id: string;
    status: FranchiseInquiryStatus;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    city: string;
    state: string;
    country: string;
    preferredMarket: string;
    investmentRange: string | null;
    timeframe: string | null;
    businessExperience: string | null;
    message: string | null;
    consentAcknowledged: boolean;
    createdAt: string;
    updatedAt: string;
    notes: FranchiseInquiryNote[];
    activity: AdminFranchiseInquiryActivityItem[];
}
export interface UpdateFranchiseInquiryStatusRequest {
    status: FranchiseInquiryStatus;
}
export interface FranchiseInquiryNote {
    id: string;
    body: string;
    authorLabel: string | null;
    createdAt: string;
}
export interface CreateFranchiseInquiryNoteRequest {
    body: string;
}
export interface AdminFranchiseInquiryActivityItem {
    id: string;
    summary: string;
    actorLabel: string | null;
    createdAt: string;
}
export declare const NOTIFICATION_RECIPIENT_PURPOSES: readonly ["careers.application.received", "franchising.inquiry.received"];
export type NotificationRecipientPurpose = (typeof NOTIFICATION_RECIPIENT_PURPOSES)[number];
export interface NotificationRecipient {
    purpose: NotificationRecipientPurpose;
    email: string;
    updatedAt: string;
}
export interface AdminNotificationRecipientsResponse {
    recipients: {
        purpose: NotificationRecipientPurpose;
        email: string | null;
        updatedAt: string | null;
    }[];
}
export interface UpdateNotificationRecipientRequest {
    email: string;
}
export type CmsPageStatus = "DRAFT" | "PUBLISHED";
export declare const CMS_PAGE_KEYS: readonly ["franchising", "home"];
export type CmsPageKey = (typeof CMS_PAGE_KEYS)[number];
export declare const CMS_TEXT_MAX_LENGTH = 200;
export declare const CMS_BODY_MAX_LENGTH = 2000;
export declare const CMS_BUTTON_LABEL_MAX_LENGTH = 60;
export declare const CMS_SEO_TITLE_MAX_LENGTH = 70;
export declare const CMS_SEO_DESCRIPTION_MAX_LENGTH = 200;
export declare const CMS_PROCESS_STEPS_MIN = 1;
export declare const CMS_PROCESS_STEPS_MAX = 6;
export declare const CMS_FEATURED_PRODUCTS_MAX = 8;
export interface CmsSeoFields {
    pageTitle?: string | null;
    metaDescription?: string | null;
}
export interface FranchisingPageContent {
    intro: {
        heading: string;
        body: string;
    };
    opportunity: {
        heading: string;
        body: string;
    };
    process: {
        heading: string;
        steps: {
            title: string;
            body: string;
        }[];
    };
    cta: {
        heading: string;
        body: string;
        buttonLabel: string;
    };
    seo: CmsSeoFields;
}
export interface HomePageContent {
    hero: {
        headline: string;
        supportingText: string;
        buttonLabel: string;
        backgroundImageId: string | null;
    };
    featuredProducts: {
        heading: string;
        productIds: string[];
    };
    seo: CmsSeoFields;
}
export type CmsPageContent = FranchisingPageContent | HomePageContent;
export interface PublicCmsPageContentResponse {
    content: CmsPageContent;
}
export interface PublicFranchisingPageContentResponse {
    content: FranchisingPageContent;
}
export interface PublicHomePageContent {
    hero: {
        headline: string;
        supportingText: string;
        buttonLabel: string;
        backgroundImageUrl: string | null;
    };
    featuredProducts: {
        heading: string;
        products: ProductSummary[];
    };
    seo: CmsSeoFields;
}
export interface PublicHomePageContentResponse {
    content: PublicHomePageContent;
}
export interface AdminCmsPageSummary {
    key: CmsPageKey;
    title: string;
    status: CmsPageStatus;
    publishedAt: string | null;
    updatedAt: string | null;
    hasUnpublishedChanges: boolean;
}
export interface AdminCmsPagesResponse {
    pages: AdminCmsPageSummary[];
}
export interface AdminCmsPageDetail {
    key: CmsPageKey;
    title: string;
    status: CmsPageStatus;
    draftContent: CmsPageContent;
    publishedContent: CmsPageContent | null;
    publishedAt: string | null;
    updatedAt: string | null;
    hasUnpublishedChanges: boolean;
}
export interface UpdateCmsPageContentRequest {
    content: CmsPageContent;
}
export declare const MEDIA_ALLOWED_CONTENT_TYPES: readonly ["image/jpeg", "image/png", "image/webp"];
export type MediaContentType = (typeof MEDIA_ALLOWED_CONTENT_TYPES)[number];
export declare const MEDIA_MAX_FILE_SIZE_BYTES: number;
export interface AdminMediaAsset {
    id: string;
    fileName: string;
    title: string | null;
    altText: string | null;
    contentType: string;
    fileSizeBytes: number;
    publicUrl: string;
    isActive: boolean;
    uploadedByLabel: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface AdminMediaAssetsResponse {
    assets: AdminMediaAsset[];
    nextCursor: string | null;
}
export interface UploadMediaAssetResponse {
    asset: AdminMediaAsset;
}
export interface GetMediaAssetResponse {
    asset: AdminMediaAsset;
}
export interface UpdateMediaAssetMetadataRequest {
    title?: string | null;
    altText?: string | null;
}
export interface UpdateMediaAssetMetadataResponse {
    asset: AdminMediaAsset;
}
export interface DeactivateMediaAssetResponse {
    asset: AdminMediaAsset;
}
export type CampaignStatus = "DRAFT" | "ACTIVE" | "ENDED";
export declare const CAMPAIGN_NAME_MAX_LENGTH = 120;
export declare const CAMPAIGN_DESCRIPTION_MAX_LENGTH = 1000;
export declare const CAMPAIGN_FEATURED_PRODUCTS_MAX = 8;
export interface AdminCampaignProductRef {
    id: string;
    name: string;
    category: {
        id: string;
        name: string;
    };
    isActive: boolean;
    displayOrder: number;
}
export interface AdminCampaignPromotionRef {
    id: string;
    name: string;
    isActive: boolean;
}
export interface AdminCampaignLoyaltyBonusPromotionRef {
    id: string;
    name: string;
    isActive: boolean;
}
export type CampaignApprovalStatus = "NONE" | "PENDING" | "APPROVED" | "REJECTED";
export interface AdminCampaign {
    id: string;
    name: string;
    description: string | null;
    status: CampaignStatus;
    startsAt: string | null;
    endsAt: string | null;
    mediaAssetId: string | null;
    promotion: AdminCampaignPromotionRef | null;
    loyaltyBonusPromotion: AdminCampaignLoyaltyBonusPromotionRef | null;
    featuredProducts: AdminCampaignProductRef[];
    createdAt: string;
    updatedAt: string;
    approvalStatus: CampaignApprovalStatus;
    latestApprovalRequestId: string | null;
}
export interface AdminCampaignsResponse {
    campaigns: AdminCampaign[];
    nextCursor: string | null;
}
export interface AdminCampaignOptions {
    products: {
        id: string;
        name: string;
        category: {
            id: string;
            name: string;
        };
        isActive: boolean;
    }[];
    promotions: AdminCampaignPromotionRef[];
    loyaltyBonusPromotions: AdminCampaignLoyaltyBonusPromotionRef[];
}
export interface CreateCampaignRequest {
    name: string;
    description?: string | null;
    startsAt?: string | null;
    endsAt?: string | null;
    mediaAssetId?: string | null;
    promotionId?: string | null;
    loyaltyBonusPromotionId?: string | null;
    featuredProductIds?: string[];
}
export interface UpdateCampaignRequest {
    name?: string;
    description?: string | null;
    startsAt?: string | null;
    endsAt?: string | null;
    mediaAssetId?: string | null;
    promotionId?: string | null;
    loyaltyBonusPromotionId?: string | null;
    featuredProductIds?: string[];
}
export interface UpdateCampaignStatusRequest {
    status: CampaignStatus;
}
export declare const APPROVAL_TARGET_TYPE_CAMPAIGN = "Campaign";
export declare const APPROVAL_ACTION_CAMPAIGN_ACTIVATE = "marketing.campaign_activate";
export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";
export interface AdminApprovalRequest {
    id: string;
    targetType: string;
    targetId: string;
    targetLabel: string;
    action: string;
    status: ApprovalStatus;
    requestedByLabel: string;
    createdAt: string;
    decidedByLabel: string | null;
    decisionReason: string | null;
    decidedAt: string | null;
}
export interface AdminApprovalRequestsResponse {
    approvalRequests: AdminApprovalRequest[];
    nextCursor: string | null;
}
export interface GetApprovalRequestResponse {
    approvalRequest: AdminApprovalRequest;
}
export type AdminReportDataSourceScope = "DIGITAL_PLATFORM_ONLY" | "INTERNAL_OPERATIONS" | "CUSTOMER_PLATFORM";
export interface AdminReportDataSource {
    scope: AdminReportDataSourceScope;
    scopeLabel: string;
    freshnessLabel: string;
}
export interface AdminReportLocationRef {
    id: string;
    name: string;
}
export interface AdminOrdersOverviewReport {
    filters: {
        startDate: string;
        endDate: string;
        locationId: string | null;
    };
    location: AdminReportLocationRef | null;
    availableLocations: AdminReportLocationRef[];
    totalOrders: number;
    completedOrders: number;
    digitalSalesMinorUnits: number;
    averageOrderValueMinorUnits: number;
    statusBreakdown: Record<OrderStatus, number>;
    source: AdminReportDataSource;
}
export interface ApproveApprovalRequestResponse {
    approvalRequest: AdminApprovalRequest;
}
export interface RejectApprovalRequestRequest {
    reason: string;
}
export interface RejectApprovalRequestResponse {
    approvalRequest: AdminApprovalRequest;
}
export interface AdminLocationPerformanceRow {
    locationId: string;
    locationName: string;
    isActive: boolean;
    isDigitalOrderingEnabled: boolean;
    totalOrders: number;
    completedOrders: number;
    completedPercent: number;
    digitalSalesMinorUnits: number;
    averageOrderValueMinorUnits: number;
}
export interface AdminLocationPerformanceReport {
    filters: {
        startDate: string;
        endDate: string;
    };
    locations: AdminLocationPerformanceRow[];
    source: AdminReportDataSource;
}
export interface AdminOperationsChecklistRow {
    locationId: string;
    locationName: string;
    isActive: boolean;
    openingStarted: number;
    openingCompleted: number;
    openingCurrentExceptions: number;
    closingStarted: number;
    closingCompleted: number;
    closingCurrentExceptions: number;
}
export interface AdminOperationsChecklistReport {
    filters: {
        startDate: string;
        endDate: string;
    };
    locations: AdminOperationsChecklistRow[];
    source: AdminReportDataSource;
}
export interface AdminCustomerGrowthReport {
    filters: {
        startDate: string;
        endDate: string;
    };
    registeredCustomersAsOfEndDate: number;
    newRegisteredCustomers: number;
    registeredCustomersWithOrders: number;
    repeatRegisteredCustomers: number;
    registeredCustomerOrders: number;
    guestOrders: number;
    source: AdminReportDataSource;
}
export type NotificationHealthStatus = "ok" | "warning" | "critical";
export type NotificationAttentionSeverity = "info" | "warning" | "critical";
export type NotificationHealthItemState = "dead-lettered" | "delayed" | "retrying";
export interface NotificationHealthReasonCount {
    code: string;
    count: number;
}
export interface NotificationHealthAttention {
    key: string;
    severity: NotificationAttentionSeverity;
    title: string;
    detail: string;
    count: number;
}
export interface NotificationHealthItem {
    eventId: string;
    eventType: string;
    state: NotificationHealthItemState;
    attempts: number;
    reasonCode: string | null;
    createdAt: string;
    nextAttemptAt: string | null;
    failedAt: string | null;
    reference: string | null;
    possibleDuplicate: boolean;
}
export interface NotificationHealthResponse {
    generatedAt: string;
    status: NotificationHealthStatus;
    thresholds: {
        delayedAfterSeconds: number;
        criticalDelaySeconds: number;
        repeatedFailureAttempts: number;
    };
    pending: {
        total: number;
        waiting: number;
        inProgress: number;
        scheduledRetry: number;
        delayed: number;
        repeatedlyFailing: number;
        oldestPendingAgeSeconds: number | null;
        oldestRetryingAgeSeconds: number | null;
        oldestOverdueSeconds: number | null;
        retryReasons: NotificationHealthReasonCount[];
    };
    failed: {
        total: number;
        last24h: number;
        last7d: number;
        reasons: NotificationHealthReasonCount[];
        closedDeliberately: number;
    };
    accepted: {
        last24h: number;
        last7d: number;
    };
    possibleDuplicatesLast7d: number;
    attention: NotificationHealthAttention[];
    items: NotificationHealthItem[];
    itemsTruncated: boolean;
}
export type BillingAdjustmentKind = "REFUND" | "CREDIT" | "OUT_OF_BAND";
export type BillingAdjustmentScope = "FULL" | "PARTIAL";
export type BillingAdjustmentStatus = "PENDING_APPROVAL" | "EXECUTING" | "SUBMITTED" | "SUCCEEDED" | "REJECTED" | "CANCELED" | "EXPIRED" | "FAILED" | "REVIEW" | "RECORDED";
export interface PlatformAdjustableInvoice {
    invoiceId: string;
    number: string | null;
    currency: string;
    amountPaidMinorUnits: number;
    adjustedMinorUnits: number;
    remainingMinorUnits: number;
    refundable: boolean;
    annual: boolean;
    lines: {
        lineId: string;
        description: string | null;
        amountMinorUnits: number;
    }[];
}
export interface PlatformAdjustmentPreviewRequest {
    kind: "REFUND" | "CREDIT";
    scope: BillingAdjustmentScope;
    lineId?: string;
    amountMinorUnits?: number;
}
export interface PlatformAdjustmentPreview {
    kind: "REFUND" | "CREDIT";
    scope: BillingAdjustmentScope;
    currency: string;
    totalMinorUnits: number;
    taxMinorUnits: number;
    remainingAfterMinorUnits: number;
    requiredApprovals: 1 | 2;
    annualFullRefund: boolean;
}
export interface PlatformAdjustmentRequest extends PlatformAdjustmentPreviewRequest {
    reason: string;
}
export interface PlatformAdjustmentView {
    id: string;
    tenantId: string;
    businessName: string;
    invoiceId: string;
    invoiceNumber: string | null;
    origin: "CENTERIVO" | "EXTERNAL";
    kind: BillingAdjustmentKind;
    scope: BillingAdjustmentScope | null;
    status: BillingAdjustmentStatus;
    currency: string;
    totalMinorUnits: number;
    taxMinorUnits: number;
    annualFullRefund: boolean;
    requiredApprovals: number;
    reason: string | null;
    requestedBy: {
        id: string;
        email: string;
    } | null;
    createdAt: string;
    expiresAt: string | null;
    finishedAt: string | null;
    failureCode: string | null;
    decisions: {
        decision: "APPROVED" | "REJECTED";
        note: string;
        operator: {
            id: string;
            email: string;
        };
        at: string;
    }[];
    events: {
        type: string;
        code: string | null;
        at: string;
        actorEmail: string | null;
        note: string | null;
    }[];
}
export interface PlatformAdjustmentListResponse {
    adjustments: PlatformAdjustmentView[];
}
export interface PlatformAdjustmentDecisionRequest {
    note: string;
}
export declare const BILLING_ADJUSTMENT_NOT_ELIGIBLE = "BILLING_ADJUSTMENT_NOT_ELIGIBLE";
export declare const BILLING_ADJUSTMENT_EXCEEDS_REMAINING = "BILLING_ADJUSTMENT_EXCEEDS_REMAINING";
export declare const BILLING_ADJUSTMENT_IN_PROGRESS = "BILLING_ADJUSTMENT_IN_PROGRESS";
export declare const BILLING_ADJUSTMENT_OWN_REQUEST = "BILLING_ADJUSTMENT_OWN_REQUEST";
export declare const BILLING_ADJUSTMENT_NOT_PENDING = "BILLING_ADJUSTMENT_NOT_PENDING";
export declare const BILLING_ADJUSTMENT_ALREADY_DECIDED = "BILLING_ADJUSTMENT_ALREADY_DECIDED";
export declare const BILLING_ADJUSTMENT_EXPIRED = "BILLING_ADJUSTMENT_EXPIRED";
export declare const BILLING_ADJUSTMENT_PREVIEW_CHANGED = "BILLING_ADJUSTMENT_PREVIEW_CHANGED";
export interface BillingInvoiceAdjustmentView {
    kind: "REFUND" | "CREDIT";
    status: "PENDING" | "COMPLETED";
    currency: string;
    totalMinorUnits: number;
    at: string;
}
export type RevenueReportEnvironment = "STRIPE_TEST_MODE" | "STRIPE_LIVE_MODE" | "DEVELOPMENT" | "NO_PROVIDER";
export type RevenueMetricStatus = "COMPLETE" | "INCOMPLETE" | "UNAVAILABLE";
export interface RevenueRecurring {
    currency: string;
    mrrMinorUnits: number;
    arrMinorUnits: number;
    atRiskMrrMinorUnits: number;
    activePaidSubscriptions: number;
    atRiskSubscriptions: number;
    monthlySubscriptions: number;
    annualSubscriptions: number;
}
export interface RevenuePlanBreakdown {
    planName: string;
    interval: "MONTH" | "YEAR";
    currency: string;
    subscriptions: number;
    mrrMinorUnits: number;
    arrMinorUnits: number;
}
export interface RevenueCash {
    currency: string;
    collectedMinorUnits: number;
    taxMinorUnits: number | null;
    refundsMinorUnits: number;
    refundsOutsideProviderMinorUnits: number;
    creditsIssuedMinorUnits: number;
    balanceAppliedMinorUnits: number;
    recoveredMinorUnits: number;
}
export interface RevenueMonth {
    month: string;
    status: RevenueMetricStatus;
    partial: boolean;
    missingPrices: number;
    recurring: RevenueRecurring[];
    activePaidAtStart: number;
    activePaidAtEnd: number;
    churn: {
        ended: number;
        endedOther: number;
        movedToComplimentary: number;
        revenue: {
            currency: string;
            startMrrMinorUnits: number;
            churnedMrrMinorUnits: number;
        }[];
    };
    cash: RevenueCash[];
    failedInvoices: {
        count: number;
        amountDue: {
            currency: string;
            minorUnits: number;
        }[];
        unverified: number;
    };
    recoveredInvoices: number;
    complimentaryAtEnd: number;
}
export interface RevenueTrialCohort {
    month: string;
    started: number;
    converted: number;
    expired: number;
    inProgress: number;
    complete: boolean;
}
export interface RevenueAdjustmentTotal {
    currency: string;
    kind: "REFUND" | "CREDIT" | "OUT_OF_BAND";
    origin: "CENTERIVO" | "EXTERNAL";
    count: number;
    totalMinorUnits: number;
}
export interface PlatformRevenueReport {
    environment: RevenueReportEnvironment;
    generatedAt: string;
    period: {
        from: string;
        to: string;
    };
    current: {
        asOf: string;
        status: RevenueMetricStatus;
        recurring: RevenueRecurring[];
        byPlan: RevenuePlanBreakdown[];
        complimentary: {
            withArrangement: number;
            withoutArrangement: number;
            listPriceEquivalent: {
                currency: string;
                mrrMinorUnits: number;
            }[];
        };
    };
    months: RevenueMonth[];
    trialCohorts: RevenueTrialCohort[];
    adjustments: RevenueAdjustmentTotal[];
    dataQuality: {
        incompleteSubscriptions: number;
        invoicesWithoutAmounts: number;
        violations: {
            code: string;
            count: number;
        }[];
    };
}
//# sourceMappingURL=index.d.ts.map