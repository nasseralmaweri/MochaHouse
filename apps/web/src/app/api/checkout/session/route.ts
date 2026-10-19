import { storefrontApiFetch } from "@/lib/storefront-context";
import { NextRequest, NextResponse } from "next/server";
import {
  CUSTOMER_NOT_ENROLLED,
  type CheckoutSessionResponse,
} from "@mocha-house/contracts";
import { rejectUntrustedOrigin } from "@/lib/security/request-origin";
import { CUSTOMER_SESSION_COOKIE } from "@/lib/auth/session";
import { signedClientIpHeaders } from "@/lib/client-ip-forwarding";
import { passthroughHeaders } from "@/lib/rate-limit-message";
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
  CHECKOUT_SESSION_COOKIE,
  type BrowserCheckoutSession,
  isValidCheckoutToken,
  isValidLocationId,
  parseCheckoutSessions,
  tokenForLocation,
  withCheckoutSession,
  withoutCheckoutSession,
  writeCheckoutSessions,
} from "@/lib/security/checkout-session";

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error("API_URL environment variable is not set. See apps/web/.env.example.");
  }
  return apiUrl;
}

function isNotEnrolled(body: string): boolean {
  try {
    return (JSON.parse(body) as { code?: unknown } | null)?.code === CUSTOMER_NOT_ENROLLED;
  } catch {
    return false;
  }
}

async function readLocationId(request: NextRequest): Promise<string | null> {
  try {
    const body = (await request.json()) as { locationId?: unknown } | null;
    return isValidLocationId(body?.locationId) ? body.locationId : null;
  } catch {
    return null;
  }
}

// ESP-03 PR 6 — start or resume this visitor's checkout at a location. The
// checkout-session token stays in the HttpOnly cookie; the API decides
// whether the presented session is still this business's, this location's
// and this customer's. A held payment is reported as IN_PROGRESS (never a
// fresh checkout that could charge again), and a completed one as
// COMPLETED with its order id (and this browser then forgets it).
export async function POST(request: NextRequest): Promise<NextResponse> {
  const untrusted = rejectUntrustedOrigin(request);
  if (untrusted) return untrusted as NextResponse;

  const locationId = await readLocationId(request);
  if (!locationId) {
    return NextResponse.json({ message: "A location is required." }, { status: 400 });
  }
  const sessions = parseCheckoutSessions(request.cookies.get(CHECKOUT_SESSION_COOKIE)?.value);
  const presented = tokenForLocation(sessions, locationId);
  const customerToken = request.cookies.get(CUSTOMER_SESSION_COOKIE)?.value;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...signedClientIpHeaders(request.headers),
  };
  if (customerToken) headers.Authorization = `Bearer ${customerToken}`;

  const start = (withHeaders: Record<string, string>) =>
    storefrontApiFetch(`${getApiUrl()}/orders/checkout-sessions`, {
      method: "POST",
      headers: withHeaders,
      body: JSON.stringify({ locationId, checkoutToken: presented }),
      cache: "no-store",
    });
  let response: Response;
  let text: string;
  try {
    response = await start(headers);
    text = await response.text();
    // SC4f-2 — a signed-in login that has NOT joined this restaurant may
    // still order as a guest (placing the order asks it to join or choose
    // guest), so its checkout session is a guest session. Only for exactly
    // this refusal: a restricted or deactivated profile never falls back.
    if (response.status === 403 && customerToken && isNotEnrolled(text)) {
      const guestHeaders = { ...headers };
      delete guestHeaders.Authorization;
      response = await start(guestHeaders);
      text = await response.text();
    }
  } catch {
    return NextResponse.json({ message: "Could not reach the server." }, { status: 503 });
  }

  if (!response.ok) {
    return new NextResponse(text, { status: response.status, headers: passthroughHeaders(response) });
  }
  let session: CheckoutSessionResponse;
  try {
    session = JSON.parse(text) as CheckoutSessionResponse;
  } catch {
    return NextResponse.json({ message: "Could not start checkout." }, { status: 502 });
  }
  if (!isValidCheckoutToken(session.checkoutToken)) {
    return NextResponse.json({ message: "Could not start checkout." }, { status: 502 });
  }

  const confirmation = session.state === "COMPLETED" ? session.confirmation : null;
  const body: BrowserCheckoutSession = {
    state: session.state,
    acceptsNewPaymentsUntil: session.acceptsNewPaymentsUntil,
    orderId: confirmation && isValidOrderId(confirmation.orderId) ? confirmation.orderId : null,
  };
  const result = NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  // A completed checkout is reported once and then forgotten by this
  // browser: the visitor is taken to its order, and their next order here is
  // a new checkout (an intentional repeat purchase is always possible).
  writeCheckoutSessions(
    result.cookies,
    session.state === "COMPLETED"
      ? withoutCheckoutSession(sessions, locationId)
      : withCheckoutSession(sessions, locationId, session.checkoutToken),
  );
  // A completed checkout whose confirmation never reached this browser (a
  // lost response): give it the same order access a placed order gets.
  if (
    confirmation &&
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
  return result;
}
