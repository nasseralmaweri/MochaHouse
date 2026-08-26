import type {
  CheckoutRequest,
  LocationMenuResponse,
  OrderConfirmation,
  OrderStatusResponse,
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
// localStorage.
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
    response = await fetch(`${getPublicApiUrl()}/orders`, {
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
