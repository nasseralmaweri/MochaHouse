import { NextResponse, type NextRequest } from "next/server";
import { withoutPaymentReturnParams } from "@/lib/checkout/stripe-payment";

// SC3c-1 — tells the admin layout which page is being rendered, so a
// business in a billing wind-down is redirected on the server before a
// paused page renders. It only forwards the path (any client-sent value is
// overwritten); it makes no access decision — the API enforces access.
//
// ESP-04 M3b — a customer returning to checkout from a Stripe bank
// authentication arrives with Stripe's parameters (the payment's client
// secret among them) in the query string. They are removed HERE, before any
// page renders, with a 303 to the same page without them: the secret never
// reaches a rendered document, its scripts or a Referer. Nothing reads them
// (the checkout session resumes the payment and the server says where it
// stands); the page removes any that remain, too.
export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/order/checkout") {
    const cleaned = withoutPaymentReturnParams(request.nextUrl.href);
    if (cleaned === null) return NextResponse.next();
    const response = NextResponse.redirect(new URL(cleaned, request.url), 303);
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  const headers = new Headers(request.headers);
  headers.set("x-admin-pathname", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/admin", "/admin/:path*", "/order/checkout"],
};
