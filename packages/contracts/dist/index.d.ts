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
    currency: string;
    lines: OrderLineSummary[];
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
    currency: string;
    lines: OrderLineSummary[];
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
    currency: string;
}
export interface CustomerOrderDetail extends CustomerOrderSummary {
    lines: OrderLineSummary[];
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
export declare const INTERNAL_PERMISSION_KEYS: readonly ["orders.view", "orders.manage_status", "catalog.products.edit", "catalog.menu.manage", "catalog.overrides.manage", "catalog.view", "locations.view", "locations.edit", "locations.manage_digital_ordering", "users.view", "roles.view", "users.manage_status", "users.manage_roles"];
export type InternalPermissionKey = (typeof INTERNAL_PERMISSION_KEYS)[number];
export declare const INTERNAL_SCOPE_TYPES: readonly ["CORPORATE", "LOCATION"];
export type InternalScopeType = (typeof INTERNAL_SCOPE_TYPES)[number];
export interface InternalPermissionMetadata {
    key: InternalPermissionKey;
    description: string;
    allowedScopeTypes: readonly InternalScopeType[];
}
export declare const INTERNAL_PERMISSION_METADATA: Record<InternalPermissionKey, InternalPermissionMetadata>;
//# sourceMappingURL=index.d.ts.map