import type { NextRequest } from "next/server";
import { CUSTOMER_NOT_ENROLLED } from "@mocha-house/contracts";
import { storefrontApiFetch } from "@/lib/storefront-context";
import { CUSTOMER_SESSION_COOKIE } from "@/lib/auth/session";
import { signedClientIpHeaders } from "@/lib/client-ip-forwarding";
import { passthroughHeaders } from "@/lib/rate-limit-message";
import {
  CHECKOUT_SESSION_COOKIE,
  type CheckoutSessions,
  isValidLocationId,
  parseCheckoutSessions,
  tokenForLocation,
} from "@/lib/security/checkout-session";

// ESP-04 M2 — shared by the two-step payment routes (check, and the
// development simulator).

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export interface PaymentRequest {
  body: Record<string, unknown>;
  locationId: string;
  sessions: CheckoutSessions;
  // This location's checkout-session token, from the HttpOnly cookie only.
  checkoutToken: string | null;
}

// The browser's JSON body (a location, and for the simulator an outcome) and
// this location's checkout session; null when there is no valid location.
export async function readPaymentRequest(
  request: NextRequest,
): Promise<PaymentRequest | null> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!isValidLocationId(body.locationId)) return null;
  const sessions = parseCheckoutSessions(
    request.cookies.get(CHECKOUT_SESSION_COOKIE)?.value,
  );
  return {
    body,
    locationId: body.locationId,
    sessions,
    checkoutToken: tokenForLocation(sessions, body.locationId),
  };
}

function isNotEnrolled(body: string): boolean {
  try {
    return (
      (JSON.parse(body) as { code?: unknown } | null)?.code ===
      CUSTOMER_NOT_ENROLLED
    );
  } catch {
    return false;
  }
}

// Forwards to the API with the customer's sign-in when there is one. A
// signed-in login that has NOT joined this restaurant ordered as a guest
// (its checkout session is a guest session), so — exactly as when the
// session started — that one refusal is retried as a guest. Null when the
// API cannot be reached.
export async function forwardCheckoutPayment(
  request: NextRequest,
  path: string,
  payload: Record<string, unknown>,
): Promise<{ response: Response; text: string; headers: Headers } | null> {
  const customerToken = request.cookies.get(CUSTOMER_SESSION_COOKIE)?.value;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...signedClientIpHeaders(request.headers),
  };
  if (customerToken) headers.Authorization = `Bearer ${customerToken}`;
  const send = (withHeaders: Record<string, string>) =>
    storefrontApiFetch(`${getApiUrl()}${path}`, {
      method: "POST",
      headers: withHeaders,
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  try {
    let response = await send(headers);
    let text = await response.text();
    if (response.status === 403 && customerToken && isNotEnrolled(text)) {
      const guestHeaders = { ...headers };
      delete guestHeaders.Authorization;
      response = await send(guestHeaders);
      text = await response.text();
    }
    const out = passthroughHeaders(response);
    const merged = new Headers(out);
    merged.set("Cache-Control", "no-store");
    return { response, text, headers: merged };
  } catch {
    return null;
  }
}
