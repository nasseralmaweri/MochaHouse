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
export type OrderStatus = "RECEIVED" | "ACCEPTED" | "PREPARING" | "READY" | "COMPLETED";
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
}
export interface CheckoutQuoteRequest {
    locationId: string;
    lines: CheckoutLineInput[];
    couponCode?: string | null;
    loyaltyRewardId?: string | null;
    giftCardCode?: string | null;
}
export type CouponQuoteStatus = "applied" | "invalid" | "inactive" | "not_started" | "expired" | "wrong_location" | "not_applicable" | "minimum_not_met" | "usage_limit_reached" | "sign_in_required";
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
export interface InternalMeResponse {
    user: InternalUserProfile;
    authorization: InternalAuthorizationSummary;
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
export declare const INTERNAL_PERMISSION_KEYS: readonly ["orders.view", "orders.manage_status", "catalog.products.edit", "catalog.menu.manage", "catalog.overrides.manage", "catalog.view", "locations.view", "locations.edit", "locations.manage_digital_ordering", "users.view", "roles.view", "users.manage_status", "users.manage_roles", "audit.view", "platform.view", "operations.view", "operations.tasks.complete", "operations.checklists.configure", "operations.exceptions.manage", "loyalty.view", "loyalty.adjust", "loyalty.configure", "promotions.configure", "giftcards.view", "giftcards.manage", "giftcards.configure", "customers.view", "customers.notes.manage", "careers.view", "careers.manage", "applicants.view", "applicants.manage", "franchising.view", "franchising.manage", "cms.view", "cms.manage", "media.view", "media.manage", "marketing.view", "marketing.manage"];
export type InternalPermissionKey = (typeof INTERNAL_PERMISSION_KEYS)[number];
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
export type MochaBeanLedgerEntryType = "EARN" | "MANUAL_ADJUSTMENT" | "REDEEM" | "BONUS_EARN";
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
export type GiftCardTransactionType = "ISSUANCE" | "ADJUSTMENT" | "REDEMPTION";
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
    contentType: string;
    fileSizeBytes: number;
    publicUrl: string;
    uploadedByLabel: string | null;
    createdAt: string;
}
export interface AdminMediaAssetsResponse {
    assets: AdminMediaAsset[];
    nextCursor: string | null;
}
export interface UploadMediaAssetResponse {
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
//# sourceMappingURL=index.d.ts.map