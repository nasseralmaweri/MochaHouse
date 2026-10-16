import { NextResponse, type NextRequest } from "next/server";

// SC3c-1 — tells the admin layout which page is being rendered, so a
// business in a billing wind-down is redirected on the server before a
// paused page renders. It only forwards the path (any client-sent value is
// overwritten); it makes no access decision — the API enforces access.
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-admin-pathname", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};
