import { NextRequest, NextResponse } from "next/server";
import { CUSTOMER_SESSION_COOKIE } from "@/lib/auth/session";

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
export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(CUSTOMER_SESSION_COOKIE)?.value;
  const body = await request.text();

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/orders`, {
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
  return new NextResponse(responseBody, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}
