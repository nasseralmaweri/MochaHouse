import { storefrontApiFetch } from "@/lib/storefront-context";
import { NextRequest, NextResponse } from "next/server";
import {
  GUEST_SESSION_COOKIE,
  guestSessionCookieOptions,
  isValidAccessToken,
  isValidOrderId,
  parseGuestSession,
  serializeGuestSession,
  withGuestOrder,
} from "@/lib/security/guest-session";
import { rejectUntrustedOrigin } from "@/lib/security/request-origin";
import { CUSTOMER_SESSION_COOKIE } from "@/lib/auth/session";
import { signedClientIpHeaders } from "@/lib/client-ip-forwarding";
import { passthroughHeaders } from "@/lib/rate-limit-message";
import { CUSTOMER_NOT_ENROLLED } from "@mocha-house/contracts";

// SC4f-2 — refusal when a signed-in customer asks to check out as a guest
// but has (or may have) an account at this restaurant.
const GUEST_CHECKOUT_NOT_ALLOWED = "GUEST_CHECKOUT_NOT_ALLOWED";
const SESSION_EXPIRED = "SESSION_EXPIRED";

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;

  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }

  return apiUrl;
}

// Thin server-side proxy for checkout submission — no checkout logic of
// its own, CheckoutService (apps/api) remains the single source of truth.
// This exists purely to bridge two facts that can't otherwise meet: the
// cart lives in localStorage, so the browser must submit checkout itself
// (see lib/api-client.ts's submitCheckoutFromBrowser), but the customer
// session lives in an httpOnly cookie the browser can never read. This
// route runs server-side, where the cookie IS readable, and forwards the
// request to the real API with Authorization attached only when a session
// cookie is present — omitted entirely for a signed-out visitor, so guest
// checkout reaches the API exactly as before this slice. The response is
// passed through unchanged (status and body) in either case.
//
// SC4f-2 — `?as=guest`: a signed-in login that has NOT joined this restaurant
// may choose to order as a guest instead. That choice is honoured only after
// the API confirms CUSTOMER_NOT_ENROLLED; a login with a profile here —
// active, restricted or deactivated — never silently falls back to guest
// checkout (it gets 409 GUEST_CHECKOUT_NOT_ALLOWED).
export async function POST(request: NextRequest): Promise<NextResponse> {
  const untrusted = rejectUntrustedOrigin(request);
  if (untrusted) return untrusted as NextResponse;

  let token = request.cookies.get(CUSTOMER_SESSION_COOKIE)?.value;
  const body = await request.text();

  if (token && request.nextUrl.searchParams.get("as") === "guest") {
    let me: Response;
    try {
      me = await storefrontApiFetch(`${getApiUrl()}/customers/me`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
    } catch {
      return NextResponse.json(
        { message: "Could not check your account. Please try again." },
        { status: 503 },
      );
    }
    const meBody = (await me.json().catch(() => null)) as {
      code?: unknown;
    } | null;
    const notEnrolled =
      me.status === 403 && meBody?.code === CUSTOMER_NOT_ENROLLED;
    // Fail closed in every other case, but say what actually happened: an
    // expired sign-in must sign in again (never order as a guest with it).
    if (me.status === 401) {
      return NextResponse.json(
        {
          code: SESSION_EXPIRED,
          message: "Your sign-in has expired. Sign in again to continue.",
        },
        { status: 401 },
      );
    }
    if (!notEnrolled && !me.ok && me.status !== 403) {
      return NextResponse.json(
        { message: "Could not check your account. Please try again." },
        { status: 503 },
      );
    }
    if (!notEnrolled) {
      return NextResponse.json(
        {
          code: GUEST_CHECKOUT_NOT_ALLOWED,
          message:
            "You're signed in to your account at this restaurant. Sign out to order as a guest.",
        },
        { status: 409 },
      );
    }
    token = undefined;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...signedClientIpHeaders(request.headers),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await storefrontApiFetch(`${getApiUrl()}/orders`, {
      method: "POST",
      headers,
      body,
    });
  } catch {
    return NextResponse.json(
      { message: "Could not reach the server." },
      { status: 503 },
    );
  }

  const responseBody = await response.text();
  const result = new NextResponse(responseBody, {
    status: response.status,
    headers: passthroughHeaders(response),
  });

  // R1 / S3c — a placed order starts the guest tracking session HERE, on the
  // server: the access token goes into the HttpOnly guest-session cookie so the
  // confirmation URL never needs to carry it. (The response body is unchanged,
  // so existing clients keep working.)
  if (response.ok) {
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
  return result;
}
