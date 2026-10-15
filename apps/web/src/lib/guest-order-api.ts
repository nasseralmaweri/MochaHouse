// Server-side call to the API's guest order-status endpoint (R1 / S3c), shared
// by the tracking routes. The access token goes in a request header, never in
// the URL, so it cannot appear in the API's (or a proxy's) request logs.

import { signedClientIpHeaders } from "@/lib/client-ip-forwarding";

export const ORDER_ACCESS_TOKEN_HEADER = "x-order-access-token";

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export function fetchGuestOrderStatus(
  orderId: string,
  token: string,
  requestHeaders: { get(name: string): string | null },
): Promise<Response> {
  return fetch(`${getApiUrl()}/orders/${encodeURIComponent(orderId)}`, {
    headers: {
      [ORDER_ACCESS_TOKEN_HEADER]: token,
      ...signedClientIpHeaders(requestHeaders),
    },
    cache: "no-store",
  });
}

// What every tracking route answers for "no usable credential": identical for
// an unknown order, a wrong token and a missing cookie, so nothing is learned.
export const NOT_FOUND_BODY = JSON.stringify({ message: "Order not found." });

export const NO_STORE_JSON: Record<string, string> = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
