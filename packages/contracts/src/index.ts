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

// --- Checkout / orders (Milestone 3, first transaction slice) ----------

export type PaymentAttemptStatus = "PENDING" | "SUCCEEDED" | "DECLINED" | "FAILED";

// RECEIVED is the only status this slice creates. The remaining values name
// the approved Store Queue pipeline so later slices don't need new ones.
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

// The client-submitted cart. Note there is no price field anywhere in this
// shape — the backend independently reprices every line and never reads a
// client-submitted amount.
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

// Returned once, at checkout time. accessToken is the guest's bearer
// credential for the status endpoint — the caller must persist it
// (e.g. in the confirmation URL) to view this order again.
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

// Shape of a 402 response body when FakePaymentProvider declines or fails.
// No Order is created for either outcome — the cart is left untouched.
export interface CheckoutDeclinedResponse {
  outcome: "declined" | "failed";
  message: string;
}

// --- Customer identity & sign-in (Milestone 4, customer auth foundation) ---
// Cognito (or the equivalent local/test auth boundary — see apps/api's
// customer-auth module) owns credentials; these shapes never carry a
// password or a Cognito SDK payload, only what the account UI needs.

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

// idToken is a bearer credential for GET /customers/me (Authorization:
// Bearer <idToken>) — the caller is expected to store it only in an
// httpOnly cookie, never in browser-readable storage.
export interface CustomerSignInResponse {
  idToken: string;
  expiresInSeconds: number;
}

// --- Store Queue / operational lifecycle (Milestone 3, next slice) -----
// DEV-ONLY NOTE: these endpoints have no authentication/authorization yet
// (see AdminOrdersController). Deliberately excludes guest accessToken and
// guestEmail — staff never need the guest's own bearer credential, and
// email isn't operationally necessary at the counter.

// Rich enough to work a kitchen/counter queue from directly, without a
// click-through to the detail view for every order.
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
  // Optimistic-concurrency guard, not a target status — the server always
  // advances exactly one step from whatever the order's current status
  // actually is. A stale expectedStatus (someone else already advanced it)
  // is how a retry is told apart from a real conflict.
  expectedStatus: OrderStatus;
}

export interface AdvanceOrderStatusResponse {
  orderId: string;
  status: OrderStatus;
  // false when this call found the order already at the target status
  // (an idempotent replay of a retried request) rather than performing the
  // transition itself.
  advanced: boolean;
}