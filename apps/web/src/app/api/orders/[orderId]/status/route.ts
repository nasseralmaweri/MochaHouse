import { NextRequest, NextResponse } from "next/server";
import {
  NOT_FOUND_BODY,
  NO_STORE_JSON,
  fetchGuestOrderStatus,
} from "@/lib/guest-order-api";
import { passthroughHeaders } from "@/lib/rate-limit-message";
import {
  GUEST_SESSION_COOKIE,
  parseGuestSession,
  tokenForOrder,
} from "@/lib/security/guest-session";

// Guest order-status poll (R1 / S3c). The browser asks for
// /api/orders/<orderId>/status with no credential in the URL; the access token
// comes from the HttpOnly guest-session cookie, and only for THIS order id.
// Everything that is not a usable credential for this order (no cookie, no
// entry for this order, token rejected by the API, unknown order) answers the
// same 404, so nothing about other orders is revealed. Read-only (GET), so no
// request-origin check is needed; the response is never cached.

type RouteContext = { params: Promise<{ orderId: string }> };

const notFound = () =>
  new NextResponse(NOT_FOUND_BODY, { status: 404, headers: NO_STORE_JSON });

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const { orderId } = await context.params;
  const token = tokenForOrder(
    parseGuestSession(request.cookies.get(GUEST_SESSION_COOKIE)?.value),
    orderId,
  );
  if (!token) return notFound();

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

  const body = await response.text();
  return new NextResponse(body, {
    status: response.ok || response.status === 429 ? response.status : 502,
    headers: {
      ...passthroughHeaders(response),
      "Cache-Control": "no-store",
    },
  });
}
