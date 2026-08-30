import type {
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

// --- Store queue (INTERNAL — protected by InternalAuthGuard, Milestone 5A)
// These calls run in the browser (the queue is location-picker driven), so
// they go through this app's own server-side proxy
// (/api/internal/admin/*, see app/api/internal/admin/[...path]/route.ts)
// rather than hitting the API directly: the proxy reads the HttpOnly
// mh_internal_session cookie and forwards it as the internal Bearer token,
// which client-side JS can never see. A 401 here means the internal session
// is gone/expired — bounce to the internal sign-in page (the /admin layout
// already gate-keeps the first render).

const INTERNAL_ADMIN_PROXY = "/api/internal/admin";

function redirectToInternalSignIn(): void {
  if (typeof window !== "undefined") {
    // A full-document navigation is intentional here: the internal session
    // has expired, so we want the browser to drop all client state and
    // re-run the server-side /admin auth boundary from scratch. A soft
    // router push would keep stale state around.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/internal/sign-in";
  }
}

export async function getLocationsFromBrowser(): Promise<LocationSummary[]> {
  const response = await fetch(`${getPublicApiUrl()}/locations`);
  if (!response.ok) {
    throw new Error(`Failed to load locations (${response.status}).`);
  }
  return response.json() as Promise<LocationSummary[]>;
}

export async function getActiveStoreOrdersFromBrowser(
  locationId: string,
): Promise<StoreOrderSummary[]> {
  const response = await fetch(
    `${INTERNAL_ADMIN_PROXY}/orders?locationId=${encodeURIComponent(locationId)}`,
  );
  if (response.status === 401) {
    redirectToInternalSignIn();
    throw new Error("Your internal session has expired. Sign in again.");
  }
  if (!response.ok) {
    throw new Error(`Failed to load active orders (${response.status}).`);
  }
  return response.json() as Promise<StoreOrderSummary[]>;
}

export async function getStoreOrderDetailFromBrowser(
  orderId: string,
  locationId: string,
): Promise<StoreOrderDetail | null> {
  const response = await fetch(
    `${INTERNAL_ADMIN_PROXY}/orders/${orderId}?locationId=${encodeURIComponent(locationId)}`,
  );
  if (response.status === 401) {
    redirectToInternalSignIn();
    throw new Error("Your internal session has expired. Sign in again.");
  }
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to load order detail (${response.status}).`);
  }
  return response.json() as Promise<StoreOrderDetail>;
}

export type AdvanceResult =
  | { outcome: "success"; result: AdvanceOrderStatusResponse }
  | { outcome: "conflict"; message: string }
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
