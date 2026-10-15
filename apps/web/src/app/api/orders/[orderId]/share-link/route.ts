import { NextRequest, NextResponse } from "next/server";
import { NOT_FOUND_BODY, NO_STORE_JSON } from "@/lib/guest-order-api";
import { rejectUntrustedOrigin } from "@/lib/security/request-origin";
import {
  GUEST_SESSION_COOKIE,
  parseGuestSession,
  tokenForOrder,
} from "@/lib/security/guest-session";

// Returns this browser's credential for ONE order so the customer can
// deliberately copy a link that opens on another device (R1 / S3c). It is the
// only place the token is handed back to page script, and only on an explicit
// user action (POST, origin-checked, never cached). The client puts it in a URL
// FRAGMENT (#t=...), which browsers never send to any server or in a Referer.

type RouteContext = { params: Promise<{ orderId: string }> };

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const untrusted = rejectUntrustedOrigin(request);
  if (untrusted) return untrusted as NextResponse;

  const { orderId } = await context.params;
  const token = tokenForOrder(
    parseGuestSession(request.cookies.get(GUEST_SESSION_COOKIE)?.value),
    orderId,
  );
  if (!token) {
    return new NextResponse(NOT_FOUND_BODY, {
      status: 404,
      headers: NO_STORE_JSON,
    });
  }
  return new NextResponse(JSON.stringify({ token }), {
    status: 200,
    headers: NO_STORE_JSON,
  });
}
