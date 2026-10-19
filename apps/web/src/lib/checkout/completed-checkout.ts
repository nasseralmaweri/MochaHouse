import type { NextRequest, NextResponse } from "next/server";
import {
  GUEST_SESSION_COOKIE,
  guestSessionCookieOptions,
  isValidAccessToken,
  isValidOrderId,
  parseGuestSession,
  serializeGuestSession,
  withGuestOrder,
} from "@/lib/security/guest-session";
import {
  type CheckoutSessions,
  withoutCheckoutSession,
  writeCheckoutSessions,
} from "@/lib/security/checkout-session";

// ESP-04 M2 — an API answer that carries the placed order: 200 / 201. A 202
// (a two-step payment waiting for its customer) is NOT one — that checkout
// must stay in this browser so a reload resumes the same payment.
export function isPlacedOrder(response: Response): boolean {
  return response.ok && response.status !== 202;
}

// A placed order ends its checkout here: this browser forgets the checkout
// session (the next order is a new checkout) and, R1 / S3c, the order's
// access token goes into the HttpOnly guest-session cookie so the
// confirmation URL never needs to carry it. The response body is unchanged.
export function rememberPlacedOrder(
  result: NextResponse,
  responseBody: string,
  request: NextRequest,
  sessions: CheckoutSessions,
  locationId: string,
): void {
  writeCheckoutSessions(
    result.cookies,
    withoutCheckoutSession(sessions, locationId),
  );
  try {
    const confirmation = JSON.parse(responseBody) as {
      orderId?: unknown;
      accessToken?: unknown;
    };
    if (
      isValidOrderId(confirmation.orderId) &&
      isValidAccessToken(confirmation.accessToken)
    ) {
      result.cookies.set(
        GUEST_SESSION_COOKIE,
        serializeGuestSession(
          withGuestOrder(
            parseGuestSession(request.cookies.get(GUEST_SESSION_COOKIE)?.value),
            confirmation.orderId,
            confirmation.accessToken,
          ),
        ),
        guestSessionCookieOptions(),
      );
    }
  } catch {
    // Not JSON: nothing to bootstrap; the response is passed through as is.
  }
}
