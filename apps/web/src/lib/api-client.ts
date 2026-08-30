import type {
  AdminLocationDetail,
  AdminProductDetail,
  AdminUpdateLocationRequest,
  AdminUpdateProductRequest,
  AdvanceOrderStatusResponse,
  CheckoutRequest,
  LocationMenuResponse,
  LocationSummary,
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
  method: "PATCH" | "PUT" | "DELETE",
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
