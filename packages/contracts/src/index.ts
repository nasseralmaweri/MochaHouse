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
  subtotal: number;
  currency: string;
}

export interface CustomerOrderDetail extends CustomerOrderSummary {
  lines: OrderLineSummary[];
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
};