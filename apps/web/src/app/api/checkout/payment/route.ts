import { NextRequest, NextResponse } from "next/server";
import { CHECKOUT_SESSION_INVALID } from "@mocha-house/contracts";
import { rejectUntrustedOrigin } from "@/lib/security/request-origin";
import {
  isPlacedOrder,
  rememberPlacedOrder,
} from "@/lib/checkout/completed-checkout";
import {
  forwardCheckoutPayment,
  readPaymentRequest,
} from "@/lib/checkout/payment-proxy";

// ESP-04 M2 — check this visitor's two-step payment with the payment
// provider (through the API, which reads the outcome from the provider — the
// browser's word is never evidence of payment). The browser sends only the
// location; the checkout-session token comes from the HttpOnly cookie.
//   200 the order (this checkout is then forgotten here, like a placed order)
//   202 still waiting for the customer or the provider
//   402 it did not go through; 409 the outcome is not known yet.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const untrusted = rejectUntrustedOrigin(request);
  if (untrusted) return untrusted as NextResponse;

  const read = await readPaymentRequest(request);
  if (!read) {
    return NextResponse.json(
      { message: "A location is required." },
      { status: 400 },
    );
  }
  if (!read.checkoutToken) {
    return NextResponse.json(
      {
        code: CHECKOUT_SESSION_INVALID,
        message:
          "Your checkout needs to be refreshed. Refresh the page to continue.",
      },
      { status: 409 },
    );
  }
  const forwarded = await forwardCheckoutPayment(
    request,
    "/orders/checkout-sessions/payment",
    {
      locationId: read.locationId,
      checkoutToken: read.checkoutToken,
    },
  );
  if (!forwarded) {
    return NextResponse.json(
      { message: "Could not reach the server." },
      { status: 503 },
    );
  }
  const result = new NextResponse(forwarded.text, {
    status: forwarded.response.status,
    headers: forwarded.headers,
  });
  if (isPlacedOrder(forwarded.response)) {
    rememberPlacedOrder(
      result,
      forwarded.text,
      request,
      read.sessions,
      read.locationId,
    );
  }
  return result;
}
