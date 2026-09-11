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

// --- Admin locations: read experience (Milestone 5D-1) ----------------
// The Admin-facing view of a Location record. Distinct from the customer
// `LocationSummary` above: this is served only from the guarded
// `/api/v1/admin/locations*` routes (InternalAuthGuard + PermissionGuard +
// `locations.view` + resource-level scope), and it deliberately exposes
// `isActive` — an Admin user may see and open inactive locations, which the
// public endpoints filter out entirely. No address / hours / timezone /
// contact / fulfillment fields: those are not modeled yet and are out of
// scope for this slice.
export interface AdminLocationSummary {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  isDigitalOrderingEnabled: boolean;
}

// The menu currently assigned to a location through an active LocationMenu
// row (active menu only). Null when the location has no active assigned
// menu. `productCount` is the number of active MenuProduct rows on that
// menu — a cheap count from the same relationship, not a second traversal
// of the effective-menu resolver.
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

// --- Admin locations: minimal edit (Milestone 5D-2) -------------------
// PATCH /api/v1/admin/locations/:locationId — a CORPORATE-only edit
// (`locations.edit`). Only these two fields are editable; `slug` and
// `isDigitalOrderingEnabled` are deliberately NOT accepted here (slug is a
// stable public identifier; online ordering has its own control and
// permission). Every field is optional; omitting all of them is a no-op
// that returns the unchanged record. The response is the full
// `AdminLocationDetail` so the caller can refresh the screen without a
// second request.
export interface AdminUpdateLocationRequest {
  name?: string;
  isActive?: boolean;
}

// --- Admin products: master catalog management (Milestone 5D-3) -------
// The Admin view of a master Product. Served only from the guarded
// `/api/v1/admin/catalog/products*` routes (InternalAuthGuard +
// PermissionGuard + `catalog.view`, which is CORPORATE-only — the master
// catalog is shared across every location, not location-owned). Unlike the
// public `ProductSummary` this exposes `isActive` (an Admin sees and edits
// inactive products too) and omits `category.slug` / `displayOrder` (not
// used by this screen). `basePrice` is integer minor units (cents) or null;
// null means "no standard price" — the item is only orderable at a location
// that sets its own price. No menu / modifier / override / POS fields.
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

// Currently identical to the summary — a distinct name so the detail route
// (and the PATCH response) can carry more later without a breaking rename.
export type AdminProductDetail = AdminProductSummary;

// PATCH /api/v1/admin/catalog/products/:productId — permission
// `catalog.products.edit` (CORPORATE-only). Only these fields are editable.
// `slug`, `categoryId`, `currency`, and everything else are deliberately not
// accepted (the controller reads only the fields below — nothing is spread
// into Prisma). Every field is optional; `description` / `basePrice` accept
// null to clear them. Response is the full `AdminProductDetail`.
export interface AdminUpdateProductRequest {
  name?: string;
  description?: string | null;
  basePrice?: number | null;
  isActive?: boolean;
}

// --- Admin menus & location pricing (Milestone 5D-4) -----------------
// Read models for the two Admin screens that manage EXISTING menu
// composition and EXISTING per-location price / availability. The field
// names are deliberately business-facing: "standard price" (the master
// product price), "location price" (a price set for one location, or null
// when the location uses the standard price), "resulting price" (what
// actually applies). No override / resolver / join terminology, and no
// modifier internals.

// Served from `/api/v1/admin/catalog/menus*` (InternalAuthGuard +
// PermissionGuard + `catalog.view`, CORPORATE-only). Includes inactive
// menus and inactive menu placements — an Admin manages both.
export interface AdminMenuSummary {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
}

// One product placed on a menu. `shownOnMenu` is whether that placement is
// currently on (the only thing 5D-4 can change here); `productIsActive` is
// the master product's own state — the two are independent, and an inactive
// product never reaches customers even when it is "shown on menu".
export interface AdminMenuProduct {
  productId: string;
  productName: string;
  productIsActive: boolean;
  categoryName: string;
  standardPrice: number | null;
  currency: string;
  shownOnMenu: boolean;
  // Internal ordering only — the UI renders products in this order.
  displayOrder: number;
}

export interface AdminMenuDetail extends AdminMenuSummary {
  products: AdminMenuProduct[];
}

// Served from `GET /api/v1/admin/catalog/locations/:locationId/menu`
// (InternalAuthGuard + PermissionGuard + `catalog.overrides.manage`, valid
// at CORPORATE or LOCATION scope). Resolves the location's assigned menu
// and, per product, the standard price/availability, any location-specific
// setting, and the resulting value. 404 when the location has no menu.
export interface AdminLocationMenuProduct {
  productId: string;
  productName: string;
  productIsActive: boolean;
  categoryName: string;
  currency: string;
  shownOnMenu: boolean;
  // The master product price.
  standardPrice: number | null;
  // A price set just for this location, or null when this location uses the
  // standard price.
  locationPrice: number | null;
  // What a customer at this location is actually charged: the location
  // price when one is set, otherwise the standard price. Null only when
  // neither exists — the item then has no usable price here.
  resultingPrice: number | null;
  // An availability set just for this location, or null when this location
  // uses the standard behavior (available).
  locationAvailability: boolean | null;
  // Whether the item can currently be ordered here: the location setting
  // when present, otherwise available.
  resultingAvailability: boolean;
}

export interface AdminLocationMenuResponse {
  location: { id: string; name: string };
  menu: { id: string; name: string };
  products: AdminLocationMenuProduct[];
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
//
// `loyaltyRewardId` (Milestone 7C) is the ONLY loyalty input the client
// sends: the id of the single Mocha Bean reward the signed-in customer
// chose to apply, or null / omitted for no reward. The server loads the
// reward, revalidates it against the current cart and the customer's
// current balance, and computes the discount and Bean cost itself — the
// client's view is never trusted. A guest that submits a `loyaltyRewardId`
// is rejected before any payment.
export interface CheckoutRequest {
  idempotencyKey: string;
  locationId: string;
  guest: GuestContactInput;
  lines: CheckoutLineInput[];
  loyaltyRewardId?: string | null;
  // `couponCode` (Milestone 7E) is the code the customer typed into the
  // coupon box, or null / omitted. The server normalizes it (trim +
  // upper-case), resolves the Coupon, revalidates it against the current
  // cart / location / dates / minimum / limits, and computes the discount
  // itself. When a valid coupon is supplied the server does NOT also apply
  // an automatic Promotion; an invalid coupon is rejected before payment
  // (never silently swapped for an automatic Promotion). When omitted, the
  // best eligible automatic Promotion (if any) applies automatically.
  couponCode?: string | null;
  // `giftCardCode` (Milestone 7G) is the gift-card code the customer typed,
  // or null / omitted. A gift card is a TENDER, not a discount: the server
  // resolves it (canonicalize + HMAC hash + lookup), requires it ACTIVE
  // with a matching currency and a positive balance, and applies
  // `min(balance, amount owed after promotion + reward discounts)` against
  // the order — the remainder is charged externally. At most ONE gift card
  // per order. An invalid / inactive / depleted / wrong-currency card is
  // rejected before any payment. Guests may redeem. The plaintext code is
  // only ever sent in this request body — never a URL, query string, order
  // record or response.
  giftCardCode?: string | null;
}

// The immutable snapshot of the one Mocha Bean reward redeemed on an order
// (Milestone 7C). Reused by confirmation, customer history and the store
// order detail. All values are what was true AT REDEMPTION TIME — later HQ
// edits to the reward never change these.
export interface OrderLoyaltyRewardSummary {
  rewardName: string;
  rewardType: LoyaltyRewardType;
  // Mocha Beans deducted (the reward's full configured cost).
  beanCost: number;
  // Discount applied to the gross merchandise subtotal, integer minor units.
  discountMinorUnits: number;
  // FREE_ITEM only — the product one unit of which was made free.
  freeItemName: string | null;
}

// The immutable snapshot of the ONE gift card redeemed as tender on an
// order (Milestone 7G). Reused by confirmation, customer history and the
// store order detail. `last4` is the ONLY code representation ever exposed —
// the plaintext code and codeHash are never returned. `null` for an order
// that used no gift card. A gift card is a tender, not a discount: it does
// not reduce `subtotal` or any discount, and the merchandise basis for
// promotion / Mocha Bean earning is unaffected.
export interface OrderGiftCardSummary {
  // e.g. "4821" — render as "Gift Card •••• 4821".
  last4: string;
  // The amount of the order paid by this gift card, integer minor units.
  amountMinorUnits: number;
}

// --- Order: the regular Promotion / Coupon snapshot (Milestone 7E) ---
// The immutable record of the ONE regular Promotion or Coupon used on an
// order. Reused by confirmation, customer history and the store order
// detail. Every value is what was true AT REDEMPTION TIME — later HQ edits
// never change these. `null` for an order that used no regular discount.
export type PromotionKind = "AUTOMATIC" | "COUPON";
export type PromotionDiscountType =
  | "PERCENTAGE_OFF"
  | "FIXED_AMOUNT"
  | "FREE_ITEM";

export interface OrderPromotionSummary {
  name: string;
  kind: PromotionKind;
  // The normalized code the customer entered — COUPON only, null for an
  // automatic Promotion.
  couponCode: string | null;
  discountType: PromotionDiscountType;
  // The configured value at redemption (percent, or minor units); 0 for
  // FREE_ITEM.
  discountValue: number;
  // The actual monetary discount applied to gross merchandise, minor units.
  discountMinorUnits: number;
  // FREE_ITEM only — the product one unit of which was made free.
  freeItemName: string | null;
}

// The immutable snapshot of the bonus Mocha Beans awarded on an order by one
// or more Bonus Mocha Bean Promotions (Milestone 7D). Reused by
// confirmation, customer history and the store order detail. Every value is
// what was true AT ORDER TIME — later HQ edits to a promotion never change
// these. `null` for an order that earned no bonus.
export interface OrderLoyaltyBonusItemSummary {
  promotionName: string;
  promotionType: LoyaltyBonusPromotionType;
  bonusValue: number;
  productName: string;
  // Paid qualifying units this promotion applied to.
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

// Returned once, at checkout time. accessToken is the guest's bearer
// credential for the status endpoint — the caller must persist it
// (e.g. in the confirmation URL) to view this order again.
//
// Money (Milestone 7C / 7E / 7G):
//   subtotal          — gross merchandise (sum of every line total).
//   promotionDiscount — the regular Promotion/Coupon discount; 0 when none.
//   rewardDiscount    — the Mocha Bean reward discount; 0 when no reward.
//   total             — subtotal - promotionDiscount - rewardDiscount =
//                       the amount owed (paid by gift card + external
//                       payment together).
//   giftCardTenderMinorUnits — of `total`, the part paid by a redeemed gift
//                       card; 0 when none. A TENDER, not a discount.
//   externalPaymentMinorUnits — total - giftCardTenderMinorUnits = the
//                       amount charged to the external payment method.
//   orderPromotion    — the regular discount snapshot, or null.
//   loyaltyReward     — the redeemed reward snapshot, or null.
//   orderGiftCard     — the redeemed gift-card snapshot (last4 + amount), or
//                       null.
// Pre-7E orders read promotionDiscount 0, orderPromotion null; pre-7C orders
// also read rewardDiscount 0, total === subtotal, loyaltyReward null; pre-7G
// orders read giftCardTenderMinorUnits 0, orderGiftCard null,
// externalPaymentMinorUnits === total.
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
  // Milestone 7D — bonus Mocha Beans earned from HQ promotions, or null.
  loyaltyBonus: OrderLoyaltyBonusSummary | null;
  // Milestone 7G — the redeemed gift-card snapshot (last4 + amount), or null.
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
  // Milestone 7D — bonus Mocha Beans earned from HQ promotions, or null.
  loyaltyBonus: OrderLoyaltyBonusSummary | null;
  // Milestone 7G — the redeemed gift-card snapshot (last4 + amount), or null.
  orderGiftCard: OrderGiftCardSummary | null;
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
  // Whether the identity provider has confirmed this account's email
  // (derived from the Mocha House Customer's emailVerifiedAt — the
  // timestamp itself is never exposed). Read-only here: verification is
  // driven by the Register -> Verify flow, never by a profile update.
  emailVerified: boolean;
  createdAt: string;
}

// --- Preferred locations & communication preferences (Milestone 4F) ---
// The customer account exists to make repeat ordering faster. A preferred
// location is just a saved reference to an authoritative Location — the
// account never stores location details of its own, and orderability is
// always re-checked live against the menu when an order actually begins.
// Marketing consent is kept entirely separate from transactional email.

// GET/POST/DELETE /customers/me/locations all return the customer's
// current preferred set, reusing LocationSummary. `isDigitalOrderingEnabled`
// is the live orderability signal the account UI shows; it is never frozen
// into preference state.
export type CustomerPreferredLocationsResponse = LocationSummary[];

export interface AddPreferredLocationRequest {
  locationId: string;
}

export interface CustomerCommunicationPreferences {
  // true only when the customer has explicitly opted in to marketing email.
  // Never affects transactional/account mail (verification, password
  // recovery, order confirmation, security notices).
  marketingEmailOptIn: boolean;
}

export interface CustomerUpdateCommunicationPreferencesRequest {
  marketingEmailOptIn: boolean;
}

// --- Customer profile management (Milestone 4E) ------------------------
// The Mocha House Customer record is the authoritative application
// profile. This request carries ONLY the customer-editable fields — never
// email, account status, verification state, or the provider identity
// (externalProvider/externalSubject), which a profile update can never
// change. `displayName: null` explicitly clears the stored name (the
// account UI then falls back to the email); a blank/whitespace-only string
// is normalized to null rather than stored.
export interface CustomerUpdateProfileRequest {
  displayName: string | null;
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

// --- Customer registration & email verification (Milestone 4C) ---------
// Register -> Verify -> Sign In, deliberately kept as three separate
// steps (no session is established by register/verify) — see
// customer-auth's registration provider boundary. Never carries a
// password back, a raw provider payload, or a verification code in a
// response body.

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

// --- Customer password recovery & reset (Milestone 4D) -----------------
// Forgot Password -> Reset Password, mirroring Register -> Verify: two
// separate steps, no session established by either. The identity provider
// (Cognito, or its local/test stand-in) owns the recovery code and the
// password — these shapes never carry a code, a password, a raw provider
// payload, or an auth token. A successful reset ends at Sign In; the
// customer is never auto-authenticated.

export interface CustomerForgotPasswordRequest {
  email: string;
}

// Deliberately just a fixed, neutral acknowledgement — the same text
// whether or not an account exists for that email, so the response cannot
// be used to enumerate registered accounts. A genuine provider outage is
// still surfaced as an error status, not masked as this success.
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

// --- Customer order history (Milestone 4B) ------------------------------
// Read-only, authenticated views over the same authoritative Order records
// guest confirmation/tracking already uses (see OrderConfirmation /
// OrderStatusResponse above) — never a separate/parallel order record.
// Deliberately reuses OrderStatus and OrderLineSummary rather than
// duplicating them. These are historical snapshots: nothing here is
// re-derived from the live catalog or from the Customer's current profile.

export interface CustomerOrderSummary {
  orderId: string;
  orderNumber: string;
  createdAt: string;
  locationName: string;
  status: OrderStatus;
  // subtotal = gross merchandise;
  // total = subtotal - promotionDiscount - rewardDiscount (Milestone 7C / 7E)
  //   = the amount owed (paid by gift card + external payment together).
  // Pre-7E orders: promotionDiscount 0; pre-7C orders: rewardDiscount 0;
  // pre-7G orders: giftCardTenderMinorUnits 0, externalPaymentMinorUnits
  // === total.
  subtotal: number;
  promotionDiscount: number;
  rewardDiscount: number;
  total: number;
  // Milestone 7G — the tender split of `total`.
  giftCardTenderMinorUnits: number;
  externalPaymentMinorUnits: number;
  currency: string;
}

export interface CustomerOrderDetail extends CustomerOrderSummary {
  lines: OrderLineSummary[];
  // Milestone 7E — the regular Promotion/Coupon snapshot, or null.
  orderPromotion: OrderPromotionSummary | null;
  loyaltyReward: OrderLoyaltyRewardSummary | null;
  // Milestone 7D — bonus Mocha Beans earned from HQ promotions, or null.
  loyaltyBonus: OrderLoyaltyBonusSummary | null;
  // Milestone 7G — the redeemed gift-card snapshot (last4 + amount), or null.
  orderGiftCard: OrderGiftCardSummary | null;
}

// --- Loyalty: Mocha Beans balance + rewards (Milestone 7A; rewards 7B) --
// "Mocha Beans" is the official customer-facing loyalty currency.
// Customer-facing Bean history is deliberately NOT exposed (it is an
// HQ-controlled setting that defaults off and ships in a later slice).
//
// GET /api/v1/customers/me/loyalty (CustomerAuthGuard). The balance is a
// whole non-negative integer number of Mocha Beans. `rewards` (Milestone
// 7B) is the customer-facing Rewards Catalog: the currently ACTIVE rewards
// only, in HQ display order. Redemption is NOT part of 7B — nothing here
// lets a customer select, reserve or apply a reward, and no Beans move.
export type LoyaltyRewardType = "FIXED_AMOUNT" | "FREE_ITEM";

export interface CustomerLoyaltyReward {
  id: string;
  name: string;
  description: string | null;
  type: LoyaltyRewardType;
  // Whole Mocha Beans the customer would spend to redeem this (in a future
  // slice). Shown for information only in 7B.
  beanCost: number;
  // FIXED_AMOUNT only — the dollar-off value in integer minor units (cents).
  // Null for FREE_ITEM.
  fixedAmountMinorUnits: number | null;
  // FREE_ITEM only — display names of the eligible products/categories.
  // Empty for FIXED_AMOUNT.
  eligibleItemNames: string[];
  // Whether the customer's current balance is >= beanCost. Purely
  // informational; it reserves nothing and deducts nothing.
  canAfford: boolean;
}

export interface CustomerLoyaltySummary {
  balance: number;
  rewards: CustomerLoyaltyReward[];
}

// --- Checkout: Mocha Bean reward eligibility (Milestone 7C) ----------
// POST /api/v1/orders/reward-eligibility (CustomerAuthGuard — signed-in
// customers only; a guest gets no rewards). A read-only quote: given the
// current cart it returns the ACTIVE rewards that are actually eligible for
// THIS cart, each with the discount it would apply and whether the customer
// can currently afford it. It reserves nothing and deducts nothing. The
// checkout submission independently revalidates everything.
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
  // The discount this reward would apply to the current cart, integer minor
  // units (server-computed, authoritative).
  discountMinorUnits: number;
  // FREE_ITEM only — the item that would be made free (lowest-priced
  // eligible unit in the current cart).
  freeItemName: string | null;
  // balance >= beanCost right now. Informational; the checkout submission
  // re-checks under a row lock.
  canAfford: boolean;
}

export interface CheckoutRewardEligibilityResponse {
  balance: number;
  rewards: CheckoutRewardOption[];
}

// --- Checkout: the unified pricing quote (Milestone 7E) -------------
// POST /api/v1/orders/checkout-quote (OptionalCustomerAuthGuard — guests
// allowed; they just get no rewards and cannot use a per-customer-limited
// coupon). The ONE server-authoritative pricing preview the checkout screen
// renders: given the cart, an optional coupon code, and an optional
// selected reward id, it returns the regular Promotion/Coupon discount, the
// eligible Mocha Bean rewards, and the resulting total. It reserves
// nothing, consumes no redemption, and deducts no Beans; the checkout
// submission independently revalidates everything.
export interface CheckoutQuoteRequest {
  locationId: string;
  lines: CheckoutLineInput[];
  // The code the customer typed, or null/omitted. Normalized server-side.
  couponCode?: string | null;
  // The reward the customer currently has selected, or null/omitted.
  loyaltyRewardId?: string | null;
  // Milestone 7G — the gift-card code the customer applied, or null/omitted.
  // Resolved READ-ONLY: the quote validates the card and reports how much it
  // would apply, but reserves and decrements nothing. Never put this in a
  // URL / query string.
  giftCardCode?: string | null;
}

// Why a supplied coupon code did or didn't apply. `null` when no code was
// supplied (the response then carries the best automatic Promotion, if any).
export type CouponQuoteStatus =
  | "applied"
  | "invalid"
  | "inactive"
  | "not_started"
  | "expired"
  | "wrong_location"
  | "not_applicable"
  | "minimum_not_met"
  | "usage_limit_reached"
  | "sign_in_required";

export interface CheckoutQuoteRegularDiscount {
  // COUPON when it came from a customer-entered code; AUTOMATIC when it is
  // the best eligible automatic Promotion.
  source: PromotionKind;
  name: string;
  discountType: PromotionDiscountType;
  // Server-computed, authoritative.
  discountMinorUnits: number;
  // FREE_ITEM only — the item that would be made free.
  freeItemName: string | null;
}

// Milestone 7G — why a supplied gift-card code did or didn't apply on the
// quote. `null` when no code was supplied.
export type GiftCardQuoteStatus =
  | "applied"
  | "not_found"
  | "inactive"
  | "no_balance"
  | "currency_mismatch";

// Milestone 7G — the read-only gift-card preview on the checkout quote.
// Present only when `giftCardCode` was supplied AND it resolved to a usable
// card (`giftCardStatus === "applied"`). Reserves and decrements nothing.
export interface CheckoutQuoteGiftCard {
  // The ONLY code representation — render as "Gift Card •••• 4821".
  last4: string;
  // The card's current balance, integer minor units (informational).
  availableBalanceMinorUnits: number;
  // min(availableBalance, amount owed after promotion + reward discounts).
  appliedMinorUnits: number;
}

export interface CheckoutQuoteResponse {
  currency: string;
  // Gross merchandise (sum of every priced line total).
  subtotal: number;
  // The regular discount that WOULD apply: the supplied coupon if valid,
  // otherwise the best automatic Promotion, otherwise null.
  regularDiscount: CheckoutQuoteRegularDiscount | null;
  // Present only when a coupon code was supplied — why it did / didn't apply.
  couponStatus: CouponQuoteStatus | null;
  couponMessage: string | null;
  // Signed-in customers only (0 / empty for a guest). The rewards are
  // computed against the merchandise remaining AFTER the regular discount.
  balance: number;
  rewards: CheckoutRewardOption[];
  // The discount the currently-selected `loyaltyRewardId` would apply (0
  // when none selected or it no longer applies).
  rewardDiscountMinorUnits: number;
  // subtotal - regularDiscount - rewardDiscountMinorUnits = the amount owed.
  total: number;
  // Milestone 7G — present only when a gift-card code was supplied; why it
  // did / didn't apply.
  giftCardStatus: GiftCardQuoteStatus | null;
  giftCardMessage: string | null;
  // The usable gift-card preview, or null (no code supplied, or it did not
  // resolve to a usable card).
  giftCard: CheckoutQuoteGiftCard | null;
  // total - (giftCard?.appliedMinorUnits ?? 0) = what the customer would pay
  // by external payment. Equals `total` when no gift card applies.
  amountDueAfterGiftCardMinorUnits: number;
}

// --- Admin: HQ loyalty configuration (Milestone 7B) ------------------
// GET/PUT /api/v1/admin/loyalty/settings (InternalAuthGuard +
// PermissionGuard + `loyalty.configure`, CORPORATE-only). The standard
// company-wide Mocha Bean earning rate — a whole number of Beans per whole
// qualifying dollar. Never per-location, per-segment or time-based.
export interface LoyaltySettings {
  earningRatePerDollar: number;
}

// `earningRatePerDollar` must be a whole integer, 1-100. Changing it
// affects only FUTURE earning; historical EARN ledger entries and balances
// are never recalculated.
export interface UpdateLoyaltySettingsRequest {
  earningRatePerDollar: number;
}

// --- Admin: Rewards Catalog (Milestone 7B) --------------------------
// GET/POST/PATCH /api/v1/admin/loyalty/rewards[...] (`loyalty.configure`,
// CORPORATE-only). Catalog management only — no redemption. Rewards are
// never hard-deleted; `isActive` is the off switch.

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
  // FREE_ITEM eligibility. Empty for FIXED_AMOUNT.
  eligibleProducts: AdminLoyaltyRewardCatalogRef[];
  eligibleCategories: AdminLoyaltyRewardCatalogRef[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminLoyaltyRewardsResponse {
  rewards: AdminLoyaltyReward[];
}

// GET /api/v1/admin/loyalty/catalog-options (`loyalty.configure`). The
// product/category picker data for building a FREE_ITEM reward — identity
// and name only, so managing rewards never requires `catalog.view`.
export interface AdminLoyaltyCatalogOptions {
  products: AdminLoyaltyRewardCatalogRef[];
  categories: AdminLoyaltyRewardCatalogRef[];
}

// `type` is required and fixed at creation (never editable). For
// FIXED_AMOUNT: `fixedAmountMinorUnits` (> 0, integer cents) is required
// and eligibility lists must be absent/empty. For FREE_ITEM:
// `fixedAmountMinorUnits` must be absent and there must be >= 1 eligible
// product or category, all referencing existing catalog ids.
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

// Every field optional — only present fields change. `type` is NOT
// accepted. Providing `eligibleProductIds`/`eligibleCategoryIds` REPLACES
// that list wholesale (FREE_ITEM only). `isActive` toggles activation.
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

// --- Admin: Bonus Mocha Beans Promotions (Milestone 7D) -------------
// GET/POST/PATCH /api/v1/admin/loyalty/bonus-promotions[...]
// (`loyalty.configure`, CORPORATE-only). Deliberately simple product-based
// Bean bonus campaigns — NOT a generic promotion/rules engine. Promotions
// are never hard-deleted; `isActive` is the off switch. A promotion never
// discounts money — it only awards extra Mocha Beans on qualifying items.
export type LoyaltyBonusPromotionType = "EXTRA_BEANS" | "MULTIPLIER";

export interface AdminLoyaltyBonusPromotion {
  id: string;
  name: string;
  type: LoyaltyBonusPromotionType;
  // EXTRA_BEANS: whole Beans per qualifying paid unit (1..100000).
  // MULTIPLIER: whole multiple of standard item earning (2..10).
  bonusValue: number;
  isActive: boolean;
  // ISO 8601, or null for "no bound".
  startsAt: string | null;
  endsAt: string | null;
  appliesToAllLocations: boolean;
  eligibleProducts: AdminLoyaltyRewardCatalogRef[];
  // Empty when appliesToAllLocations is true.
  eligibleLocations: AdminLoyaltyRewardCatalogRef[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminLoyaltyBonusPromotionsResponse {
  promotions: AdminLoyaltyBonusPromotion[];
}

// GET /api/v1/admin/loyalty/bonus-promotion-options (`loyalty.configure`).
// The product + location picker data for building a promotion — identity
// and name only, so managing promotions never requires `catalog.view` or
// `locations.view`.
export interface AdminLoyaltyBonusPromotionOptions {
  products: AdminLoyaltyRewardCatalogRef[];
  locations: AdminLoyaltyRewardCatalogRef[];
}

// `type` is required and fixed at creation (never editable). `bonusValue`
// range depends on `type` (see above). At least one `eligibleProductId` is
// required. Location targeting is `appliesToAllLocations: true` OR at least
// one `eligibleLocationId`. If both `startsAt` and `endsAt` are given,
// `endsAt` must be after `startsAt`.
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

// Every field optional — only present fields change. `type` is NOT
// accepted. Providing `eligibleProductIds` / `eligibleLocationIds` REPLACES
// that list wholesale. `isActive` toggles activation.
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

// --- Admin: Promotions & Coupons (Milestone 7E) --------------------
// GET/POST/PATCH /api/v1/admin/promotions[...] (InternalAuthGuard +
// PermissionGuard + `promotions.configure`, CORPORATE-only). The platform's
// regular merchandise-discount system, entirely separate from Mocha Bean
// rewards and Bonus Mocha Bean Promotions. Promotions are never
// hard-deleted; `isActive` is the off switch. `PromotionKind` /
// `PromotionDiscountType` are declared with the order snapshot above.
export type PromotionApplicability =
  | "ENTIRE_ORDER"
  | "SELECTED_PRODUCTS"
  | "SELECTED_CATEGORIES";

export interface AdminPromotionCatalogRef {
  id: string;
  name: string;
}

export interface AdminPromotion {
  id: string;
  name: string;
  description: string | null;
  kind: PromotionKind;
  // Normalized (upper-cased) code — COUPON only, null for AUTOMATIC.
  code: string | null;
  discountType: PromotionDiscountType;
  // PERCENTAGE_OFF: whole percent 1..100. FIXED_AMOUNT: minor units.
  // FREE_ITEM: 0.
  discountValue: number;
  // PERCENTAGE_OFF only — the optional cap on the resulting discount.
  maxDiscountMinorUnits: number | null;
  applicability: PromotionApplicability;
  minimumSubtotalMinorUnits: number | null;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  appliesToAllLocations: boolean;
  totalRedemptionLimit: number | null;
  perCustomerRedemptionLimit: number | null;
  // Persisted successful redemptions so far (informational).
  redemptionCount: number;
  // Empty unless applicability is SELECTED_PRODUCTS / SELECTED_CATEGORIES
  // (products) or a FREE_ITEM promotion.
  eligibleProducts: AdminPromotionCatalogRef[];
  eligibleCategories: AdminPromotionCatalogRef[];
  // Empty when appliesToAllLocations is true.
  eligibleLocations: AdminPromotionCatalogRef[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminPromotionsResponse {
  promotions: AdminPromotion[];
}

// GET /api/v1/admin/promotions/options (`promotions.configure`). Product,
// category and location picker data — identity and name only.
export interface AdminPromotionOptions {
  products: AdminPromotionCatalogRef[];
  categories: AdminPromotionCatalogRef[];
  locations: AdminPromotionCatalogRef[];
}

// `kind` and `discountType` are required and fixed at creation. `code` is
// required for a COUPON and must be absent for an AUTOMATIC promotion.
// PERCENTAGE_OFF: `discountValue` 1..100. FIXED_AMOUNT: `discountValue` a
// positive minor-unit amount. FREE_ITEM / SELECTED_* : at least one
// eligible product or category. Location targeting: `appliesToAllLocations`
// OR at least one `eligibleLocationId`. Dates: `endsAt` after `startsAt`
// when both are present.
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

// Every field optional — only present fields change. `kind` and
// `discountType` are NOT accepted (fixed at creation). Providing an
// eligibility / location list REPLACES it wholesale. `isActive` toggles
// activation.
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

// --- Reorder from order history (Milestone 4G) -------------------------
// The historical Order is a snapshot/reference only. A reorder is ALWAYS
// revalidated against the current location, menu, product availability,
// modifier structure, and pricing before any cart is rebuilt — no
// checkout request is ever constructed from stored historical prices or
// availability. The prepare endpoint mutates nothing (no Order, no
// PaymentAttempt); the web layer converts the validated result into the
// existing cart representation, and checkout still performs its own final
// authoritative validation.

// Machine-readable so the UI can branch reliably; the human-facing
// `message` on each ReorderIssue is mapped deliberately, never a raw
// backend/Prisma error.
export type ReorderIssueCode =
  | "LOCATION_INACTIVE"
  | "LOCATION_DIGITAL_ORDERING_DISABLED"
  | "PRODUCT_NOT_ON_MENU"
  | "PRODUCT_UNAVAILABLE"
  | "PRICE_CHANGED"
  | "MODIFIER_GROUP_REMOVED"
  | "MODIFIER_OPTION_REMOVED"
  | "MODIFIER_REQUIRED_SELECTION_MISSING"
  | "MODIFIER_SELECTION_COUNT_INVALID";

export interface ReorderIssue {
  code: ReorderIssueCode;
  message: string;
  productName?: string;
}

// VALID   — restores exactly, nothing material changed.
// CHANGED — still reorderable, but the customer must see what changed
//           (price moved, an optional modifier disappeared, a now-required
//           choice is missing, min/max no longer satisfied). When
//           `needsCustomization` is true the item must be opened in the
//           normal product customizer before checkout.
// UNAVAILABLE — cannot be automatically restored (product gone from the
//           menu / unavailable). Never silently substituted.
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
  // Current product name (historical name is intentionally not surfaced
  // separately — the current catalog is authoritative for display too).
  productName: string;
  quantity: number;
  currency: string;
  historicalUnitPrice: number;
  // Present unless status is UNAVAILABLE.
  currentUnitPrice?: number;
  currentLineSubtotal?: number;
  // The current, resolved modifier selections (historical option ids that
  // no longer resolve are dropped and reported as issues, never guessed).
  selections: ReorderPreparedSelection[];
  needsCustomization: boolean;
  issues: ReorderIssue[];
}

// READY       — every item is VALID; a fast rebuild is safe.
// NEEDS_REVIEW — at least one item changed or is unavailable, but >=1 item
//               can still be restored. The customer reviews, then confirms.
// UNAVAILABLE  — nothing can be restored (location not orderable, or every
//               item unavailable).
export type ReorderPreparationStatus = "READY" | "NEEDS_REVIEW" | "UNAVAILABLE";

export interface ReorderPreparation {
  orderId: string;
  location: LocationSummary;
  // The current active menu id for the location — present unless the
  // location is UNAVAILABLE. The web layer stamps it onto rebuilt cart
  // lines; cart/checkout revalidation is still by location.
  menuId?: string;
  status: ReorderPreparationStatus;
  items: ReorderPreparedItem[];
  // Order-level issues (currently only location problems).
  issues: ReorderIssue[];
  historicalTotal: number;
  // Sum of currentLineSubtotal across restorable (VALID/CHANGED) items.
  currentEstimatedSubtotal: number;
}

// --- Store Queue / operational lifecycle (Milestone 3, next slice) -----
// As of Milestone 5A every /api/v1/admin/* route (this one included) is
// protected by InternalAuthGuard — a valid internal identity mapped to an
// ACTIVE Mocha House InternalUser. There is still no role/permission/scope
// model (Milestone 5B). Deliberately excludes guest accessToken and
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
  // Milestone 7E / 7C — the regular Promotion/Coupon and Mocha Bean reward
  // snapshots and the resulting discounts, so staff can see the order's true
  // owed total. Null / 0 when the corresponding discount was not used.
  promotionDiscount: number;
  rewardDiscount: number;
  total: number;
  // Milestone 7G — the tender split of `total` (0 / null when no gift card).
  giftCardTenderMinorUnits: number;
  externalPaymentMinorUnits: number;
  orderPromotion: OrderPromotionSummary | null;
  loyaltyReward: OrderLoyaltyRewardSummary | null;
  // Milestone 7D — bonus Mocha Beans earned from HQ promotions, or null, so
  // staff/HQ can explain the order's Bean accounting.
  loyaltyBonus: OrderLoyaltyBonusSummary | null;
  // Milestone 7G — the redeemed gift-card snapshot (last4 + amount), or null.
  orderGiftCard: OrderGiftCardSummary | null;
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

// --- Internal identity & admin authentication (Milestone 5A) -----------
// A SEPARATE security boundary from customer authentication. These shapes
// share nothing with CustomerProfile / CustomerSignInResponse and must
// never be substituted for them. The production internal identity provider
// is a dedicated Cognito user pool + app client (distinct from the customer
// pool); a fail-closed local-dev provider stands in when no pool is
// provisioned. Mocha House remains authoritative for the InternalUser
// record, its lifecycle status, and (from Milestone 5B) its permissions
// and scope — none of which live here yet.
//
// CRITICAL: a valid internal identity token proves identity only. Internal/
// Admin access is granted solely when the identity maps to an existing
// Mocha House InternalUser whose status is ACTIVE. INVITED, SUSPENDED and
// DISABLED are all denied even with an otherwise-valid token, and an
// unknown identity is never provisioned just-in-time.
export type InternalUserStatus =
  | "INVITED"
  | "ACTIVE"
  | "SUSPENDED"
  | "DISABLED";

export interface InternalSignInRequest {
  identifier: string;
  password: string;
}

// idToken is a bearer credential for the internal boundary only
// (Authorization: Bearer <idToken> against /api/v1/internal/* and
// /api/v1/admin/*). It is expected to be stored only in the HttpOnly
// `mh_internal_session` cookie, never in browser-readable storage, and is
// never interchangeable with a customer session token.
export interface InternalSignInResponse {
  idToken: string;
  expiresInSeconds: number;
}

// The mapped InternalUser for the authenticated internal identity. Only
// ever returned for an ACTIVE user (the guard rejects every other state
// before the controller runs), so `status` is always "ACTIVE" here; it is
// included for symmetry and forward compatibility, not as a branch the
// caller must handle.
export interface InternalUserProfile {
  id: string;
  email: string;
  displayName: string | null;
  status: InternalUserStatus;
}

// The scope at which a single permission is EFFECTIVE for the user.
//   corporate  — the permission applies at every location (a CORPORATE
//                grant). When true, `locationIds` need not be consulted.
//   locationIds — the specific active Location ids the permission is held
//                at through LOCATION grants. Empty when the permission is
//                only held corporately.
// A permission appears in `capabilities` only if it is effective (held
// through a scope type the permission actually allows — a CORPORATE-only
// permission held only via LOCATION scope never appears, exactly as 5B
// enforcement rejects it).
export interface InternalPermissionCapability {
  corporate: boolean;
  locationIds: string[];
}

// The minimum authorization summary the Admin shell needs to render a
// personalized workspace (Milestone 5C). It is a DERIVED, read-only view of
// the 5B authorization model — never the model itself. It deliberately
// exposes NO role names/keys/ids, NO assignment ids, and NO raw scope rows;
// the backend remains the sole authorization authority and every Admin API
// call is still guarded server-side regardless of what the shell renders.
//
//   capabilities — per effective permission, the scope it is effective at
//                  (see InternalPermissionCapability). This is the
//                  authoritative "does the user hold X, and where" source
//                  for the shell — components must not infer a permission's
//                  scope from `locations` below. Empty object for a user
//                  with no role assignments.
//   permissions  — Object.keys(capabilities); a flat convenience view for
//                  simple "holds X anywhere" checks (e.g. nav visibility).
//   isCorporate  — the user holds at least one CORPORATE-scoped grant of
//                  ANY permission; drives whether the shell offers a
//                  "Corporate / All locations" context. Not a per-permission
//                  signal — use capabilities[key].corporate for that.
//   locations    — the ACTIVE locations the user may operate on at all
//                  (the union across every LOCATION grant, plus every
//                  active location when isCorporate). This is the general
//                  location-selector set, NOT a per-permission scope.
export interface InternalAuthorizationSummary {
  permissions: InternalPermissionKey[];
  isCorporate: boolean;
  locations: LocationSummary[];
  capabilities: Partial<
    Record<InternalPermissionKey, InternalPermissionCapability>
  >;
}

// GET /api/v1/internal/me — the authenticated internal user plus the
// authorization summary above. Guarded by InternalAuthGuard only (any
// ACTIVE internal user may read their own summary — no PermissionGuard).
export interface InternalMeResponse {
  user: InternalUserProfile;
  authorization: InternalAuthorizationSummary;
}

// --- Admin: internal user access review (Milestone 5E-1) --------------
// The business-facing read model for the Administration → Users screens.
// Served only from `/api/v1/admin/internal-users*` (InternalAuthGuard +
// PermissionGuard + `users.view`, CORPORATE-only). Deliberately exposes NO
// externalProvider / externalSubject / scopeId / raw permission keys /
// assignment ids — an administrator answers "who has access, are they
// active, what can they do, where" without RBAC vocabulary.

// Where a person can operate, as a whole:
//   all      — they hold at least one corporate role assignment.
//   selected — only specific locations (the union of their location
//              assignments), resolved to names.
//   none     — they have no role assignments at all.
// This reflects the SCOPE of their assignments, not a per-permission
// intersection — see the "What they can do" list for per-capability detail.
export type AdminUserLocationAccess =
  | { kind: "all" }
  | { kind: "selected"; locations: { id: string; name: string }[] }
  | { kind: "none" };

export interface AdminInternalUserSummary {
  id: string;
  displayName: string | null;
  email: string;
  status: InternalUserStatus;
  // The display names of the roles assigned to this person (deduplicated;
  // a role held at several locations appears once). Empty when the person
  // has no role assignments.
  accessLevels: string[];
  locationAccess: AdminUserLocationAccess;
}

// One heading of the "What they can do" list, with its plain-language
// lines. Groups with no lines are omitted entirely.
export interface AdminUserCapabilityGroup {
  group: string;
  items: string[];
}

export interface AdminInternalUserDetail extends AdminInternalUserSummary {
  // Derived from the SAME effective-authorization resolution the guards use
  // (permission + scope), never from a role name. Empty when the person has
  // no effective permissions.
  capabilities: AdminUserCapabilityGroup[];
  // The CONCRETE access grants this person holds (Milestone 5E-4). A person
  // who holds an access level at three locations has three entries here,
  // each independently removable. Ordered corporate-first, then by location
  // name. Empty when the person has no assignments.
  assignments: AdminInternalUserAccessAssignment[];
}

// --- Admin: access level + location assignment (Milestone 5E-4) ------
// One concrete access grant: an access level (InternalRole) applied either
// to every location (corporate) or to exactly one location. Deliberately
// exposes no scope-type enum, no scopeId, no role key, no permission keys —
// an administrator works in "access level / where" terms.
export interface AdminInternalUserAccessAssignment {
  id: string;
  accessLevel: { id: string; displayName: string; isBuiltIn: boolean };
  // The single location this grant applies to, or null when it applies to
  // every location.
  location: { id: string; name: string } | null;
  isCorporate: boolean;
}

// Where an access level may be applied, derived from the capabilities it
// contains (their allowed scope types) and, for the access levels the
// platform ships with, a fixed policy — never from the role's name as an
// authorization input.
//   "corporate-only" — applies to every location; no location choice.
//   "location-only"  — applies to chosen locations; at least one required.
export type AdminAccessAssignmentShape = "corporate-only" | "location-only";

export interface AdminAssignableAccessLevel {
  id: string;
  displayName: string;
  description: string | null;
  isBuiltIn: boolean;
  assignmentShape: AdminAccessAssignmentShape;
  // Plain-language, scope-agnostic summary of what this access level
  // allows — the same wording the access-level detail screen shows.
  capabilities: AdminUserCapabilityGroup[];
}

// GET /api/v1/admin/internal-users/access-options — the picker data for
// granting access. Gated by `users.manage_roles` (CORPORATE-only); holding
// it is sufficient, `roles.view` is NOT additionally required. `locations`
// is the active locations only.
export interface AdminAccessAssignmentOptions {
  accessLevels: AdminAssignableAccessLevel[];
  locations: { id: string; name: string }[];
}

// POST /api/v1/admin/internal-users/:internalUserId/role-assignments —
// grant an access level (`users.manage_roles`, CORPORATE-only, audited).
// The client never sends permission keys, a role key, a scope enum or
// assignment tuples: only an access level, where it applies, and why.
//   scope.kind "corporate" — apply to every location (no locationIds).
//   scope.kind "locations" — apply to each location (>= 1, de-duplicated;
//                            each must exist and be active).
export interface AdminAssignInternalUserRoleRequest {
  roleId: string;
  scope:
    | { kind: "corporate" }
    | { kind: "locations"; locationIds: string[] };
  reason: string;
}

// POST /api/v1/admin/internal-users/:internalUserId/role-assignments/:assignmentId/remove
// — remove ONE concrete access grant (`users.manage_roles`, CORPORATE-only,
// audited). Removing one location's grant never touches the person's other
// locations. `reason` is required.
export interface AdminRemoveInternalUserRoleAssignmentRequest {
  reason: string;
}

// --- Admin: activity log (Milestone 5F) -----------------------------
// The business-facing, read-only projection of InternalAuditEvent. Served
// only from `GET /api/v1/admin/audit` (InternalAuthGuard + PermissionGuard
// + `audit.view`, CORPORATE-only). The API constructs every field
// explicitly — it NEVER returns a raw audit row, `beforeData` / `afterData`,
// a raw `action` / `targetType` string, or any UUID other than the opaque
// event id / actor id.
export type AdminAuditActivityType =
  | "admin_access_status_changed"
  | "admin_access_granted"
  | "admin_access_removed";

export interface AdminAuditEventSummary {
  // Opaque event id — also the forward-pagination cursor.
  id: string;
  // ISO 8601 timestamp of when the activity happened.
  occurredAt: string;
  // The business category. A row whose stored action is not recognised is
  // still returned, projected as a safe generic activity (see
  // `activityLabel`) but with no `activityType` — clients must tolerate a
  // value outside the union or, in practice, filter on the ones they know.
  activityType: AdminAuditActivityType | "other";
  // A complete plain-language sentence, e.g.
  // "Nasser gave Sarah Store Manager access for Dearborn Heights".
  activityLabel: string;
  actor: { id: string; name: string; email: string };
  // Who the activity was about, already resolved to a display label.
  subject: { kind: "admin_user"; label: string };
  // Present only for location-scoped access changes.
  location: { name: string } | null;
  reason: string;
  // Small, business-worded extra lines for inline disclosure (e.g. previous
  // / new access state on a status change). Empty for most events.
  details: { label: string; value: string }[];
}

export interface AdminAuditEventPage {
  events: AdminAuditEventSummary[];
  // Forward cursor: pass as `?cursor=` to fetch the next (older) page.
  // Null when there are no older events in the current filtered set.
  nextCursor: string | null;
}

export interface AdminAuditFilterOptions {
  activityTypes: { value: AdminAuditActivityType; label: string }[];
}

// --- Admin: platform status (Milestone 5G) --------------------------
// A small, read-only, business-facing view of the platform's current
// high-level posture. Served only from `GET /api/v1/admin/platform/status`
// (InternalAuthGuard + PermissionGuard + `platform.view`, CORPORATE-only).
//
// It is INFORMATIONAL ONLY — there is no write endpoint and no persisted
// configuration. Every field is constructed explicitly from information the
// application already holds (provider mode, the payment boundary, aggregate
// location counts). It NEVER exposes a secret, credential, connection
// string, ARN, pool/client id, raw environment-variable name or value, or
// any other infrastructure identifier — `label` fields carry plain business
// language, not implementation detail.
export interface AdminPlatformStatus {
  // "Development" or "Production".
  environmentLabel: string;
  isProduction: boolean;
  authentication: {
    // e.g. "Amazon Cognito" or "Local development authentication".
    adminLabel: string;
    customerLabel: string;
  };
  payments: {
    // e.g. "Development payment provider" or "Live payment provider".
    providerLabel: string;
    isDevelopmentStandIn: boolean;
  };
  locations: {
    activeCount: number;
    inactiveCount: number;
    // Among ACTIVE locations only.
    digitalOrderingEnabledCount: number;
    digitalOrderingDisabledCount: number;
  };
}

// --- Admin: access levels (roles) review (Milestone 5E-2) ------------
// The business-facing read model for the Administration → Access Levels
// screens. Served only from `/api/v1/admin/internal-roles*` (InternalAuthGuard
// + PermissionGuard + `roles.view`, CORPORATE-only). An "access level" is an
// InternalRole; this contract deliberately exposes no role key, no raw
// permission keys, and no assignment rows.
export interface AdminRoleSummary {
  id: string;
  displayName: string;
  description: string | null;
  // Presentation metadata only, mapped from InternalRole.isSystem. It marks
  // a role the platform ships with — it currently confers and enforces
  // NOTHING (no edit protection exists yet).
  isBuiltIn: boolean;
  // The number of distinct people who hold this access level (a person who
  // holds it at several locations counts once).
  userCount: number;
}

export interface AdminRoleDetail extends AdminRoleSummary {
  // What this access level ALLOWS, in plain language — the capability
  // template, scope-agnostic ("View orders", not "…at all locations").
  // Only groups/items backed by a KNOWN permission on the role appear;
  // unknown stored permission keys are omitted (fail-closed).
  capabilities: AdminUserCapabilityGroup[];
}

// --- Admin: internal user status management (Milestone 5E-3) ---------
// PATCH /api/v1/admin/internal-users/:id/status — a highly privileged,
// audited write (`users.manage_status`, CORPORATE-only). Only these three
// statuses are settable: INVITED is never accepted here (invitation /
// activation is a later slice), and DISABLED is terminal (a disabled
// account can only be viewed, never re-enabled through this endpoint).
// `reason` is REQUIRED for every change and is stored on the audit event.
// The response is the updated AdminInternalUserDetail so the screen can
// refresh in place.
export interface AdminUpdateInternalUserStatusRequest {
  status: "ACTIVE" | "SUSPENDED" | "DISABLED";
  reason: string;
}

// --- Internal authorization: permissions & scope (Milestone 5B) --------
// The CLOSED permission vocabulary. This is the single source of truth for
// what internal/Admin capabilities exist: a permission string only grants
// anything if server code checks that exact key, so roles configured in the
// database can never invent an unimplemented capability — they can only
// select from this list. Roles and role→permission and user→role→scope
// assignments are database data; this vocabulary is code.
//
// Keep this minimal: only permissions a CURRENT Admin route needs, or one
// approved to land alongside its slice. `locations.edit` is the single
// deliberate exception — an approved Milestone 5D product decision that is
// declared here in 5D-1 but not wired to a route until 5D-2, so the
// vocabulary and the seed role sync are ready. This is not licence to
// pre-declare a speculative future catalog.
export const INTERNAL_PERMISSION_KEYS = [
  "orders.view",
  "orders.manage_status",
  "catalog.products.edit",
  "catalog.menu.manage",
  "catalog.overrides.manage",
  "catalog.view",
  "locations.view",
  "locations.edit",
  "locations.manage_digital_ordering",
  "users.view",
  "roles.view",
  "users.manage_status",
  // Milestone 5E-4
  "users.manage_roles",
  // Milestone 5F
  "audit.view",
  // Milestone 5G
  "platform.view",
  // Milestone 6A
  "operations.view",
  // Milestone 6B
  "operations.tasks.complete",
  // Milestone 6B-2
  "operations.checklists.configure",
  // Milestone 6C
  "operations.exceptions.manage",
  // Milestone 7A — Mocha Beans (loyalty). Both CORPORATE-only: a Mocha Bean
  // balance is company-wide, not location-scoped, and manual adjustment is
  // a highly sensitive HQ action a Store Manager never holds.
  "loyalty.view",
  "loyalty.adjust",
  // Milestone 7B — HQ loyalty configuration: the company-wide earning rate
  // and the Rewards Catalog. Milestone 7D also reuses this key for Bonus
  // Mocha Bean Promotions. CORPORATE-only; a Store Manager never holds it.
  "loyalty.configure",
  // Milestone 7E — HQ management of Promotions & Coupons (the regular
  // merchandise-discount system). A company-wide pricing capability;
  // CORPORATE-only, and a Store Manager never holds it.
  "promotions.configure",
  // Milestone 7F — Gift Card Foundation & Administration. A gift card is
  // company-wide stored value, so all three keys are CORPORATE-only and a
  // Store Manager never holds them.
  //   giftcards.view      — search/find, view detail, balance, status,
  //                         transaction history.
  //   giftcards.manage    — issue an HQ gift card, deactivate / reactivate,
  //                         perform an authorized manual balance correction
  //                         (a required reason, audited). Highly privileged.
  //   giftcards.configure — view/update the gift-card purchasing
  //                         configuration (preset amounts, custom-amount
  //                         enabled/disabled).
  "giftcards.view",
  "giftcards.manage",
  "giftcards.configure",
  // Milestone 8A — HQ CRM. A Mocha House customer is a company-wide record,
  // so both keys are CORPORATE-only and a Store Manager never holds them.
  //   customers.view          — the HQ customer directory + an individual
  //                             customer's aggregated profile / status /
  //                             loyalty / gift-card / order / preference
  //                             summary and CRM notes (all read-only).
  //   customers.notes.manage  — add an internal CRM note to a customer.
  "customers.view",
  "customers.notes.manage",
  // Milestone 8B — HQ Careers / Job Openings. A job opening is a
  // company-wide record (even when tied to one location), so both keys are
  // CORPORATE-only and a Store Manager never holds them.
  //   careers.view    — view job openings in Admin (draft / published /
  //                     archived) and their detail.
  //   careers.manage  — create, edit, publish, unpublish and archive a job
  //                     opening.
  "careers.view",
  "careers.manage",
  // Milestone 8C — Applicants. Applicant / application records contain
  // candidate PII, so both keys are CORPORATE-only and a Store Manager
  // never holds them.
  //   applicants.view    — read applicant / application records and notes.
  //   applicants.manage  — change an application's status and add an
  //                        internal applicant note.
  "applicants.view",
  "applicants.manage",
  // Milestone 8D — Franchising inquiries. A franchise prospect's contact
  // details are PII, so both keys are CORPORATE-only and a Store Manager
  // never holds them.
  //   franchising.view    — read franchise inquiries and their notes.
  //   franchising.manage  — change an inquiry's status and add an internal
  //                         note.
  "franchising.view",
  "franchising.manage",
  // Milestone 8E — CMS foundation. Public site content is a company-wide
  // concern, so both keys are CORPORATE-only.
  //   cms.view    — read managed content pages (draft + published).
  //   cms.manage  — save draft content and publish a page.
  "cms.view",
  "cms.manage",
  // Milestone 8F — Media Library. Uploaded images are shared, company-wide
  // assets, so both keys are CORPORATE-only.
  //   media.view    — browse the media library.
  //   media.manage  — upload a new asset and deactivate an unused one.
  "media.view",
  "media.manage",
] as const;

export type InternalPermissionKey = (typeof INTERNAL_PERMISSION_KEYS)[number];

// Scope types the application currently supports operationally. The Prisma
// enum mirrors exactly this set — additional organizational scope types
// (location groups, franchise organizations) are added only when their
// domain models exist.
//
//   CORPORATE — assignment.scopeId is null; grants the permission for every
//               current location.
//   LOCATION  — assignment.scopeId is a Location id; grants the permission
//               for that one location only.
export const INTERNAL_SCOPE_TYPES = ["CORPORATE", "LOCATION"] as const;

export type InternalScopeType = (typeof INTERNAL_SCOPE_TYPES)[number];

export interface InternalPermissionMetadata {
  key: InternalPermissionKey;
  description: string;
  // The scope types through which this permission may be granted. A
  // permission held only through an assignment whose scopeType is not in
  // this list does NOT authorize the action. Master/global catalog
  // operations are CORPORATE-only precisely so a location-scoped manager
  // can never change a master product or menu for every store.
  allowedScopeTypes: readonly InternalScopeType[];
}

export const INTERNAL_PERMISSION_METADATA: Record<
  InternalPermissionKey,
  InternalPermissionMetadata
> = {
  "orders.view": {
    key: "orders.view",
    description: "View the store order queue and individual order detail.",
    allowedScopeTypes: ["CORPORATE", "LOCATION"],
  },
  "orders.manage_status": {
    key: "orders.manage_status",
    description: "Advance an order through its operational lifecycle.",
    allowedScopeTypes: ["CORPORATE", "LOCATION"],
  },
  "catalog.products.edit": {
    key: "catalog.products.edit",
    description:
      "Edit a master product (name, description, base price, active state). Affects every location.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "catalog.menu.manage": {
    key: "catalog.menu.manage",
    description:
      "Change which products appear on a menu. Menus are shared across locations.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "catalog.overrides.manage": {
    key: "catalog.overrides.manage",
    description:
      "Set or clear a location's price and availability overrides.",
    allowedScopeTypes: ["CORPORATE", "LOCATION"],
  },
  "catalog.view": {
    key: "catalog.view",
    description:
      "View the master product catalog in Admin, including inactive products. The catalog is shared across every location, so this is a corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "locations.view": {
    key: "locations.view",
    description:
      "View Admin location records (including inactive) within the granted scope. A LOCATION grant sees only its own locations; a CORPORATE grant sees all.",
    allowedScopeTypes: ["CORPORATE", "LOCATION"],
  },
  "locations.edit": {
    key: "locations.edit",
    description:
      "Edit a location record (name, active state). A corporate-scoped operation.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "locations.manage_digital_ordering": {
    key: "locations.manage_digital_ordering",
    description: "Toggle a location's digital-ordering availability.",
    allowedScopeTypes: ["CORPORATE", "LOCATION"],
  },
  "users.view": {
    key: "users.view",
    description:
      "View internal Admin users, their status, access levels and location access. User administration is a corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "roles.view": {
    key: "roles.view",
    description:
      "View Admin access levels (roles) and the capabilities included in each. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "users.manage_status": {
    key: "users.manage_status",
    description:
      "Suspend, reactivate, or disable an internal Admin user. Highly privileged; corporate-only.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "users.manage_roles": {
    key: "users.manage_roles",
    description:
      "Assign or remove internal-user access levels and their location scope. Highly privileged; corporate-only.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "audit.view": {
    key: "audit.view",
    description:
      "View the Admin activity log — the recorded history of administrative access changes. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "platform.view": {
    key: "platform.view",
    description:
      "View platform status and configuration — a read-only, high-level view of the platform's environment, authentication, payment and location posture. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  // Milestone 6A — the entry point to the Store Operations workspace. Held
  // at CORPORATE (an operations user works across every store) or at
  // LOCATION (a store manager works their own stores). It gates only the
  // Operations area's read views; it never, on its own, grants any other
  // capability — order information shown there is still governed by
  // `orders.view`, exactly as on every other screen.
  "operations.view": {
    key: "operations.view",
    description:
      "View the Store Operations workspace for a location — the day's operational picture. Held at corporate or per location.",
    allowedScopeTypes: ["CORPORATE", "LOCATION"],
  },
  // Milestone 6B — complete (and undo) operational checklist/task items for
  // an authorized location. This is the first Operations *write*. It never
  // grants viewing on its own (`operations.view` still gates the workspace)
  // and, like `operations.view`, is held at corporate (an operations user
  // working across every store) or per location (a store manager).
  "operations.tasks.complete": {
    key: "operations.tasks.complete",
    description:
      "Complete operational checklist and task items for an authorized location. Held at corporate or per location.",
    allowedScopeTypes: ["CORPORATE", "LOCATION"],
  },
  // Milestone 6B-2 — manage the corporate daily-checklist templates that
  // every location's daily checklist is created from (item wording, active
  // state, ordering, sections). Governs BOTH the Opening (6B-2) and Closing
  // (6D) checklist templates — there is one corporate standard per
  // checklist and no per-location override, so this is CORPORATE-only. It
  // is a configuration capability only: it never grants `operations.view`
  // or `operations.tasks.complete`, and completing a store's daily
  // checklist still requires `operations.tasks.complete`.
  "operations.checklists.configure": {
    key: "operations.checklists.configure",
    description:
      "Manage the corporate Opening and Closing Checklist templates — item wording, active state, ordering and sections. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  // Milestone 6C — log and clear a Management Exception on a daily-checklist
  // item (Opening or Closing since 6D): a manager-authorized way to RESOLVE
  // an item that could not actually be completed, with a required reason.
  // It is deliberately separate from `operations.tasks.complete` — waiving
  // a standard requirement is a management decision, not a routine tick,
  // and it is audited. Held at corporate (an operations user across every
  // store) or per location (a store manager for their store).
  "operations.exceptions.manage": {
    key: "operations.exceptions.manage",
    description:
      "Log and clear a management exception on a daily-checklist item for an authorized location. Held at corporate or per location.",
    allowedScopeTypes: ["CORPORATE", "LOCATION"],
  },
  // Milestone 7A — Mocha Beans (loyalty). A Bean balance is a single
  // company-wide figure per customer, so both keys are CORPORATE-only.
  "loyalty.view": {
    key: "loyalty.view",
    description:
      "View a customer's Mocha Bean balance and the internal Bean transaction ledger. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "loyalty.adjust": {
    key: "loyalty.adjust",
    description:
      "Manually add or deduct a customer's Mocha Beans, with a required reason. Highly privileged; corporate-only.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "loyalty.configure": {
    key: "loyalty.configure",
    description:
      "Configure the standard company-wide Mocha Bean earning rate, manage the customer Rewards Catalog, and manage Bonus Mocha Bean Promotions. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "promotions.configure": {
    key: "promotions.configure",
    description:
      "Create and manage Promotions & Coupons (the regular merchandise-discount system). A company-wide pricing capability; corporate-only.",
    allowedScopeTypes: ["CORPORATE"],
  },
  // Milestone 7F — Gift Cards. A gift card is company-wide stored value, so
  // every key is CORPORATE-only; a Store Manager never holds them.
  "giftcards.view": {
    key: "giftcards.view",
    description:
      "Search for a gift card and view its detail — masked code, original value, current balance, active/inactive status and transaction history. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "giftcards.manage": {
    key: "giftcards.manage",
    description:
      "Issue an HQ gift card, deactivate or reactivate a gift card, and make an authorized manual balance correction with a required reason. Highly privileged; corporate-only.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "giftcards.configure": {
    key: "giftcards.configure",
    description:
      "View and update the gift-card purchasing configuration — preset purchase amounts and whether custom amounts are allowed. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "customers.view": {
    key: "customers.view",
    description:
      "View the HQ customer directory and an individual customer's profile, contact details, account status and their loyalty / gift-card / order / preference summary and internal CRM notes. Read-only. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "customers.notes.manage": {
    key: "customers.notes.manage",
    description:
      "Add an internal CRM note to a customer record. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "careers.view": {
    key: "careers.view",
    description:
      "View job openings in Admin, including drafts and archived openings, and their detail. Read-only. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "careers.manage": {
    key: "careers.manage",
    description:
      "Create, edit, publish, unpublish and archive job openings. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "applicants.view": {
    key: "applicants.view",
    description:
      "View job applicants and individual applications, including candidate contact details and internal notes. Read-only. Candidate PII, so a corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "applicants.manage": {
    key: "applicants.manage",
    description:
      "Change a job application's status and add an internal applicant note. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "franchising.view": {
    key: "franchising.view",
    description:
      "View franchise inquiries and their internal notes. Read-only. Prospect PII, so a corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "franchising.manage": {
    key: "franchising.manage",
    description:
      "Change a franchise inquiry's status and add an internal note. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "cms.view": {
    key: "cms.view",
    description:
      "View managed public content pages, including draft content. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "cms.manage": {
    key: "cms.manage",
    description:
      "Save draft content and publish a managed public content page. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "media.view": {
    key: "media.view",
    description: "Browse the media library. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
  "media.manage": {
    key: "media.manage",
    description:
      "Upload a new media asset and deactivate an unused one. A corporate capability.",
    allowedScopeTypes: ["CORPORATE"],
  },
};

// --- Store Operations: the daily checklist view (Milestone 6B) ---------
// The business-facing view of one location's daily checklist for one
// business day. SHARED by the Opening Checklist (6B) and the Closing
// Checklist (6D) — the two are structurally identical; `title` carries the
// human name ("Opening Checklist" / "Closing Checklist"). Served only from
// the guarded `/api/v1/admin/operations/{opening,closing}-checklist*`
// routes (InternalAuthGuard + PermissionGuard + resource-level location
// scope). GET requires `operations.view`; Complete / Undo require
// `operations.tasks.complete`.
//
// The API constructs every field explicitly — it NEVER returns a raw Prisma
// model, a template id, an internal user id, a permission key, or a
// technical database field. `item.id` is an opaque action/resource id (the
// ChecklistInstanceItem id) and is the only identifier here.
//
// `businessDate` is `YYYY-MM-DD`, resolved in the Mocha House business
// timezone (America/Detroit). Sections and items are already ordered and
// come from the seeded corporate template.
//
// The `OpeningChecklist*` names are the established vocabulary (6B); they
// are the shared checklist contract, not opening-specific.
//
// RESOLUTION (Milestone 6C): an item is "resolved" when it is completed
// normally OR carries a management exception. `status` is the single source
// of truth for the UI; `completed` stays true ONLY for a normal completion
// so older callers keep their meaning. Progress is derived: `isComplete` is
// `resolved === total`.
export type OpeningChecklistItemStatus = "open" | "completed" | "exception";

export interface OpeningChecklistItemView {
  // Opaque ChecklistInstanceItem id — the target for Complete / Undo /
  // Log Exception / Clear Exception.
  id: string;
  label: string;
  status: OpeningChecklistItemStatus;
  // status !== "open" — the item no longer blocks the checklist.
  resolved: boolean;
  // TRUE only for a NORMAL completion (status === "completed"). An
  // exception-resolved item is `false` here — it must never render as an
  // ordinary completed checkmark.
  completed: boolean;
  // The current completion actor's display name, or null when not completed
  // normally. Undo clears this — only the CURRENT actor is kept, not a
  // history.
  completedBy: { name: string } | null;
  // ISO 8601 timestamp of the current normal completion, or null.
  completedAt: string | null;
  // Present only when status === "exception". The reason is required text;
  // `by` is the manager who logged it (null only if that user is missing);
  // `at` is the ISO 8601 timestamp. Cleared together by Clear Exception.
  exception: {
    reason: string;
    by: { name: string } | null;
    at: string;
  } | null;
}

export interface OpeningChecklistSectionView {
  name: string;
  items: OpeningChecklistItemView[];
}

export interface OpeningChecklistProgress {
  // Items completed NORMALLY.
  completed: number;
  // Items resolved by normal completion OR a management exception. This is
  // the number to show as "X of Y".
  resolved: number;
  total: number;
  // resolved === total (and total > 0). There is no readiness score.
  isComplete: boolean;
}

export interface OpeningChecklistResponse {
  locationId: string;
  locationName: string;
  businessDate: string;
  // The template name — "Opening Checklist".
  title: string;
  progress: OpeningChecklistProgress;
  sections: OpeningChecklistSectionView[];
}

// POST body for both
// `/api/v1/admin/operations/opening-checklist/items/:instanceItemId/complete`
// and `.../undo`. `locationId` is a REQUIRED filter — it is checked against
// the item's own instance, never trusted as proof of authorization.
export interface OpeningChecklistItemActionRequest {
  locationId: string;
}

// --- Store Operations: Management Exception (Milestone 6C) ------------
// POST `/api/v1/admin/operations/opening-checklist/items/:instanceItemId/exception`
// — requires `operations.exceptions.manage` for the location. Rejected
// (409) when the item is already completed normally. `reason` is required,
// trimmed, non-empty and at most 500 characters. Logging an exception is
// recorded as an InternalAuditEvent.
export interface LogOpeningChecklistExceptionRequest {
  locationId: string;
  reason: string;
}

// POST `.../items/:instanceItemId/exception/clear` — requires
// `operations.exceptions.manage`. Returns the item to "open". Also audited.
export interface ClearOpeningChecklistExceptionRequest {
  locationId: string;
}

// --- Store Operations: Today's Tasks (Milestone 6C) -----------------
// Simple, location-scoped operational to-dos for ONE America/Detroit
// business date. Served only from the guarded
// `/api/v1/admin/operations/tasks*` routes (InternalAuthGuard +
// PermissionGuard + resource-level location scope). GET requires
// `operations.view`; add / complete / reopen / delete require
// `operations.tasks.complete`.
//
// A task belongs only to `businessDate` — there is no rollover, no due
// time, no assignee, no priority, no category. "Open" vs "Done" is derived
// purely from completion state. Routine task actions are NOT audited.
export interface OperationsTaskView {
  // Opaque OperationsTask id — the target for the task actions.
  id: string;
  title: string;
  note: string | null;
  done: boolean;
  // Display name of who completed it, or null when open.
  completedBy: { name: string } | null;
  // ISO 8601 timestamp of completion, or null when open.
  completedAt: string | null;
  // Display name of the creator, or null only if that user is missing.
  createdBy: { name: string } | null;
  // ISO 8601 timestamp.
  createdAt: string;
}

export interface OperationsTasksResponse {
  locationId: string;
  locationName: string;
  businessDate: string;
  // Open tasks first (oldest first), then done tasks (oldest first).
  tasks: OperationsTaskView[];
  openCount: number;
  doneCount: number;
}

// POST `/api/v1/admin/operations/tasks` — `title` is required, trimmed,
// non-empty and at most 200 characters; `note` is optional, trimmed and at
// most 500 characters (an empty note is stored as null).
export interface CreateOperationsTaskRequest {
  locationId: string;
  title: string;
  note?: string;
}

// POST body for `/tasks/:taskId/complete`, `/tasks/:taskId/reopen` and
// `/tasks/:taskId/delete`. `locationId` is a REQUIRED filter, checked
// against the task's own location and business date, never trusted as
// proof of authorization.
export interface OperationsTaskActionRequest {
  locationId: string;
}

// --- Store Operations: HQ Opening Checklist configuration (6B-2) -------
// The corporate configuration view of the ONE Opening Checklist template
// that every location's daily checklist instance is created from. Served
// only from the guarded
// `/api/v1/admin/operations/opening-checklist/template*` routes
// (InternalAuthGuard + PermissionGuard + `operations.checklists.configure`,
// CORPORATE-only). There is no `locationId` anywhere here — one corporate
// standard, no per-location override.
//
// Configuration changes NEVER rewrite an already-created ChecklistInstance
// (instances snapshot every item by value at creation). They take effect
// the next time a location creates its Opening Checklist.
//
// Unlike the execution view, this view includes INACTIVE items — HQ needs
// to see and reactivate them. `id` is the opaque ChecklistTemplateItem id,
// the target for the item mutations.
export interface OpeningChecklistTemplateItemConfig {
  // Opaque ChecklistTemplateItem id.
  id: string;
  label: string;
  // Inactive items stay in configuration and can be reactivated, but are
  // left out of every newly created daily checklist.
  isActive: boolean;
  // True when this item can move further up / down within its own section.
  // Cross-section moves are not offered in 6B-2.
  canMoveUp: boolean;
  canMoveDown: boolean;
}

export interface OpeningChecklistTemplateSectionConfig {
  name: string;
  // True when this section can move further up / down in the checklist.
  canMoveUp: boolean;
  canMoveDown: boolean;
  items: OpeningChecklistTemplateItemConfig[];
}

// GET /api/v1/admin/operations/opening-checklist/template
export interface OpeningChecklistTemplateConfigResponse {
  // The template name — "Opening Checklist".
  title: string;
  // Sections in corporate display order; items within each section in
  // corporate display order. A newly created daily checklist lists its
  // ACTIVE items in exactly this order.
  sections: OpeningChecklistTemplateSectionConfig[];
}

// PATCH /api/v1/admin/operations/opening-checklist/template/items/:itemId
// At least one field must be present. `label`, when present, is trimmed and
// must be non-empty. Toggling `isActive` never touches an existing
// instance.
export interface UpdateOpeningChecklistTemplateItemRequest {
  label?: string;
  isActive?: boolean;
}

// POST /api/v1/admin/operations/opening-checklist/template/items
// Adds one item to the end of `section`. `section` may name an existing
// section (matched case- and whitespace-insensitively) or a new one, in
// which case the new section is appended after the existing sections. The
// new item is created Active.
export interface AddOpeningChecklistTemplateItemRequest {
  section: string;
  label: string;
}

// POST .../template/items/:itemId/move  and  .../template/sections/move
// Simple one-step reorder. Item moves are within the item's current
// section only; a move past the first / last position is rejected.
export interface MoveOpeningChecklistTemplateItemRequest {
  direction: "up" | "down";
}

export interface MoveOpeningChecklistTemplateSectionRequest {
  // The section to move, by its current name.
  section: string;
  direction: "up" | "down";
}

// POST .../template/sections/rename
// Renames one section: every template item in `from` is moved to `to`.
// `to` is trimmed and must be non-empty and must not collide (case- and
// whitespace-insensitively) with another existing section. Existing
// ChecklistInstanceItem.section values are never touched.
export interface RenameOpeningChecklistTemplateSectionRequest {
  from: string;
  to: string;
}

// --- Admin: Mocha Beans / loyalty (Milestone 7A) ---------------------
// The smallest HQ surface over the Mocha Bean ledger: find a customer,
// read their balance and the internal ledger, and manually add/deduct
// Beans. All routes are InternalAuthGuard + PermissionGuard, CORPORATE-only
// (`loyalty.view` to read, `loyalty.adjust` to adjust). This is NOT a
// general customer-management module — it only ever exposes loyalty data.

// EARN and REDEEM are automatic (order-driven); MANUAL_ADJUSTMENT is an HQ
// action. REDEEM (Milestone 7C) is a negative entry for Beans spent on a
// reward.
export type MochaBeanLedgerEntryType =
  | "EARN"
  | "MANUAL_ADJUSTMENT"
  | "REDEEM"
  | "BONUS_EARN";

// One row of the internal Mocha Bean ledger, projected for HQ. `amount` is
// signed whole Beans. `actorLabel` is the HQ operator's name/email for a
// MANUAL_ADJUSTMENT, null for an automatic EARN / REDEEM. `orderNumber` is
// the human order reference for an EARN or REDEEM, null for a manual
// adjustment.
export interface AdminMochaBeanLedgerEntry {
  id: string;
  type: MochaBeanLedgerEntryType;
  amount: number;
  reason: string | null;
  orderNumber: string | null;
  actorLabel: string | null;
  createdAt: string;
}

// A customer as it appears on the HQ loyalty surface — identity plus the
// current materialized balance. `balance` is 0 for a customer who has
// never earned or been adjusted (no ledger account yet).
export interface AdminLoyaltyCustomer {
  id: string;
  email: string | null;
  displayName: string | null;
  status: CustomerAccountStatus;
  balance: number;
}

// GET /api/v1/admin/loyalty/customers?query=<email or customer id>
// A deliberately narrow lookup: an exact (case-insensitive) email match or
// an exact customer-id match. No fuzzy search, no listing-all.
export interface AdminLoyaltyCustomerSearchResponse {
  customers: AdminLoyaltyCustomer[];
}

// GET /api/v1/admin/loyalty/customers/:customerId
export interface AdminLoyaltyCustomerDetail {
  customer: AdminLoyaltyCustomer;
  entries: AdminMochaBeanLedgerEntry[];
}

// POST /api/v1/admin/loyalty/customers/:customerId/adjustments
// `deltaBeans` is a non-zero whole integer (positive to add, negative to
// deduct). `reason` is required, trimmed, non-empty. `operationKey` is a
// caller-supplied idempotency key (8-200 chars) — retrying the same key
// never applies the adjustment twice. The resulting balance may never go
// below zero.
export interface AdminAdjustMochaBeansRequest {
  deltaBeans: number;
  reason: string;
  operationKey: string;
}

// --- Admin: Gift Card Foundation & Administration (Milestone 7F) ------
// The HQ gift-card surface. All routes are InternalAuthGuard +
// PermissionGuard, CORPORATE-only:
//   giftcards.view      — POST /search, GET /:id
//   giftcards.manage    — POST / (issue), POST /:id/deactivate,
//                         POST /:id/reactivate, POST /:id/corrections
//   giftcards.configure — GET /configuration, PUT /configuration
// This is NOT customer purchasing or checkout redemption — see the schema
// comment on GiftCard. The full gift-card code is returned exactly once, in
// the issuance response; every other projection exposes only a masked code
// and the last 4 characters. The full code never appears in a URL, query
// string, audit record or log.

// The approved monetary ceiling for a gift card's value / balance and for
// any single preset purchase amount, in integer minor units ($2,000.00).
export const GIFT_CARD_MAX_VALUE_MINOR_UNITS = 200_000;

export type GiftCardStatus = "ACTIVE" | "INACTIVE";

// 7F writes ISSUANCE / ADJUSTMENT; Milestone 7G adds REDEMPTION (value spent
// as tender on a successful order). REFUND is still added by the slice that
// implements it.
export type GiftCardTransactionType =
  | "ISSUANCE"
  | "ADJUSTMENT"
  | "REDEMPTION";

// A gift card as it appears on the HQ surface. `maskedCode` is the only
// code representation in a normal read (e.g. "•••• •••• •••• 4821");
// `last4` is provided for compact display. The full code and the codeHash
// are never present.
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

// One row of the immutable gift-card transaction ledger, projected for HQ.
// `amountMinorUnits` is signed; `balanceAfterMinorUnits` is the card
// balance immediately after the entry. `actorLabel` is the HQ operator's
// name/email (present for ISSUANCE and ADJUSTMENT, null for a customer
// REDEMPTION); `reason` is the operator's required text for an ADJUSTMENT
// (null for ISSUANCE / REDEMPTION). `orderNumber` is the human order
// reference for a Milestone 7G REDEMPTION (null otherwise).
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

// POST /api/v1/admin/gift-cards/search — the code (or id) is submitted in
// the BODY, never the URL. Exact match only: no search-by-last-4 in V1.
// Exactly one of `code` / `giftCardId` should be provided.
export interface GiftCardSearchRequest {
  code?: string;
  giftCardId?: string;
}

export interface AdminGiftCardSearchResponse {
  giftCards: AdminGiftCard[];
}

// GET /api/v1/admin/gift-cards/:giftCardId
export interface AdminGiftCardDetail {
  giftCard: AdminGiftCard;
  transactions: AdminGiftCardTransaction[];
}

// POST /api/v1/admin/gift-cards — issue a gift card for a legitimate HQ
// administrative reason. `originalValueMinorUnits` is a whole integer,
// 1..GIFT_CARD_MAX_VALUE_MINOR_UNITS. `currency` is optional and must be
// "USD" in V1.
export interface IssueGiftCardRequest {
  originalValueMinorUnits: number;
  currency?: string;
}

// The ONLY response that carries the full plaintext gift-card code. It is
// shown once and is never retrievable again through any read.
export interface IssueGiftCardResponse {
  giftCard: AdminGiftCard;
  code: string;
}

// POST /api/v1/admin/gift-cards/:giftCardId/{deactivate,reactivate}
// `reason` is optional context recorded on the audit event.
export interface GiftCardStatusChangeRequest {
  reason?: string;
}

// POST /api/v1/admin/gift-cards/:giftCardId/corrections — an authorized
// manual balance correction. `deltaMinorUnits` is a non-zero whole integer
// (positive to add, negative to deduct). `reason` is required, trimmed,
// non-empty. `operationKey` is a caller-supplied idempotency key
// (8-200 chars) — retrying the same key never applies the correction twice.
// The resulting balance may never fall below 0 or exceed
// GIFT_CARD_MAX_VALUE_MINOR_UNITS. A correction is permitted on an INACTIVE
// card (an accounting fix is not blocked by status).
export interface AdjustGiftCardBalanceRequest {
  deltaMinorUnits: number;
  reason: string;
  operationKey: string;
}

// GET/PUT /api/v1/admin/gift-cards/configuration (`giftcards.configure`,
// CORPORATE-only). The company-wide gift-card purchasing configuration,
// persisted for the FUTURE customer-purchasing slice — nothing in 7F
// consumes it. `presetAmountsMinorUnits` are ascending, de-duplicated
// whole integers, each 1..GIFT_CARD_MAX_VALUE_MINOR_UNITS (1-12 entries).
export interface GiftCardConfiguration {
  presetAmountsMinorUnits: number[];
  customAmountEnabled: boolean;
}

export interface UpdateGiftCardConfigurationRequest {
  presetAmountsMinorUnits: number[];
  customAmountEnabled: boolean;
}

// --- Milestone 7H: Customer Digital Gift Card Purchase & Balance Lookup ---
// Public customer surface. Purchase (POST, OptionalCustomerAuthGuard — guests
// allowed) and balance lookup (POST, no auth). The plaintext gift-card code
// is only ever sent in a request body and only ever returned in the
// immediate purchase response or an idempotent replay within the 7-day
// recovery window — never in a URL, redirect, log, audit, or the balance
// response.

// Fixed custom-amount bounds for a customer purchase (7H — not
// HQ-configurable in V1). A preset may exceed the custom max as long as it
// is <= GIFT_CARD_MAX_VALUE_MINOR_UNITS.
export const GIFT_CARD_CUSTOM_MIN_MINOR_UNITS = 500; // $5.00
export const GIFT_CARD_CUSTOM_MAX_MINOR_UNITS = 50_000; // $500.00

// GET /api/v1/gift-cards/purchase-options (public). What the purchase page
// needs and nothing else.
export interface GiftCardPurchaseOptions {
  presetAmountsMinorUnits: number[];
  customAmountEnabled: boolean;
  customAmountMinMinorUnits: number;
  customAmountMaxMinorUnits: number;
  currency: string;
}

// The customer purchase is a bounded TWO-STEP protocol so that a
// server-generated recovery credential can reach a guest buyer BEFORE any
// charge (step 1), which is what makes a lost step-2 response recoverable.
// There is ONE persisted aggregate (GiftCardPurchase, status PENDING after
// step 1). Step 1 does not charge and does not issue.

// STEP 1 — POST /api/v1/gift-cards/purchase-intents
// `idempotencyKey` is the payment-idempotency anchor — a fresh
// crypto.randomUUID() per purchase. `amountMinorUnits` must match an HQ
// preset, or be within [GIFT_CARD_CUSTOM_MIN, GIFT_CARD_CUSTOM_MAX] when
// custom amounts are enabled (validated against the CURRENT configuration —
// step 1 only). `purchaserEmail` is the BUYER's own contact (support /
// future receipt) — NOT a recipient-delivery field.
export interface CreateGiftCardPurchaseIntentRequest {
  idempotencyKey: string;
  amountMinorUnits: number;
  purchaserEmail: string;
  purchaserName?: string | null;
}

export type GiftCardPurchaseStatus =
  | "PENDING"
  | "ISSUED"
  | "RECONCILIATION_REQUIRED";

// Step-1 response. `recoveryCredential` is the one-time, server-generated
// 256-bit secret a GUEST must retain (in memory only) and send back on
// step 2 / recovery — it is returned ONLY here and ONLY when the purchase is
// first established for a guest. `customerOwned` is true when the caller is
// authenticated and owns this purchase (no credential needed then). A
// replay of step 1 for an already-established purchase returns
// `recoveryCredential: null` (the client kept it, or must start over with a
// fresh idempotencyKey — nothing was charged).
export interface GiftCardPurchaseIntentResponse {
  purchaseId: string;
  status: GiftCardPurchaseStatus;
  amountMinorUnits: number;
  currency: string;
  customerOwned: boolean;
  recoveryCredential: string | null;
}

// STEP 2 — POST /api/v1/gift-cards/purchase
// Requires an established intent for `idempotencyKey`. It charges + issues on
// the first call and replays the confirmation (with the full code, if
// authorised and in-window) on later calls. `recoveryCredential` is REQUIRED
// for a guest purchase (both the charging call and every recovery replay);
// it is ignored for a signed-in owner. Step 2 never changes the amount,
// contact, or ownership established by step 1.
export interface PurchaseGiftCardRequest {
  idempotencyKey: string;
  recoveryCredential?: string | null;
}

// The purchase confirmation. `code` (the full plaintext, grouped display
// form) is present ONLY on the initial successful issuance and on an
// authorized idempotent replay before `codeRetrievableUntil`. After that it
// is null and `codeRetrievable` is false — the card still exists and its
// balance can be checked with the code if the buyer saved it.
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

// POST /api/v1/gift-cards/balance (public). The code is in the BODY only.
export interface GiftCardBalanceRequest {
  code: string;
}

export type GiftCardPublicStatus = "active" | "inactive" | "depleted";

// A malformed code and an unknown code return the SAME shape ({ found:
// false }) — no enumeration signal. On a hit, only masked identity + the
// balance/status — never codeHash, the full code, the internal id, the
// original value, any ledger, or any purchase/customer/HQ information.
export interface GiftCardBalanceResponse {
  found: boolean;
  maskedCode?: string;
  last4?: string;
  balanceMinorUnits?: number;
  currency?: string;
  status?: GiftCardPublicStatus;
}

// --- Milestone 8A: HQ CRM foundation --------------------------------
// The HQ/Admin read-only view OVER the authoritative customer information
// that already lives in the platform (Milestone 4 identity/profile/prefs +
// Milestone 7 loyalty/gift-cards + orders). Nothing here is a new customer
// system: every field is projected from an existing domain service and no
// business data is copied into CRM-specific storage. `customers.view` gates
// the whole surface; `customers.notes.manage` gates adding a note. Both are
// CORPORATE-only. All endpoints are under /api/v1/admin/customers.

// One row of the Admin customer directory / the header of the detail page.
// Email verification is a boolean derived from the Customer's
// emailVerifiedAt — the timestamp itself is never exposed.
export interface AdminCustomerSummary {
  id: string;
  email: string | null;
  displayName: string | null;
  status: CustomerAccountStatus;
  emailVerified: boolean;
  marketingEmailOptIn: boolean;
  createdAt: string;
}

// GET /api/v1/admin/customers?q=&cursor= — cursor-paginated, createdAt
// descending. `nextCursor` is null on the last page; pass it back as
// `cursor` for the next page. `q` (optional) matches a case-insensitive
// email OR displayName substring, or an exact customer id.
export interface AdminCustomerListResponse {
  customers: AdminCustomerSummary[];
  nextCursor: string | null;
}

// A gift card this customer BOUGHT while signed in — masked identity only.
export interface AdminCustomerGiftCardPurchase {
  purchaseId: string;
  status: GiftCardPurchaseStatus;
  amountMinorUnits: number;
  currency: string;
  maskedCode: string | null;
  last4: string | null;
  createdAt: string;
}

// A gift card redeemed as tender on one of this customer's orders — the
// immutable OrderGiftCardRedemption snapshot, masked.
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

// One entry of the customer's HQ activity timeline — projected from the
// polymorphic InternalAuditEvent rows whose targetType is 'customer' (Bean
// adjustments, CRM notes). `summary` is a rendered human sentence; the raw
// action string / target ids are never exposed.
export interface AdminCustomerActivityItem {
  id: string;
  summary: string;
  reason: string | null;
  actorLabel: string | null;
  createdAt: string;
}

// One internal CRM note. Append-only in 8A — there is no edit or delete.
export interface CustomerNote {
  id: string;
  body: string;
  authorLabel: string | null;
  createdAt: string;
}

// POST /api/v1/admin/customers/:customerId/notes
export interface CreateCustomerNoteRequest {
  body: string;
}

export const CUSTOMER_NOTE_MAX_LENGTH = 2000;

// GET /api/v1/admin/customers/:customerId — the aggregated CRM view. Every
// section is a projection of an existing authoritative source; an absent
// section (no orders, no loyalty account, …) is an empty value, not an
// error.
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

// --- Milestone 8B: Careers / Job Openings ---------------------------
// HQ manages job openings (Admin → Careers); the public site lists and
// shows PUBLISHED ones (Careers → Job Openings → detail). Applicant
// submission and applicant management are Milestone 8C — NOT here.

export type JobOpeningStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

export type JobEmploymentType =
  | "FULL_TIME"
  | "PART_TIME"
  | "TEMPORARY"
  | "SEASONAL";

// A job opening's location. `null` locationId means a corporate / HQ role.
export interface JobOpeningLocationRef {
  id: string;
  name: string;
}

// The full Admin view of a job opening (all statuses).
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

// GET /api/v1/admin/careers/jobs?status= (careers.view)
export interface AdminJobOpeningsResponse {
  jobs: AdminJobOpening[];
}

// GET /api/v1/admin/careers/jobs/options (careers.view) — form inputs.
export interface AdminJobOpeningOptions {
  locations: JobOpeningLocationRef[];
  employmentTypes: JobEmploymentType[];
}

// POST /api/v1/admin/careers/jobs (careers.manage). Creates a DRAFT.
// `locationId` null / omitted => a corporate / HQ role.
export interface CreateJobOpeningRequest {
  title: string;
  employmentType: JobEmploymentType;
  locationId?: string | null;
  summary: string;
  description: string;
  responsibilities: string;
  qualifications: string;
}

// PATCH /api/v1/admin/careers/jobs/:jobId (careers.manage). Every field is
// optional; `status` / `publishedAt` are NOT accepted here — status changes
// only through the explicit publish / unpublish / archive actions.
export interface UpdateJobOpeningRequest {
  title?: string;
  employmentType?: JobEmploymentType;
  locationId?: string | null;
  summary?: string;
  description?: string;
  responsibilities?: string;
  qualifications?: string;
}

// Reasonable length limits (consistent with promotions / CRM conventions).
export const JOB_OPENING_TITLE_MAX_LENGTH = 160;
export const JOB_OPENING_SUMMARY_MAX_LENGTH = 400;
export const JOB_OPENING_LONG_TEXT_MAX_LENGTH = 8000;

// The public projection — only ever built for a publicly-visible job
// (PUBLISHED and either corporate or an active location).
export interface PublicJobOpeningSummary {
  id: string;
  title: string;
  employmentType: JobEmploymentType;
  locationName: string | null; // null => "Corporate"
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

// --- Milestone 8C: Applicants -------------------------------------
// A visitor applies to a currently-visible published job (no account).
// HQ views applicants, moves an application through a tiny status set, and
// adds internal notes. NOT a full ATS: no interviews / offers / onboarding
// / applicant login / email automation / file upload.

export type JobApplicationStatus =
  | "NEW"
  | "REVIEWING"
  | "CONTACTED"
  | "HIRED"
  | "REJECTED";

export const JOB_APPLICATION_STATUSES: readonly JobApplicationStatus[] = [
  "NEW",
  "REVIEWING",
  "CONTACTED",
  "HIRED",
  "REJECTED",
];

// Bounded lengths, consistent with promotions / CRM conventions.
export const JOB_APPLICATION_NAME_MAX_LENGTH = 120;
export const JOB_APPLICATION_SHORT_MAX_LENGTH = 200;
export const JOB_APPLICATION_MESSAGE_MAX_LENGTH = 4000;
export const JOB_APPLICATION_URL_MAX_LENGTH = 2048;
export const JOB_APPLICATION_NOTE_MAX_LENGTH = 2000;

// POST /api/v1/careers/jobs/:jobId/applications (public, no auth). Returns
// ONLY { ok: true } — never an id or the stored record.
export interface SubmitJobApplicationRequest {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string; // "City, State"
  workAuthorized: boolean;
  availability: string;
  message: string;
  // "Resume / LinkedIn / Portfolio Link (optional)" — one http(s) URL.
  resumeUrl?: string | null;
}

export interface SubmitJobApplicationResponse {
  ok: true;
}

// One row of the Admin applicants list.
export interface AdminJobApplicationSummary {
  id: string;
  applicantName: string;
  email: string;
  jobOpeningId: string;
  jobTitleSnapshot: string;
  status: JobApplicationStatus;
  createdAt: string;
}

// GET /api/v1/admin/careers/applications?status=&jobOpeningId=&cursor=
// (applicants.view) — cursor-paginated, newest first.
export interface AdminJobApplicationsResponse {
  applications: AdminJobApplicationSummary[];
  nextCursor: string | null;
}

// GET /api/v1/admin/careers/applications/:id (applicants.view).
export interface AdminJobApplicationDetail {
  id: string;
  status: JobApplicationStatus;
  jobOpeningId: string;
  jobTitleSnapshot: string;
  // The job's current status, so HQ can tell if the opening is still live.
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

// POST /api/v1/admin/careers/applications/:id/status (applicants.manage).
export interface UpdateJobApplicationStatusRequest {
  status: JobApplicationStatus;
}

// One internal applicant note. Append-only in 8C.
export interface JobApplicationNote {
  id: string;
  body: string;
  authorLabel: string | null;
  createdAt: string;
}

// POST /api/v1/admin/careers/applications/:id/notes (applicants.manage).
export interface CreateJobApplicationNoteRequest {
  body: string;
}

// One entry of the applicant activity timeline (from InternalAuditEvent,
// targetType 'job_application'). No answer data / PII.
export interface AdminJobApplicationActivityItem {
  id: string;
  summary: string;
  actorLabel: string | null;
  createdAt: string;
}

// --- Milestone 8D, Franchising inquiries -----------------------------
// A prospective franchisee's contact + interest record. One flat model, no
// separate "prospect" identity — mirrors the 8C Applicants shape. No file
// uploads, no financial documents; investmentRange / timeframe are free
// text (no invented $ or time buckets).

export type FranchiseInquiryStatus =
  | "NEW"
  | "REVIEWING"
  | "CONTACTED"
  | "QUALIFIED"
  | "CLOSED";

export const FRANCHISE_INQUIRY_STATUSES: readonly FranchiseInquiryStatus[] = [
  "NEW",
  "REVIEWING",
  "CONTACTED",
  "QUALIFIED",
  "CLOSED",
];

export const FRANCHISE_INQUIRY_NAME_MAX_LENGTH = 120;
export const FRANCHISE_INQUIRY_SHORT_MAX_LENGTH = 200;
export const FRANCHISE_INQUIRY_MESSAGE_MAX_LENGTH = 4000;
export const FRANCHISE_INQUIRY_NOTE_MAX_LENGTH = 2000;

// POST /api/v1/franchising/inquiries — no auth. Response is only
// { ok: true }; no id, no submitted data.
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

// One row of the Admin franchising inquiries list.
export interface AdminFranchiseInquirySummary {
  id: string;
  prospectName: string;
  email: string;
  preferredMarket: string;
  status: FranchiseInquiryStatus;
  createdAt: string;
}

// GET /api/v1/admin/franchising/inquiries?status=&cursor= (franchising.view)
// — cursor-paginated, newest first.
export interface AdminFranchiseInquiriesResponse {
  inquiries: AdminFranchiseInquirySummary[];
  nextCursor: string | null;
}

// GET /api/v1/admin/franchising/inquiries/:id (franchising.view).
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

// POST /api/v1/admin/franchising/inquiries/:id/status (franchising.manage).
export interface UpdateFranchiseInquiryStatusRequest {
  status: FranchiseInquiryStatus;
}

// One internal inquiry note. Append-only in 8D.
export interface FranchiseInquiryNote {
  id: string;
  body: string;
  authorLabel: string | null;
  createdAt: string;
}

// POST /api/v1/admin/franchising/inquiries/:id/notes (franchising.manage).
export interface CreateFranchiseInquiryNoteRequest {
  body: string;
}

// One entry of the inquiry activity timeline (from InternalAuditEvent,
// targetType 'franchise_inquiry'). No answer data / PII.
export interface AdminFranchiseInquiryActivityItem {
  id: string;
  summary: string;
  actorLabel: string | null;
  createdAt: string;
}

// --- Milestone 8E, CMS foundation --------------------------------------
// Structured content management for a small, code-defined set of public
// page keys — NOT a page builder. Layout/design stay owned by the Next.js
// pages/components; the CMS only supplies structured field values. Each
// page key has ONE fixed content shape (defined in the registry, mirrored
// here per key) — no arbitrary fields, no HTML, no dynamic sections.
//
// A CmsPage row always carries a draft; `publishedContent` is a separate
// snapshot copied over only by an explicit publish action. Before the
// first publish, status is DRAFT and there is no public content. After the
// first publish, status is PUBLISHED for good (no unpublish) — further
// draft edits never affect the live `publishedContent` until the next
// publish. `hasUnpublishedChanges` is derived (true whenever draftContent
// differs from publishedContent, or nothing has been published yet).

export type CmsPageStatus = "DRAFT" | "PUBLISHED";

export const CMS_PAGE_KEYS = ["franchising", "home"] as const;
export type CmsPageKey = (typeof CMS_PAGE_KEYS)[number];

export const CMS_TEXT_MAX_LENGTH = 200;
export const CMS_BODY_MAX_LENGTH = 2000;
export const CMS_BUTTON_LABEL_MAX_LENGTH = 60;
export const CMS_SEO_TITLE_MAX_LENGTH = 70;
export const CMS_SEO_DESCRIPTION_MAX_LENGTH = 200;
export const CMS_PROCESS_STEPS_MIN = 1;
export const CMS_PROCESS_STEPS_MAX = 6;
// Milestone 8F — Home's Featured Products strip.
export const CMS_FEATURED_PRODUCTS_MAX = 8;

export interface CmsSeoFields {
  pageTitle?: string | null;
  metaDescription?: string | null;
}

// The ONE 8E content shape (page key "franchising"). Every field is plain
// text — no HTML, no arbitrary URLs (the CTA's destination stays
// code-owned by the page component).
export interface FranchisingPageContent {
  intro: { heading: string; body: string };
  opportunity: { heading: string; body: string };
  process: {
    heading: string;
    // 1..6 steps (CMS_PROCESS_STEPS_MIN..CMS_PROCESS_STEPS_MAX).
    steps: { title: string; body: string }[];
  };
  cta: { heading: string; body: string; buttonLabel: string };
  seo: CmsSeoFields;
}

// Milestone 8F — the Home page content shape (page key "home"). The hero's
// CTA destination stays code-owned (no URL field, same rule as
// Franchising's CTA). `backgroundImageId` references a MediaAsset by id —
// resolved to a URL server-side, never stored as a URL here.
// `featuredProducts.productIds` references authoritative catalog Product
// ids ONLY — no name / price / description / availability is ever
// duplicated into CMS content.
export interface HomePageContent {
  hero: {
    headline: string;
    supportingText: string;
    buttonLabel: string;
    backgroundImageId: string | null;
  };
  featuredProducts: {
    heading: string;
    // Ordered, 0..CMS_FEATURED_PRODUCTS_MAX, no duplicates.
    productIds: string[];
  };
  seo: CmsSeoFields;
}

// The content shape varies by page key — this union is narrowed by the
// caller using the known `key`.
export type CmsPageContent = FranchisingPageContent | HomePageContent;

// GET /api/v1/content/:pageKey — no auth. Published content only; 404 for
// an unknown key, a key with no row, or a key never published. Never
// exposes draft content.
export interface PublicCmsPageContentResponse {
  content: CmsPageContent;
}

// GET /api/v1/content/franchising specifically.
export interface PublicFranchisingPageContentResponse {
  content: FranchisingPageContent;
}

// GET /api/v1/content/home specifically. `hero.backgroundImageUrl` and each
// featured product are resolved server-side — the public response never
// carries a bare `backgroundImageId` or product id needing a second fetch.
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

// One row of GET /api/v1/admin/content (cms.view).
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

// GET /api/v1/admin/content/:pageKey (cms.view). When no row exists yet,
// this is synthesized from the registry default — DRAFT,
// publishedContent null, hasUnpublishedChanges true — WITHOUT writing to
// the database.
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

// PATCH /api/v1/admin/content/:pageKey (cms.manage) — save draft. The full
// content shape is required (not a partial patch); the row is
// created/upserted on first save.
export interface UpdateCmsPageContentRequest {
  content: CmsPageContent;
}

// POST /api/v1/admin/content/:pageKey/publish (cms.manage). No body.

// --- Milestone 8F, Media Library ---------------------------------------
// A minimal, HQ-only image library backing CMS content (currently Home's
// hero background). No folders, tags, cropping, or transformations — a
// flat, append-mostly list of uploaded images. Deletion is soft
// (`isActive`) and the API blocks deactivating an asset that is still
// referenced by known CMS content (see 409 behavior on the deactivate
// route) — the S3 object itself is never removed in 8F.

export const MEDIA_ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export type MediaContentType = (typeof MEDIA_ALLOWED_CONTENT_TYPES)[number];

export const MEDIA_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

// One row of GET /api/v1/admin/media (media.view). `publicUrl` is resolved
// server-side from the configured MediaStorage — the object key itself is
// not exposed.
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

// POST /api/v1/admin/media (media.manage) — multipart/form-data, field
// "file". No JSON request type; the response is the created asset.
export interface UploadMediaAssetResponse {
  asset: AdminMediaAsset;
}

// POST /api/v1/admin/media/:mediaAssetId/deactivate (media.manage). 409
// (not 200) when the asset is still referenced by known CMS content
// (draft or published) — the deactivation is refused, not applied.
export interface DeactivateMediaAssetResponse {
  asset: AdminMediaAsset;
}
