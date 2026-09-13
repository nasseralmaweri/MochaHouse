import type {
  AdminAdjustMochaBeansRequest,
  AdminCampaign,
  CreateCampaignRequest,
  UpdateCampaignRequest,
  UpdateCampaignStatusRequest,
  AdminCmsPageDetail,
  AdminCustomerListResponse,
  AdminMediaAsset,
  AdminMediaAssetsResponse,
  AdminFranchiseInquiriesResponse,
  AdminFranchiseInquiryDetail,
  AdminJobApplicationDetail,
  AdminJobApplicationsResponse,
  AdminJobOpening,
  CreateJobOpeningRequest,
  FranchiseInquiryNote,
  FranchiseInquiryStatus,
  CmsPageContent,
  JobApplicationNote,
  JobApplicationStatus,
  SubmitFranchiseInquiryRequest,
  UpdateJobOpeningRequest,
  AdminGiftCardDetail,
  AdminGiftCardSearchResponse,
  AdjustGiftCardBalanceRequest,
  CustomerNote,
  GiftCardConfiguration,
  GiftCardSearchRequest,
  IssueGiftCardRequest,
  IssueGiftCardResponse,
  UpdateGiftCardConfigurationRequest,
  AdminAssignInternalUserRoleRequest,
  AdminInternalUserDetail,
  AdminLocationDetail,
  AdminLoyaltyBonusPromotion,
  AdminLoyaltyCustomerDetail,
  AdminLoyaltyReward,
  AdminProductDetail,
  AdminPromotion,
  CreateLoyaltyBonusPromotionRequest,
  CreateLoyaltyRewardRequest,
  CreatePromotionRequest,
  LoyaltySettings,
  UpdateLoyaltyBonusPromotionRequest,
  UpdateLoyaltyRewardRequest,
  UpdatePromotionRequest,
  UpdateLoyaltySettingsRequest,
  AdminUpdateInternalUserStatusRequest,
  AdminUpdateLocationRequest,
  AdminUpdateProductRequest,
  AdvanceOrderStatusResponse,
  CheckoutQuoteRequest,
  CheckoutQuoteResponse,
  CheckoutRequest,
  CheckoutRewardEligibilityRequest,
  CheckoutRewardEligibilityResponse,
  LocationMenuResponse,
  LocationSummary,
  OpeningChecklistResponse,
  OpeningChecklistTemplateConfigResponse,
  OperationsTasksResponse,
  OrderConfirmation,
  OrderStatus,
  OrderStatusResponse,
  StoreOrderDetail,
  StoreOrderSummary,
} from "@mocha-house/contracts";
import { parseLocationMenuResponse } from "@/lib/menu";

// Browser-safe counterpart to lib/api.ts's getLocationMenu. The cart lives
// in localStorage (browser-only), so /order/cart must revalidate it
// directly from the client — Server Components can't read localStorage.
// This is the one ordering screen with a genuine client-side fetch need;
// every other screen fetches server-side via lib/api.ts's server-only
// API_URL. See apps/web/.env.example.
function getPublicApiUrl(): string {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;

  if (!apiUrl) {
    throw new Error(
      "NEXT_PUBLIC_API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }

  return apiUrl;
}

export async function getLocationMenuFromBrowser(
  locationId: string,
): Promise<LocationMenuResponse | null> {
  const response = await fetch(
    `${getPublicApiUrl()}/locations/${locationId}/menu`,
  );

  if (!response.ok) {
    throw new Error(`Failed to load location menu (${response.status}).`);
  }

  return parseLocationMenuResponse(response);
}

// Checkout is a client-side fetch for the same reason cart revalidation is:
// there is no server-rendered step between "review cart" and "submit" that
// could carry a server action, and the cart itself only exists in
// localStorage. It posts to this app's own /api/checkout route (not the
// backend directly) — that route runs server-side and can read the
// customer's httpOnly session cookie to attach it as a bearer token,
// something this client-side code structurally cannot do. See
// app/api/checkout/route.ts.
export type CheckoutResult =
  | { outcome: "success"; confirmation: OrderConfirmation }
  | { outcome: "declined" | "failed"; message: string }
  | { outcome: "invalid"; message: string }
  | { outcome: "conflict"; message: string }
  | { outcome: "network-error"; message: string };

// Milestone 7C — the checkout reward-eligibility quote. Goes through this
// app's own /api/loyalty/checkout-rewards route (server-side, reads the
// httpOnly session cookie). A signed-out visitor always gets an empty list
// — this never throws and never blocks checkout.
export async function getCheckoutRewardsFromBrowser(
  input: CheckoutRewardEligibilityRequest,
): Promise<CheckoutRewardEligibilityResponse> {
  try {
    const response = await fetch("/api/loyalty/checkout-rewards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      return { balance: 0, rewards: [] };
    }
    return (await response.json()) as CheckoutRewardEligibilityResponse;
  } catch {
    return { balance: 0, rewards: [] };
  }
}

// Milestone 7E — the unified server-authoritative checkout pricing quote
// (regular Promotion/Coupon + Mocha Bean rewards + total). Goes through this
// app's own /api/orders/checkout-quote route (server-side, attaches the
// httpOnly session cookie when present; guests allowed). Never throws — a
// failure returns a subtotal-only quote so checkout still works.
export async function getCheckoutQuoteFromBrowser(
  input: CheckoutQuoteRequest,
): Promise<CheckoutQuoteResponse | null> {
  try {
    const response = await fetch("/api/orders/checkout-quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as CheckoutQuoteResponse;
  } catch {
    return null;
  }
}

export async function submitCheckoutFromBrowser(
  request: CheckoutRequest,
): Promise<CheckoutResult> {
  let response: Response;
  try {
    response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    return {
      outcome: "network-error",
      message: "Could not reach the server. Check your connection and try again.",
    };
  }

  if (response.status === 402) {
    const body = await safeJson(response);
    return {
      outcome: body?.outcome === "failed" ? "failed" : "declined",
      message: body?.message ?? "Payment was not successful.",
    };
  }

  if (response.status === 409) {
    const body = await safeJson(response);
    return {
      outcome: "conflict",
      message: body?.message ?? "This order is already being processed.",
    };
  }

  if (response.status === 400 || response.status === 404) {
    const body = await safeJson(response);
    return {
      outcome: "invalid",
      message: body?.message ?? "Your cart could not be placed. Please review it.",
    };
  }

  if (!response.ok) {
    return {
      outcome: "network-error",
      message: `Something went wrong (${response.status}). Please try again.`,
    };
  }

  return { outcome: "success", confirmation: (await response.json()) as OrderConfirmation };
}

export async function getOrderStatusFromBrowser(
  orderId: string,
  accessToken: string,
): Promise<OrderStatusResponse | null> {
  const response = await fetch(
    `${getPublicApiUrl()}/orders/${orderId}?accessToken=${encodeURIComponent(accessToken)}`,
  );

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to load order status (${response.status}).`);
  }

  return response.json() as Promise<OrderStatusResponse>;
}

async function safeJson(response: Response): Promise<{ outcome?: string; message?: string } | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// --- Admin store queue (INTERNAL — InternalAuthGuard + PermissionGuard)
// These calls run in the browser and go through this app's server-side
// proxy (/api/internal/admin/*, see app/api/internal/admin/[...path]/route.ts):
// the proxy reads the HttpOnly mh_internal_session cookie and forwards it
// as the internal Bearer token, which client-side JS can never see.
//
// Failure modes are kept distinct (Milestone 5C):
//   401 -> the internal session is gone; bounce to the internal sign-in
//          page (a full navigation, so the server /admin boundary re-runs).
//   403 -> a permission/scope limit; surfaced as { outcome: "forbidden" }
//          so the page can render AdminForbidden (NOT a login prompt).
//   404 -> resource-not-found.
//   5xx / network -> recoverable error.
//
// The authorization-aware location list is NOT fetched here any more — the
// Admin shell gets it from GET /internal/me (see lib/internal-auth/session).

const INTERNAL_ADMIN_PROXY = "/api/internal/admin";

function redirectToInternalSignIn(): void {
  if (typeof window !== "undefined") {
    // A full-document navigation is intentional: the internal session has
    // expired, so the browser should drop all client state and re-run the
    // server-side /admin auth boundary from scratch.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/internal/sign-in";
  }
}

export type StoreOrdersResult =
  | { outcome: "success"; orders: StoreOrderSummary[] }
  | { outcome: "forbidden" }
  | { outcome: "error" };

export async function getActiveStoreOrdersFromBrowser(
  locationId: string,
): Promise<StoreOrdersResult> {
  let response: Response;
  try {
    response = await fetch(
      `${INTERNAL_ADMIN_PROXY}/orders?locationId=${encodeURIComponent(locationId)}`,
    );
  } catch {
    return { outcome: "error" };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return { outcome: "error" };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }
  return {
    outcome: "success",
    orders: (await response.json()) as StoreOrderSummary[],
  };
}

export type StoreOrderDetailResult =
  | { outcome: "success"; order: StoreOrderDetail }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "error" };

export async function getStoreOrderDetailFromBrowser(
  orderId: string,
  locationId: string,
): Promise<StoreOrderDetailResult> {
  let response: Response;
  try {
    response = await fetch(
      `${INTERNAL_ADMIN_PROXY}/orders/${orderId}?locationId=${encodeURIComponent(locationId)}`,
    );
  } catch {
    return { outcome: "error" };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return { outcome: "error" };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }
  return {
    outcome: "success",
    order: (await response.json()) as StoreOrderDetail,
  };
}

export type AdvanceResult =
  | { outcome: "success"; result: AdvanceOrderStatusResponse }
  | { outcome: "conflict"; message: string }
  | { outcome: "forbidden" }
  | { outcome: "error"; message: string };

export async function advanceStoreOrderStatusFromBrowser(
  orderId: string,
  locationId: string,
  expectedStatus: OrderStatus,
): Promise<AdvanceResult> {
  let response: Response;
  try {
    response = await fetch(`${INTERNAL_ADMIN_PROXY}/orders/${orderId}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locationId, expectedStatus }),
    });
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }

  if (response.status === 401) {
    redirectToInternalSignIn();
    return {
      outcome: "error",
      message: "Your internal session has expired. Sign in again.",
    };
  }

  if (response.status === 403) {
    return { outcome: "forbidden" };
  }

  if (response.status === 409) {
    const body = await safeJson(response);
    return {
      outcome: "conflict",
      message: body?.message ?? "Order status changed. Refresh and try again.",
    };
  }

  if (!response.ok) {
    const body = await safeJson(response);
    return {
      outcome: "error",
      message: body?.message ?? `Something went wrong (${response.status}).`,
    };
  }

  return {
    outcome: "success",
    result: (await response.json()) as AdvanceOrderStatusResponse,
  };
}

// --- Admin locations: controls (Milestone 5D-2) ---------------------
// Both go through the same server-side proxy as the order-queue calls
// above, so the internal session cookie is attached server-side and never
// exposed to client JS. The API stays the sole authorization authority —
// these helpers only shape the outcome for the page.

export type UpdateLocationOrderingResult =
  | { outcome: "success"; isDigitalOrderingEnabled: boolean }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "error"; message: string };

export async function updateLocationDigitalOrderingFromBrowser(
  locationId: string,
  isDigitalOrderingEnabled: boolean,
): Promise<UpdateLocationOrderingResult> {
  let response: Response;
  try {
    response = await fetch(
      `${INTERNAL_ADMIN_PROXY}/locations/${encodeURIComponent(locationId)}/digital-ordering`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isDigitalOrderingEnabled }),
      },
    );
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }

  if (response.status === 401) {
    redirectToInternalSignIn();
    return {
      outcome: "error",
      message: "Your internal session has expired. Sign in again.",
    };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (!response.ok) {
    const body = await safeJson(response);
    return {
      outcome: "error",
      message: body?.message ?? `Something went wrong (${response.status}).`,
    };
  }

  const location = (await response.json()) as LocationSummary;
  return {
    outcome: "success",
    isDigitalOrderingEnabled: location.isDigitalOrderingEnabled,
  };
}

export type UpdateLocationResult =
  | { outcome: "success"; location: AdminLocationDetail }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "invalid"; message: string }
  | { outcome: "error"; message: string };

export async function updateLocationFromBrowser(
  locationId: string,
  input: AdminUpdateLocationRequest,
): Promise<UpdateLocationResult> {
  let response: Response;
  try {
    response = await fetch(
      `${INTERNAL_ADMIN_PROXY}/locations/${encodeURIComponent(locationId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }

  if (response.status === 401) {
    redirectToInternalSignIn();
    return {
      outcome: "error",
      message: "Your internal session has expired. Sign in again.",
    };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    const body = await safeJson(response);
    return {
      outcome: "invalid",
      message: body?.message ?? "Please check the form and try again.",
    };
  }
  if (!response.ok) {
    const body = await safeJson(response);
    return {
      outcome: "error",
      message: body?.message ?? `Something went wrong (${response.status}).`,
    };
  }

  return {
    outcome: "success",
    location: (await response.json()) as AdminLocationDetail,
  };
}

// --- Admin catalog: product edit (Milestone 5D-3) ------------------
// Goes through the same server-side proxy; the API (`catalog.products.edit`,
// CORPORATE-only) remains the authority. The caller sends dollars-parsed
// integer cents for basePrice (or null to clear it).

export type UpdateProductResult =
  | { outcome: "success"; product: AdminProductDetail }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "invalid"; message: string }
  | { outcome: "error"; message: string };

export async function updateProductFromBrowser(
  productId: string,
  input: AdminUpdateProductRequest,
): Promise<UpdateProductResult> {
  let response: Response;
  try {
    response = await fetch(
      `${INTERNAL_ADMIN_PROXY}/catalog/products/${encodeURIComponent(productId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }

  if (response.status === 401) {
    redirectToInternalSignIn();
    return {
      outcome: "error",
      message: "Your internal session has expired. Sign in again.",
    };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    const body = await safeJson(response);
    return {
      outcome: "invalid",
      message: body?.message ?? "Please check the form and try again.",
    };
  }
  if (!response.ok) {
    const body = await safeJson(response);
    return {
      outcome: "error",
      message: body?.message ?? `Something went wrong (${response.status}).`,
    };
  }

  return {
    outcome: "success",
    product: (await response.json()) as AdminProductDetail,
  };
}

// --- Admin menu composition + location price / availability (5D-4) -
// These all reuse EXISTING backend routes and return nothing meaningful on
// success (the page re-reads afterwards). One shared helper keeps the six
// thin wrappers honest about the failure modes.

export type AdminMutationResult =
  | { outcome: "success" }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "invalid"; message: string }
  | { outcome: "error"; message: string };

async function adminProxyMutate(
  path: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: unknown,
): Promise<AdminMutationResult> {
  let response: Response;
  try {
    response = await fetch(`${INTERNAL_ADMIN_PROXY}${path}`, {
      method,
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }

  if (response.status === 401) {
    redirectToInternalSignIn();
    return {
      outcome: "error",
      message: "Your internal session has expired. Sign in again.",
    };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    const parsed = await safeJson(response);
    return {
      outcome: "invalid",
      message: parsed?.message ?? "Please check the value and try again.",
    };
  }
  if (!response.ok) {
    const parsed = await safeJson(response);
    return {
      outcome: "error",
      message: parsed?.message ?? `Something went wrong (${response.status}).`,
    };
  }
  return { outcome: "success" };
}

function overridePath(
  locationId: string,
  menuId: string,
  productId: string,
  kind: "price-override" | "availability-override",
): string {
  return `/catalog/locations/${encodeURIComponent(locationId)}/menus/${encodeURIComponent(
    menuId,
  )}/products/${encodeURIComponent(productId)}/${kind}`;
}

// Turn a product's placement on a menu on / off (MenuProduct — surfaced as
// "Shown on menu").
export function setMenuProductShownFromBrowser(
  menuId: string,
  productId: string,
  shownOnMenu: boolean,
): Promise<AdminMutationResult> {
  return adminProxyMutate(
    `/catalog/menus/${encodeURIComponent(menuId)}/products/${encodeURIComponent(
      productId,
    )}/assignment`,
    "PATCH",
    { isActive: shownOnMenu },
  );
}

// Set / clear a location-specific price (integer cents).
export function setLocationPriceFromBrowser(
  locationId: string,
  menuId: string,
  productId: string,
  priceCents: number,
): Promise<AdminMutationResult> {
  return adminProxyMutate(
    overridePath(locationId, menuId, productId, "price-override"),
    "PUT",
    { price: priceCents },
  );
}

export function useStandardPriceFromBrowser(
  locationId: string,
  menuId: string,
  productId: string,
): Promise<AdminMutationResult> {
  return adminProxyMutate(
    overridePath(locationId, menuId, productId, "price-override"),
    "DELETE",
  );
}

// Set / clear a location-specific availability.
export function setLocationAvailabilityFromBrowser(
  locationId: string,
  menuId: string,
  productId: string,
  isAvailable: boolean,
): Promise<AdminMutationResult> {
  return adminProxyMutate(
    overridePath(locationId, menuId, productId, "availability-override"),
    "PUT",
    { isAvailable },
  );
}

export function useStandardAvailabilityFromBrowser(
  locationId: string,
  menuId: string,
  productId: string,
): Promise<AdminMutationResult> {
  return adminProxyMutate(
    overridePath(locationId, menuId, productId, "availability-override"),
    "DELETE",
  );
}

// --- Admin: internal user status (Milestone 5E-3) -----------------
// Suspend / reactivate / disable another internal user. The API
// (`users.manage_status`, CORPORATE-only) is the authority — it enforces
// self-protection, transitions and last-administrator loss. 409 covers a
// no-op transition, a terminal (disabled) source, and last-admin
// protection; the message is business-safe and shown as-is.
export type UpdateInternalUserStatusResult =
  | { outcome: "success"; user: AdminInternalUserDetail }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "invalid"; message: string }
  | { outcome: "conflict"; message: string }
  | { outcome: "error"; message: string };

export async function updateInternalUserStatusFromBrowser(
  internalUserId: string,
  input: AdminUpdateInternalUserStatusRequest,
): Promise<UpdateInternalUserStatusResult> {
  let response: Response;
  try {
    response = await fetch(
      `${INTERNAL_ADMIN_PROXY}/internal-users/${encodeURIComponent(internalUserId)}/status`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }

  if (response.status === 401) {
    redirectToInternalSignIn();
    return {
      outcome: "error",
      message: "Your internal session has expired. Sign in again.",
    };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    const body = await safeJson(response);
    return {
      outcome: "invalid",
      message: body?.message ?? "That status change isn’t allowed.",
    };
  }
  if (response.status === 409) {
    const body = await safeJson(response);
    return {
      outcome: "conflict",
      message: body?.message ?? "That status change isn’t possible right now.",
    };
  }
  if (!response.ok) {
    const body = await safeJson(response);
    return {
      outcome: "error",
      message: body?.message ?? `Something went wrong (${response.status}).`,
    };
  }

  return {
    outcome: "success",
    user: (await response.json()) as AdminInternalUserDetail,
  };
}

// --- Admin: access level + location assignment (Milestone 5E-4) ---
// Grant / remove a person's access. The API (`users.manage_roles`,
// CORPORATE-only) is the authority — it enforces self-protection, the
// privilege ceiling, assignment policy and last-administrator protection.
// 409 covers a duplicate grant and last-administrator protection; its
// message is business-safe and shown as-is. Both return the refreshed
// AdminInternalUserDetail so the screen can update in place.
export type InternalUserAccessMutationResult =
  | { outcome: "success"; user: AdminInternalUserDetail }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "invalid"; message: string }
  | { outcome: "conflict"; message: string }
  | { outcome: "error"; message: string };

async function internalUserAccessMutate(
  path: string,
  body: unknown,
): Promise<InternalUserAccessMutationResult> {
  let response: Response;
  try {
    response = await fetch(`${INTERNAL_ADMIN_PROXY}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }

  if (response.status === 401) {
    redirectToInternalSignIn();
    return {
      outcome: "error",
      message: "Your internal session has expired. Sign in again.",
    };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    const parsed = await safeJson(response);
    return {
      outcome: "invalid",
      message: parsed?.message ?? "Please check the form and try again.",
    };
  }
  if (response.status === 409) {
    const parsed = await safeJson(response);
    return {
      outcome: "conflict",
      message: parsed?.message ?? "That access change isn’t possible right now.",
    };
  }
  if (!response.ok) {
    const parsed = await safeJson(response);
    return {
      outcome: "error",
      message: parsed?.message ?? `Something went wrong (${response.status}).`,
    };
  }

  return {
    outcome: "success",
    user: (await response.json()) as AdminInternalUserDetail,
  };
}

export function assignInternalUserRoleFromBrowser(
  internalUserId: string,
  input: AdminAssignInternalUserRoleRequest,
): Promise<InternalUserAccessMutationResult> {
  return internalUserAccessMutate(
    `/internal-users/${encodeURIComponent(internalUserId)}/role-assignments`,
    input,
  );
}

export function removeInternalUserRoleAssignmentFromBrowser(
  internalUserId: string,
  assignmentId: string,
  reason: string,
): Promise<InternalUserAccessMutationResult> {
  return internalUserAccessMutate(
    `/internal-users/${encodeURIComponent(internalUserId)}/role-assignments/${encodeURIComponent(
      assignmentId,
    )}/remove`,
    { reason },
  );
}

// --- Store Operations: daily checklist execution (6B Opening; 6D Closing)
// All go through the same server-side proxy as the order-queue calls above
// (the internal session cookie is attached server-side, never exposed to
// client JS). The API is the sole authority — GET requires
// `operations.view`, Complete / Undo require `operations.tasks.complete`,
// Log / Clear Exception require `operations.exceptions.manage`, and every
// call is location-scoped there. Mutations return the full authoritative
// projection so the page reconciles from it. `checklist` selects the
// `/opening-checklist` or `/closing-checklist` route family.

export type ChecklistKind = "opening" | "closing";

export type ChecklistResult =
  | { outcome: "success"; checklist: OpeningChecklistResponse }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  // 400 (e.g. a blank exception reason) or 409 (e.g. completing an
  // exception-resolved item) — a business-language message the UI shows.
  | { outcome: "invalid"; message: string }
  | { outcome: "error"; message: string };

async function checklistRequest(
  path: string,
  init?: { method: "POST"; body: unknown },
): Promise<ChecklistResult> {
  let response: Response;
  try {
    response = await fetch(`${INTERNAL_ADMIN_PROXY}${path}`, {
      method: init?.method ?? "GET",
      headers: init ? { "Content-Type": "application/json" } : undefined,
      body: init ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }

  if (response.status === 401) {
    redirectToInternalSignIn();
    return {
      outcome: "error",
      message: "Your internal session has expired. Sign in again.",
    };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400 || response.status === 409) {
    const body = await safeJson(response);
    return {
      outcome: "invalid",
      message: body?.message ?? "That change isn't valid right now.",
    };
  }
  if (!response.ok) {
    const body = await safeJson(response);
    return {
      outcome: "error",
      message: body?.message ?? `Something went wrong (${response.status}).`,
    };
  }

  return {
    outcome: "success",
    checklist: (await response.json()) as OpeningChecklistResponse,
  };
}

const checklistBase = (checklist: ChecklistKind) =>
  `/operations/${checklist}-checklist`;

export function getChecklistFromBrowser(
  checklist: ChecklistKind,
  locationId: string,
): Promise<ChecklistResult> {
  return checklistRequest(
    `${checklistBase(checklist)}?locationId=${encodeURIComponent(locationId)}`,
  );
}

export function completeChecklistItemFromBrowser(
  checklist: ChecklistKind,
  instanceItemId: string,
  locationId: string,
): Promise<ChecklistResult> {
  return checklistRequest(
    `${checklistBase(checklist)}/items/${encodeURIComponent(
      instanceItemId,
    )}/complete`,
    { method: "POST", body: { locationId } },
  );
}

export function undoChecklistItemFromBrowser(
  checklist: ChecklistKind,
  instanceItemId: string,
  locationId: string,
): Promise<ChecklistResult> {
  return checklistRequest(
    `${checklistBase(checklist)}/items/${encodeURIComponent(
      instanceItemId,
    )}/undo`,
    { method: "POST", body: { locationId } },
  );
}

// Management Exception (Milestone 6C) — requires `operations.exceptions.manage`
// for the location. Both return the full authoritative checklist projection.
export function logChecklistExceptionFromBrowser(
  checklist: ChecklistKind,
  instanceItemId: string,
  locationId: string,
  reason: string,
): Promise<ChecklistResult> {
  return checklistRequest(
    `${checklistBase(checklist)}/items/${encodeURIComponent(
      instanceItemId,
    )}/exception`,
    { method: "POST", body: { locationId, reason } },
  );
}

export function clearChecklistExceptionFromBrowser(
  checklist: ChecklistKind,
  instanceItemId: string,
  locationId: string,
): Promise<ChecklistResult> {
  return checklistRequest(
    `${checklistBase(checklist)}/items/${encodeURIComponent(
      instanceItemId,
    )}/exception/clear`,
    { method: "POST", body: { locationId } },
  );
}

// --- Store Operations: Today's Tasks (Milestone 6C) -----------------
// Same server-side proxy. GET requires `operations.view`; add / complete /
// reopen / delete require `operations.tasks.complete`. Every mutation
// returns the whole authoritative task list so the section reconciles.

export type OperationsTasksResult =
  | { outcome: "success"; tasks: OperationsTasksResponse }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "invalid"; message: string }
  | { outcome: "error"; message: string };

async function operationsTasksRequest(
  path: string,
  init?: { method: "POST"; body: unknown },
): Promise<OperationsTasksResult> {
  let response: Response;
  try {
    response = await fetch(`${INTERNAL_ADMIN_PROXY}${path}`, {
      method: init?.method ?? "GET",
      headers: init ? { "Content-Type": "application/json" } : undefined,
      body: init ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }

  if (response.status === 401) {
    redirectToInternalSignIn();
    return {
      outcome: "error",
      message: "Your internal session has expired. Sign in again.",
    };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    const body = await safeJson(response);
    return {
      outcome: "invalid",
      message: body?.message ?? "That task change isn't valid.",
    };
  }
  if (!response.ok) {
    const body = await safeJson(response);
    return {
      outcome: "error",
      message: body?.message ?? `Something went wrong (${response.status}).`,
    };
  }

  return {
    outcome: "success",
    tasks: (await response.json()) as OperationsTasksResponse,
  };
}

export function getOperationsTasksFromBrowser(
  locationId: string,
): Promise<OperationsTasksResult> {
  return operationsTasksRequest(
    `/operations/tasks?locationId=${encodeURIComponent(locationId)}`,
  );
}

export function createOperationsTaskFromBrowser(input: {
  locationId: string;
  title: string;
  note?: string;
}): Promise<OperationsTasksResult> {
  return operationsTasksRequest(`/operations/tasks`, {
    method: "POST",
    body: input,
  });
}

export function actOnOperationsTaskFromBrowser(
  taskId: string,
  locationId: string,
  action: "complete" | "reopen" | "delete",
): Promise<OperationsTasksResult> {
  return operationsTasksRequest(
    `/operations/tasks/${encodeURIComponent(taskId)}/${action}`,
    { method: "POST", body: { locationId } },
  );
}

// --- HQ daily-checklist configuration (6B-2 Opening; 6D Closing) -----
// The corporate template management surface. Same server-side proxy as
// above. The API is the sole authority — every route requires
// `operations.checklists.configure` at CORPORATE scope. Every mutation
// returns the whole authoritative template projection so the editor
// reconciles from it. There is no `locationId` — one corporate standard
// per checklist. `checklist` selects the opening or closing template.

const checklistConfigBase = (checklist: ChecklistKind) =>
  `/operations/${checklist}-checklist/template`;

export type ChecklistTemplateConfigResult =
  | { outcome: "success"; template: OpeningChecklistTemplateConfigResponse }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "invalid"; message: string }
  | { outcome: "error"; message: string };

async function checklistConfigRequest(
  path: string,
  init?: { method: "POST" | "PATCH"; body: unknown },
): Promise<ChecklistTemplateConfigResult> {
  let response: Response;
  try {
    response = await fetch(`${INTERNAL_ADMIN_PROXY}${path}`, {
      method: init?.method ?? "GET",
      headers: init ? { "Content-Type": "application/json" } : undefined,
      body: init ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }

  if (response.status === 401) {
    redirectToInternalSignIn();
    return {
      outcome: "error",
      message: "Your internal session has expired. Sign in again.",
    };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    const body = await safeJson(response);
    return {
      outcome: "invalid",
      message: body?.message ?? "That change isn't valid.",
    };
  }
  if (!response.ok) {
    const body = await safeJson(response);
    return {
      outcome: "error",
      message: body?.message ?? `Something went wrong (${response.status}).`,
    };
  }

  return {
    outcome: "success",
    template: (await response.json()) as OpeningChecklistTemplateConfigResponse,
  };
}

export function getChecklistTemplateFromBrowser(
  checklist: ChecklistKind,
): Promise<ChecklistTemplateConfigResult> {
  return checklistConfigRequest(checklistConfigBase(checklist));
}

export function updateChecklistTemplateItemFromBrowser(
  checklist: ChecklistKind,
  itemId: string,
  patch: { label?: string; isActive?: boolean },
): Promise<ChecklistTemplateConfigResult> {
  return checklistConfigRequest(
    `${checklistConfigBase(checklist)}/items/${encodeURIComponent(itemId)}`,
    { method: "PATCH", body: patch },
  );
}

export function addChecklistTemplateItemFromBrowser(
  checklist: ChecklistKind,
  input: { section: string; label: string },
): Promise<ChecklistTemplateConfigResult> {
  return checklistConfigRequest(`${checklistConfigBase(checklist)}/items`, {
    method: "POST",
    body: input,
  });
}

export function moveChecklistTemplateItemFromBrowser(
  checklist: ChecklistKind,
  itemId: string,
  direction: "up" | "down",
): Promise<ChecklistTemplateConfigResult> {
  return checklistConfigRequest(
    `${checklistConfigBase(checklist)}/items/${encodeURIComponent(
      itemId,
    )}/move`,
    { method: "POST", body: { direction } },
  );
}

export function renameChecklistTemplateSectionFromBrowser(
  checklist: ChecklistKind,
  input: { from: string; to: string },
): Promise<ChecklistTemplateConfigResult> {
  return checklistConfigRequest(
    `${checklistConfigBase(checklist)}/sections/rename`,
    { method: "POST", body: input },
  );
}

export function moveChecklistTemplateSectionFromBrowser(
  checklist: ChecklistKind,
  section: string,
  direction: "up" | "down",
): Promise<ChecklistTemplateConfigResult> {
  return checklistConfigRequest(
    `${checklistConfigBase(checklist)}/sections/move`,
    { method: "POST", body: { section, direction } },
  );
}

// --- Admin: manual Mocha Bean adjustment (Milestone 7A) -----------
// POST via the internal admin proxy. The API (`loyalty.adjust`,
// CORPORATE-only) is the authority — it enforces the required reason, the
// operationKey idempotency, and that the balance never goes below zero. A
// 409 carries a business-safe message (below-zero, or an operationKey
// reused for another customer) shown as-is; on success the refreshed
// AdminLoyaltyCustomerDetail is returned so the screen updates in place.
export type AdjustMochaBeansResult =
  | { outcome: "success"; detail: AdminLoyaltyCustomerDetail }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "invalid"; message: string }
  | { outcome: "conflict"; message: string }
  | { outcome: "error"; message: string };

export async function adjustMochaBeansFromBrowser(
  customerId: string,
  input: AdminAdjustMochaBeansRequest,
): Promise<AdjustMochaBeansResult> {
  let response: Response;
  try {
    response = await fetch(
      `${INTERNAL_ADMIN_PROXY}/loyalty/customers/${encodeURIComponent(customerId)}/adjustments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }

  if (response.status === 401) {
    redirectToInternalSignIn();
    return {
      outcome: "error",
      message: "Your internal session has expired. Sign in again.",
    };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    const body = await safeJson(response);
    return {
      outcome: "invalid",
      message: body?.message ?? "Please check the form and try again.",
    };
  }
  if (response.status === 409) {
    const body = await safeJson(response);
    return {
      outcome: "conflict",
      message: body?.message ?? "That adjustment isn't possible right now.",
    };
  }
  if (!response.ok) {
    const body = await safeJson(response);
    return {
      outcome: "error",
      message: body?.message ?? `Something went wrong (${response.status}).`,
    };
  }

  return {
    outcome: "success",
    detail: (await response.json()) as AdminLoyaltyCustomerDetail,
  };
}

// --- Admin: HQ loyalty configuration + Rewards Catalog (Milestone 7B) --
// All via the internal admin proxy. The API (`loyalty.configure`,
// CORPORATE-only) is the authority for every rule; a 400 carries a
// business-safe message shown as-is.
export type LoyaltyConfigureResult<T> =
  | { outcome: "success"; data: T }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "invalid"; message: string }
  | { outcome: "error"; message: string };

async function loyaltyConfigureRequest<T>(
  path: string,
  method: "PUT" | "POST" | "PATCH",
  body: unknown,
): Promise<LoyaltyConfigureResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${INTERNAL_ADMIN_PROXY}/loyalty/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }

  if (response.status === 401) {
    redirectToInternalSignIn();
    return {
      outcome: "error",
      message: "Your internal session has expired. Sign in again.",
    };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    const errBody = await safeJson(response);
    return {
      outcome: "invalid",
      message: errBody?.message ?? "Please check the form and try again.",
    };
  }
  if (!response.ok) {
    const errBody = await safeJson(response);
    return {
      outcome: "error",
      message: errBody?.message ?? `Something went wrong (${response.status}).`,
    };
  }

  return { outcome: "success", data: (await response.json()) as T };
}

export function updateLoyaltySettingsFromBrowser(
  input: UpdateLoyaltySettingsRequest,
): Promise<LoyaltyConfigureResult<LoyaltySettings>> {
  return loyaltyConfigureRequest<LoyaltySettings>("settings", "PUT", input);
}

export function createLoyaltyRewardFromBrowser(
  input: CreateLoyaltyRewardRequest,
): Promise<LoyaltyConfigureResult<AdminLoyaltyReward>> {
  return loyaltyConfigureRequest<AdminLoyaltyReward>("rewards", "POST", input);
}

export function updateLoyaltyRewardFromBrowser(
  rewardId: string,
  input: UpdateLoyaltyRewardRequest,
): Promise<LoyaltyConfigureResult<AdminLoyaltyReward>> {
  return loyaltyConfigureRequest<AdminLoyaltyReward>(
    `rewards/${encodeURIComponent(rewardId)}`,
    "PATCH",
    input,
  );
}

// --- Admin: Bonus Mocha Beans Promotions (Milestone 7D) ---------------

export function createLoyaltyBonusPromotionFromBrowser(
  input: CreateLoyaltyBonusPromotionRequest,
): Promise<LoyaltyConfigureResult<AdminLoyaltyBonusPromotion>> {
  return loyaltyConfigureRequest<AdminLoyaltyBonusPromotion>(
    "bonus-promotions",
    "POST",
    input,
  );
}

export function updateLoyaltyBonusPromotionFromBrowser(
  promotionId: string,
  input: UpdateLoyaltyBonusPromotionRequest,
): Promise<LoyaltyConfigureResult<AdminLoyaltyBonusPromotion>> {
  return loyaltyConfigureRequest<AdminLoyaltyBonusPromotion>(
    `bonus-promotions/${encodeURIComponent(promotionId)}`,
    "PATCH",
    input,
  );
}

// --- Admin: Promotions & Coupons (Milestone 7E) ----------------------
// Same `LoyaltyConfigureResult` shape (a 400 carries a business-safe
// message shown as-is). The API (`promotions.configure`, CORPORATE-only) is
// the authority for every rule.
async function promotionConfigureRequest<T>(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
): Promise<LoyaltyConfigureResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${INTERNAL_ADMIN_PROXY}/promotions${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return {
      outcome: "error",
      message: "Your internal session has expired. Sign in again.",
    };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400 || response.status === 409) {
    const errBody = await safeJson(response);
    return {
      outcome: "invalid",
      message: errBody?.message ?? "Please check the form and try again.",
    };
  }
  if (!response.ok) {
    const errBody = await safeJson(response);
    return {
      outcome: "error",
      message: errBody?.message ?? `Something went wrong (${response.status}).`,
    };
  }
  return { outcome: "success", data: (await response.json()) as T };
}

export function createPromotionFromBrowser(
  input: CreatePromotionRequest,
): Promise<LoyaltyConfigureResult<AdminPromotion>> {
  return promotionConfigureRequest<AdminPromotion>("", "POST", input);
}

export function updatePromotionFromBrowser(
  promotionId: string,
  input: UpdatePromotionRequest,
): Promise<LoyaltyConfigureResult<AdminPromotion>> {
  return promotionConfigureRequest<AdminPromotion>(
    `/${encodeURIComponent(promotionId)}`,
    "PATCH",
    input,
  );
}

// --- Admin: Gift Cards (Milestone 7F) -------------------------------
// All via the internal admin proxy. The API (giftcards.view /
// giftcards.manage / giftcards.configure, CORPORATE-only) is the authority
// for every rule; a 400/409 carries a business-safe message shown as-is.
// The gift-card SEARCH and every mutation is a POST/PUT with the payload in
// the body — a full gift-card code must never appear in a URL.
export type GiftCardMutationResult<T> =
  | { outcome: "success"; data: T }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "invalid"; message: string }
  | { outcome: "conflict"; message: string }
  | { outcome: "error"; message: string };

async function giftCardRequest<T>(
  path: string,
  method: "POST" | "PUT",
  body: unknown,
): Promise<GiftCardMutationResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${INTERNAL_ADMIN_PROXY}/gift-cards${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }

  if (response.status === 401) {
    redirectToInternalSignIn();
    return {
      outcome: "error",
      message: "Your internal session has expired. Sign in again.",
    };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    const parsed = await safeJson(response);
    return {
      outcome: "invalid",
      message: parsed?.message ?? "Please check the form and try again.",
    };
  }
  if (response.status === 409) {
    const parsed = await safeJson(response);
    return {
      outcome: "conflict",
      message: parsed?.message ?? "That isn't possible right now.",
    };
  }
  if (!response.ok) {
    const parsed = await safeJson(response);
    return {
      outcome: "error",
      message: parsed?.message ?? `Something went wrong (${response.status}).`,
    };
  }
  return { outcome: "success", data: (await response.json()) as T };
}

export function searchGiftCardFromBrowser(
  input: GiftCardSearchRequest,
): Promise<GiftCardMutationResult<AdminGiftCardSearchResponse>> {
  return giftCardRequest<AdminGiftCardSearchResponse>("/search", "POST", input);
}

export function issueGiftCardFromBrowser(
  input: IssueGiftCardRequest,
): Promise<GiftCardMutationResult<IssueGiftCardResponse>> {
  return giftCardRequest<IssueGiftCardResponse>("", "POST", input);
}

export function correctGiftCardBalanceFromBrowser(
  giftCardId: string,
  input: AdjustGiftCardBalanceRequest,
): Promise<GiftCardMutationResult<AdminGiftCardDetail>> {
  return giftCardRequest<AdminGiftCardDetail>(
    `/${encodeURIComponent(giftCardId)}/corrections`,
    "POST",
    input,
  );
}

export function setGiftCardStatusFromBrowser(
  giftCardId: string,
  action: "deactivate" | "reactivate",
  reason?: string,
): Promise<GiftCardMutationResult<AdminGiftCardDetail>> {
  return giftCardRequest<AdminGiftCardDetail>(
    `/${encodeURIComponent(giftCardId)}/${action}`,
    "POST",
    reason ? { reason } : {},
  );
}

export function updateGiftCardConfigurationFromBrowser(
  input: UpdateGiftCardConfigurationRequest,
): Promise<GiftCardMutationResult<GiftCardConfiguration>> {
  return giftCardRequest<GiftCardConfiguration>(
    "/configuration",
    "PUT",
    input,
  );
}

// --- Admin: HQ CRM (Milestone 8A) ---------------------------------
// Browser-side reads/writes for Admin → Customers, via the generic internal
// admin proxy. The API (`/api/v1/admin/customers*`, `customers.view` /
// `customers.notes.manage`, CORPORATE-only) is the sole authority.

export type AdminCustomersListResult =
  | { outcome: "success"; data: AdminCustomerListResponse }
  | { outcome: "forbidden" }
  | { outcome: "error"; message: string };

export async function listAdminCustomersFromBrowser(params: {
  q?: string;
  cursor?: string;
}): Promise<AdminCustomersListResult> {
  const search = new URLSearchParams();
  if (params.q && params.q.trim().length > 0) {
    search.set("q", params.q.trim());
  }
  if (params.cursor) {
    search.set("cursor", params.cursor);
  }
  const qs = search.toString();

  let response: Response;
  try {
    response = await fetch(
      `${INTERNAL_ADMIN_PROXY}/customers${qs.length > 0 ? `?${qs}` : ""}`,
      { cache: "no-store" },
    );
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return { outcome: "error", message: "Your internal session has expired." };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (!response.ok) {
    const body = await safeJson(response);
    return {
      outcome: "error",
      message: body?.message ?? `Something went wrong (${response.status}).`,
    };
  }
  return {
    outcome: "success",
    data: (await response.json()) as AdminCustomerListResponse,
  };
}

export type AddCustomerNoteResult =
  | { outcome: "success"; notes: CustomerNote[] }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "invalid"; message: string }
  | { outcome: "error"; message: string };

export async function addCustomerNoteFromBrowser(
  customerId: string,
  body: string,
): Promise<AddCustomerNoteResult> {
  let response: Response;
  try {
    response = await fetch(
      `${INTERNAL_ADMIN_PROXY}/customers/${encodeURIComponent(customerId)}/notes`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return { outcome: "error", message: "Your internal session has expired." };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    const parsed = await safeJson(response);
    return {
      outcome: "invalid",
      message: parsed?.message ?? "Please check the note and try again.",
    };
  }
  if (!response.ok) {
    const parsed = await safeJson(response);
    return {
      outcome: "error",
      message: parsed?.message ?? `Something went wrong (${response.status}).`,
    };
  }
  return { outcome: "success", notes: (await response.json()) as CustomerNote[] };
}

// --- Admin: HQ Careers / Job Openings (Milestone 8B) --------------
// Browser-side mutations for Admin → Careers, via the generic internal admin
// proxy. The API (`careers.manage`, CORPORATE-only) is the sole authority;
// PATCH cannot change status — publish/unpublish/archive are explicit
// actions.

export type JobOpeningMutationResult =
  | { outcome: "success"; job: AdminJobOpening }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "invalid"; message: string }
  | { outcome: "conflict"; message: string }
  | { outcome: "error"; message: string };

async function careersRequest(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
): Promise<JobOpeningMutationResult> {
  let response: Response;
  try {
    response = await fetch(`${INTERNAL_ADMIN_PROXY}/careers/jobs${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return { outcome: "error", message: "Your internal session has expired." };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    const parsed = await safeJson(response);
    return {
      outcome: "invalid",
      message: parsed?.message ?? "Please check the form and try again.",
    };
  }
  if (response.status === 409) {
    const parsed = await safeJson(response);
    return {
      outcome: "conflict",
      message: parsed?.message ?? "That change isn't allowed right now.",
    };
  }
  if (!response.ok) {
    const parsed = await safeJson(response);
    return {
      outcome: "error",
      message: parsed?.message ?? `Something went wrong (${response.status}).`,
    };
  }
  return { outcome: "success", job: (await response.json()) as AdminJobOpening };
}

export function createJobOpeningFromBrowser(
  input: CreateJobOpeningRequest,
): Promise<JobOpeningMutationResult> {
  return careersRequest("", "POST", input);
}

export function updateJobOpeningFromBrowser(
  jobId: string,
  input: UpdateJobOpeningRequest,
): Promise<JobOpeningMutationResult> {
  return careersRequest(`/${encodeURIComponent(jobId)}`, "PATCH", input);
}

export function jobOpeningActionFromBrowser(
  jobId: string,
  action: "publish" | "unpublish" | "archive",
): Promise<JobOpeningMutationResult> {
  return careersRequest(
    `/${encodeURIComponent(jobId)}/${action}`,
    "POST",
    {},
  );
}

// --- Admin: HQ Careers / Applicants (Milestone 8C) ---------------
// Browser-side writes for Admin → Careers → Applicants, via the generic
// internal admin proxy. The API (`applicants.manage`, CORPORATE-only) is the
// sole authority. There is no general application PATCH — status moves only
// through the dedicated `/status` action (any valid status → any valid
// status); notes are append-only.

export type AdminJobApplicationsListResult =
  | { outcome: "success"; data: AdminJobApplicationsResponse }
  | { outcome: "forbidden" }
  | { outcome: "error"; message: string };

export async function listAdminJobApplicationsFromBrowser(params: {
  status?: string;
  jobOpeningId?: string;
  cursor?: string;
}): Promise<AdminJobApplicationsListResult> {
  const search = new URLSearchParams();
  if (params.status && params.status.trim().length > 0) {
    search.set("status", params.status.trim());
  }
  if (params.jobOpeningId && params.jobOpeningId.trim().length > 0) {
    search.set("jobOpeningId", params.jobOpeningId.trim());
  }
  if (params.cursor) {
    search.set("cursor", params.cursor);
  }
  const qs = search.toString();

  let response: Response;
  try {
    response = await fetch(
      `${INTERNAL_ADMIN_PROXY}/careers/applications${
        qs.length > 0 ? `?${qs}` : ""
      }`,
      { cache: "no-store" },
    );
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return { outcome: "error", message: "Your internal session has expired." };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (!response.ok) {
    const body = await safeJson(response);
    return {
      outcome: "error",
      message: body?.message ?? `Something went wrong (${response.status}).`,
    };
  }
  return {
    outcome: "success",
    data: (await response.json()) as AdminJobApplicationsResponse,
  };
}

export type JobApplicationStatusResult =
  | { outcome: "success"; detail: AdminJobApplicationDetail }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "invalid"; message: string }
  | { outcome: "error"; message: string };

export async function updateJobApplicationStatusFromBrowser(
  applicationId: string,
  status: JobApplicationStatus,
): Promise<JobApplicationStatusResult> {
  let response: Response;
  try {
    response = await fetch(
      `${INTERNAL_ADMIN_PROXY}/careers/applications/${encodeURIComponent(
        applicationId,
      )}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      },
    );
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return { outcome: "error", message: "Your internal session has expired." };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    const parsed = await safeJson(response);
    return {
      outcome: "invalid",
      message: parsed?.message ?? "That status isn't valid.",
    };
  }
  if (!response.ok) {
    const parsed = await safeJson(response);
    return {
      outcome: "error",
      message: parsed?.message ?? `Something went wrong (${response.status}).`,
    };
  }
  return {
    outcome: "success",
    detail: (await response.json()) as AdminJobApplicationDetail,
  };
}

export type AddJobApplicationNoteResult =
  | { outcome: "success"; notes: JobApplicationNote[] }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "invalid"; message: string }
  | { outcome: "error"; message: string };

export async function addJobApplicationNoteFromBrowser(
  applicationId: string,
  body: string,
): Promise<AddJobApplicationNoteResult> {
  let response: Response;
  try {
    response = await fetch(
      `${INTERNAL_ADMIN_PROXY}/careers/applications/${encodeURIComponent(
        applicationId,
      )}/notes`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return { outcome: "error", message: "Your internal session has expired." };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    const parsed = await safeJson(response);
    return {
      outcome: "invalid",
      message: parsed?.message ?? "Please check the note and try again.",
    };
  }
  if (!response.ok) {
    const parsed = await safeJson(response);
    return {
      outcome: "error",
      message: parsed?.message ?? `Something went wrong (${response.status}).`,
    };
  }
  return {
    outcome: "success",
    notes: (await response.json()) as JobApplicationNote[],
  };
}

// --- Public: apply to a job opening (Milestone 8C) ---------------
// Anonymous, no session. Posts through a same-origin proxy route
// (app/api/careers/[jobId]/apply) so the API's ~5/min IP throttle and
// visibility/404 rules apply unchanged. The response is only { ok: true };
// a non-visible job is 404.

export type SubmitJobApplicationResult =
  | { outcome: "success" }
  | { outcome: "not-found" }
  | { outcome: "invalid"; message: string }
  | { outcome: "throttled"; message: string }
  | { outcome: "error"; message: string };

export async function submitJobApplicationFromBrowser(
  jobId: string,
  input: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    location: string;
    workAuthorized: boolean;
    availability: string;
    message: string;
    resumeUrl: string | null;
  },
): Promise<SubmitJobApplicationResult> {
  let response: Response;
  try {
    response = await fetch(
      `/api/careers/${encodeURIComponent(jobId)}/apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    const parsed = await safeJson(response);
    return {
      outcome: "invalid",
      message: parsed?.message ?? "Please check the form and try again.",
    };
  }
  if (response.status === 429) {
    const parsed = await safeJson(response);
    return {
      outcome: "throttled",
      message:
        parsed?.message ??
        "Too many submissions right now. Please wait a minute and try again.",
    };
  }
  if (!response.ok) {
    const parsed = await safeJson(response);
    return {
      outcome: "error",
      message: parsed?.message ?? `Something went wrong (${response.status}).`,
    };
  }
  return { outcome: "success" };
}

// --- Admin: HQ Franchising (Milestone 8D) -------------------------
// Browser-side reads/writes for Admin → Franchising, via the generic
// internal admin proxy. The API (`franchising.view` / `franchising.manage`,
// CORPORATE-only) is the sole authority. There is no general inquiry
// PATCH — status moves only through the dedicated `/status` action; notes
// are append-only.

export type AdminFranchiseInquiriesListResult =
  | { outcome: "success"; data: AdminFranchiseInquiriesResponse }
  | { outcome: "forbidden" }
  | { outcome: "error"; message: string };

export async function listAdminFranchiseInquiriesFromBrowser(params: {
  status?: string;
  cursor?: string;
}): Promise<AdminFranchiseInquiriesListResult> {
  const search = new URLSearchParams();
  if (params.status && params.status.trim().length > 0) {
    search.set("status", params.status.trim());
  }
  if (params.cursor) {
    search.set("cursor", params.cursor);
  }
  const qs = search.toString();

  let response: Response;
  try {
    response = await fetch(
      `${INTERNAL_ADMIN_PROXY}/franchising/inquiries${
        qs.length > 0 ? `?${qs}` : ""
      }`,
      { cache: "no-store" },
    );
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return { outcome: "error", message: "Your internal session has expired." };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (!response.ok) {
    const body = await safeJson(response);
    return {
      outcome: "error",
      message: body?.message ?? `Something went wrong (${response.status}).`,
    };
  }
  return {
    outcome: "success",
    data: (await response.json()) as AdminFranchiseInquiriesResponse,
  };
}

export type FranchiseInquiryStatusResult =
  | { outcome: "success"; detail: AdminFranchiseInquiryDetail }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "invalid"; message: string }
  | { outcome: "error"; message: string };

export async function updateFranchiseInquiryStatusFromBrowser(
  inquiryId: string,
  status: FranchiseInquiryStatus,
): Promise<FranchiseInquiryStatusResult> {
  let response: Response;
  try {
    response = await fetch(
      `${INTERNAL_ADMIN_PROXY}/franchising/inquiries/${encodeURIComponent(
        inquiryId,
      )}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      },
    );
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return { outcome: "error", message: "Your internal session has expired." };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    const parsed = await safeJson(response);
    return {
      outcome: "invalid",
      message: parsed?.message ?? "That status isn't valid.",
    };
  }
  if (!response.ok) {
    const parsed = await safeJson(response);
    return {
      outcome: "error",
      message: parsed?.message ?? `Something went wrong (${response.status}).`,
    };
  }
  return {
    outcome: "success",
    detail: (await response.json()) as AdminFranchiseInquiryDetail,
  };
}

export type AddFranchiseInquiryNoteResult =
  | { outcome: "success"; notes: FranchiseInquiryNote[] }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "invalid"; message: string }
  | { outcome: "error"; message: string };

export async function addFranchiseInquiryNoteFromBrowser(
  inquiryId: string,
  body: string,
): Promise<AddFranchiseInquiryNoteResult> {
  let response: Response;
  try {
    response = await fetch(
      `${INTERNAL_ADMIN_PROXY}/franchising/inquiries/${encodeURIComponent(
        inquiryId,
      )}/notes`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return { outcome: "error", message: "Your internal session has expired." };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    const parsed = await safeJson(response);
    return {
      outcome: "invalid",
      message: parsed?.message ?? "Please check the note and try again.",
    };
  }
  if (!response.ok) {
    const parsed = await safeJson(response);
    return {
      outcome: "error",
      message: parsed?.message ?? `Something went wrong (${response.status}).`,
    };
  }
  return {
    outcome: "success",
    notes: (await response.json()) as FranchiseInquiryNote[],
  };
}

// --- Public: submit a franchise inquiry (Milestone 8D) -----------
// Anonymous, no session. Posts through a same-origin proxy route
// (app/api/franchising/inquiry) so the API's ~5/min IP throttle applies
// unchanged. The response is only { ok: true }.

export type SubmitFranchiseInquiryResult =
  | { outcome: "success" }
  | { outcome: "invalid"; message: string }
  | { outcome: "throttled"; message: string }
  | { outcome: "error"; message: string };

export async function submitFranchiseInquiryFromBrowser(
  input: SubmitFranchiseInquiryRequest,
): Promise<SubmitFranchiseInquiryResult> {
  let response: Response;
  try {
    response = await fetch("/api/franchising/inquiry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }
  if (response.status === 400) {
    const parsed = await safeJson(response);
    return {
      outcome: "invalid",
      message: parsed?.message ?? "Please check the form and try again.",
    };
  }
  if (response.status === 429) {
    const parsed = await safeJson(response);
    return {
      outcome: "throttled",
      message:
        parsed?.message ??
        "Too many submissions right now. Please wait a minute and try again.",
    };
  }
  if (!response.ok) {
    const parsed = await safeJson(response);
    return {
      outcome: "error",
      message: parsed?.message ?? `Something went wrong (${response.status}).`,
    };
  }
  return { outcome: "success" };
}

// --- Admin: HQ Content / CMS (Milestone 8E) -----------------------
// Browser-side writes for Admin → Content, via the generic internal admin
// proxy. The API (`cms.manage`, CORPORATE-only) is the sole authority.
// Save draft only ever touches draftContent; publish is a separate,
// explicit action.

export type CmsPageMutationResult =
  | { outcome: "success"; detail: AdminCmsPageDetail }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "invalid"; message: string }
  | { outcome: "error"; message: string };

async function cmsRequest(
  pageKey: string,
  path: string,
  method: "PATCH" | "POST",
  body?: unknown,
): Promise<CmsPageMutationResult> {
  let response: Response;
  try {
    response = await fetch(
      `${INTERNAL_ADMIN_PROXY}/content/${encodeURIComponent(pageKey)}${path}`,
      {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      },
    );
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return { outcome: "error", message: "Your internal session has expired." };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    const parsed = await safeJson(response);
    return {
      outcome: "invalid",
      message: parsed?.message ?? "Please check the content and try again.",
    };
  }
  if (!response.ok) {
    const parsed = await safeJson(response);
    return {
      outcome: "error",
      message: parsed?.message ?? `Something went wrong (${response.status}).`,
    };
  }
  return {
    outcome: "success",
    detail: (await response.json()) as AdminCmsPageDetail,
  };
}

export function saveCmsPageDraftFromBrowser(
  pageKey: string,
  content: CmsPageContent,
): Promise<CmsPageMutationResult> {
  return cmsRequest(pageKey, "", "PATCH", { content });
}

export function publishCmsPageFromBrowser(
  pageKey: string,
): Promise<CmsPageMutationResult> {
  return cmsRequest(pageKey, "/publish", "POST");
}

// --- Admin: Media Library (Milestone 8F) --------------------------
// Browser-side reads/writes for Admin → Media, via the generic internal
// admin proxy for list/deactivate. Upload goes through a DEDICATED proxy
// route (app/api/internal/admin/media/route.ts) instead of the generic
// JSON proxy — the generic proxy reads the body as text, which would
// corrupt binary multipart image bytes. The API (`media.view` /
// `media.manage`, CORPORATE-only) is the sole authority.

export type AdminMediaAssetsListResult =
  | { outcome: "success"; data: AdminMediaAssetsResponse }
  | { outcome: "forbidden" }
  | { outcome: "error"; message: string };

export async function listAdminMediaAssetsFromBrowser(params: {
  cursor?: string;
}): Promise<AdminMediaAssetsListResult> {
  const search = new URLSearchParams();
  if (params.cursor) {
    search.set("cursor", params.cursor);
  }
  const qs = search.toString();

  let response: Response;
  try {
    response = await fetch(
      `${INTERNAL_ADMIN_PROXY}/media${qs.length > 0 ? `?${qs}` : ""}`,
      { cache: "no-store" },
    );
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return { outcome: "error", message: "Your internal session has expired." };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (!response.ok) {
    const body = await safeJson(response);
    return {
      outcome: "error",
      message: body?.message ?? `Something went wrong (${response.status}).`,
    };
  }
  return {
    outcome: "success",
    data: (await response.json()) as AdminMediaAssetsResponse,
  };
}

export type UploadMediaAssetResult =
  | { outcome: "success"; asset: AdminMediaAsset }
  | { outcome: "forbidden" }
  | { outcome: "invalid"; message: string }
  | { outcome: "error"; message: string };

export async function uploadMediaAssetFromBrowser(
  file: File,
): Promise<UploadMediaAssetResult> {
  const formData = new FormData();
  formData.append("file", file);

  let response: Response;
  try {
    response = await fetch("/api/internal/admin/media", {
      method: "POST",
      body: formData,
    });
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return { outcome: "error", message: "Your internal session has expired." };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 400) {
    const parsed = await safeJson(response);
    return {
      outcome: "invalid",
      message: parsed?.message ?? "That image couldn't be uploaded.",
    };
  }
  if (!response.ok) {
    const parsed = await safeJson(response);
    return {
      outcome: "error",
      message: parsed?.message ?? `Something went wrong (${response.status}).`,
    };
  }
  const body = (await response.json()) as { asset: AdminMediaAsset };
  return { outcome: "success", asset: body.asset };
}

export type DeactivateMediaAssetResult =
  | { outcome: "success"; asset: AdminMediaAsset }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "conflict"; message: string }
  | { outcome: "error"; message: string };

export async function deactivateMediaAssetFromBrowser(
  mediaAssetId: string,
): Promise<DeactivateMediaAssetResult> {
  let response: Response;
  try {
    response = await fetch(
      `${INTERNAL_ADMIN_PROXY}/media/${encodeURIComponent(mediaAssetId)}/deactivate`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return { outcome: "error", message: "Your internal session has expired." };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 409) {
    const parsed = await safeJson(response);
    return {
      outcome: "conflict",
      message: parsed?.message ?? "That image is currently in use and can't be removed.",
    };
  }
  if (!response.ok) {
    const parsed = await safeJson(response);
    return {
      outcome: "error",
      message: parsed?.message ?? `Something went wrong (${response.status}).`,
    };
  }
  const body = (await response.json()) as { asset: AdminMediaAsset };
  return { outcome: "success", asset: body.asset };
}

// --- Admin: HQ Marketing Campaigns (Milestone 8G) -----------------
// Browser-side mutations for Admin → Marketing, via the generic internal
// admin proxy. The API (`marketing.manage`, CORPORATE-only) is the sole
// authority; PATCH cannot change status — activate/end are explicit
// actions.

export type CampaignMutationResult =
  | { outcome: "success"; campaign: AdminCampaign }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "invalid"; message: string }
  | { outcome: "conflict"; message: string }
  | { outcome: "error"; message: string };

async function campaignsRequest(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
): Promise<CampaignMutationResult> {
  let response: Response;
  try {
    response = await fetch(`${INTERNAL_ADMIN_PROXY}/marketing/campaigns${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    return { outcome: "error", message: "Could not reach the server." };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return { outcome: "error", message: "Your internal session has expired." };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    const parsed = await safeJson(response);
    return {
      outcome: "invalid",
      message: parsed?.message ?? "Please check the form and try again.",
    };
  }
  if (response.status === 409) {
    const parsed = await safeJson(response);
    return {
      outcome: "conflict",
      message: parsed?.message ?? "That change isn't allowed right now.",
    };
  }
  if (!response.ok) {
    const parsed = await safeJson(response);
    return {
      outcome: "error",
      message: parsed?.message ?? `Something went wrong (${response.status}).`,
    };
  }
  return {
    outcome: "success",
    campaign: (await response.json()) as AdminCampaign,
  };
}

export function createCampaignFromBrowser(
  input: CreateCampaignRequest,
): Promise<CampaignMutationResult> {
  return campaignsRequest("", "POST", input);
}

export function updateCampaignFromBrowser(
  campaignId: string,
  input: UpdateCampaignRequest,
): Promise<CampaignMutationResult> {
  return campaignsRequest(`/${encodeURIComponent(campaignId)}`, "PATCH", input);
}

export function updateCampaignStatusFromBrowser(
  campaignId: string,
  status: UpdateCampaignStatusRequest["status"],
): Promise<CampaignMutationResult> {
  return campaignsRequest(
    `/${encodeURIComponent(campaignId)}/status`,
    "POST",
    { status },
  );
}
