import { NextRequest, NextResponse } from "next/server";
import {
  NOT_FOUND_BODY,
  NO_STORE_JSON,
  fetchGuestOrderStatus,
} from "@/lib/guest-order-api";
import { passthroughHeaders } from "@/lib/rate-limit-message";
import { rejectUntrustedOrigin } from "@/lib/security/request-origin";
import {
  guestSessionCookieOptions,
  isValidAccessToken,
  isValidOrderId,
  GUEST_SESSION_COOKIE,
  parseGuestSession,
  serializeGuestSession,
  withGuestOrder,
} from "@/lib/security/guest-session";

// Bootstraps a guest tracking session (R1 / S3c) from a credential the visitor
// arrived with: a legacy ?token= link or a shared #t= fragment link. The token
// is sent in the POST body (never a URL), is VERIFIED against the API for this
// exact order before anything is stored, and is then kept only in the HttpOnly
// cookie. A wrong token, an unknown order, or a malformed value all answer the
// same 404 and set nothing, so this cannot be used to plant a cookie or to
// learn whether an order exists. Attempts count against the API's per-IP
// unsuccessful-lookup limit like any other guess.

type RouteContext = { params: Promise<{ orderId: string }> };

const notFound = () =>
  new NextResponse(NOT_FOUND_BODY, { status: 404, headers: NO_STORE_JSON });

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const untrusted = rejectUntrustedOrigin(request);
  if (untrusted) return untrusted as NextResponse;

  const { orderId } = await context.params;

  let token: unknown;
  try {
    token = ((await request.json()) as { token?: unknown } | null)?.token;
  } catch {
    return notFound();
  }
  if (!isValidOrderId(orderId) || !isValidAccessToken(token)) return notFound();

  let response: Response;
  try {
    response = await fetchGuestOrderStatus(orderId, token, request.headers);
  } catch {
    return NextResponse.json(
      { message: "Could not reach the server." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (response.status === 404) return notFound();
  if (!response.ok) {
    return new NextResponse(await response.text(), {
      status: response.status === 429 ? 429 : 502,
      headers: {
        ...passthroughHeaders(response),
        "Cache-Control": "no-store",
      },
    });
  }

  const result = new NextResponse(JSON.stringify({ ok: true }), {
    status: 200,
    headers: NO_STORE_JSON,
  });
  const current = parseGuestSession(
    request.cookies.get(GUEST_SESSION_COOKIE)?.value,
  );
  result.cookies.set(
    GUEST_SESSION_COOKIE,
    serializeGuestSession(withGuestOrder(current, orderId, token)),
    guestSessionCookieOptions(),
  );
  return result;
}
