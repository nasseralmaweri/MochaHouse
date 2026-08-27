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
    createdAt: string;
}
export interface CustomerSignInRequest {
    identifier: string;
    password: string;
}
export interface CustomerSignInResponse {
    idToken: string;
    expiresInSeconds: number;
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
//# sourceMappingURL=index.d.ts.map