import { NextRequest, NextResponse } from "next/server";
import { CHECKOUT_SESSION_INVALID } from "@mocha-house/contracts";
import { rejectUntrustedOrigin } from "@/lib/security/request-origin";
import {
  forwardCheckoutPayment,
  readPaymentRequest,
} from "@/lib/checkout/payment-proxy";

const NO_STORE = { "Cache-Control": "no-store" };

// ESP-04 M4b — the customer's checkout page is still open on this
// checkout's payment (a heartbeat; abandoned payments are only ever cleaned
// up after a long time with none). The browser sends only the location; the
// checkout-session token comes from the HttpOnly cookie, and the API binds
// it to this business, location and customer. 204 with nothing in it.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const untrusted = rejectUntrustedOrigin(request);
  if (untrusted) return untrusted as NextResponse;

  const read = await readPaymentRequest(request);
  if (!read) {
    return NextResponse.json(
      { message: "A location is required." },
      { status: 400, headers: NO_STORE },
    );
  }
  if (!read.checkoutToken) {
    return NextResponse.json(
      {
        code: CHECKOUT_SESSION_INVALID,
        message:
          "Your checkout needs to be refreshed. Refresh the page to continue.",
      },
      { status: 409, headers: NO_STORE },
    );
  }
  const forwarded = await forwardCheckoutPayment(
    request,
    "/orders/checkout-sessions/payment/activity",
    {
      locationId: read.locationId,
      checkoutToken: read.checkoutToken,
    },
  );
  if (!forwarded) {
    return NextResponse.json(
      { message: "Could not reach the server." },
      { status: 503, headers: NO_STORE },
    );
  }
  if (forwarded.response.status === 204) {
    return new NextResponse(null, { status: 204, headers: forwarded.headers });
  }
  return new NextResponse(forwarded.text, {
    status: forwarded.response.status,
    headers: forwarded.headers,
  });
}
