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

// Milestone 7H — server-side proxy for a customer gift-card purchase,
// mirroring app/api/checkout/route.ts. The purchase form runs in the
// browser (it generates its own idempotencyKey), but the customer session
// is an httpOnly cookie the browser can't read. This route runs
// server-side: it attaches Authorization ONLY when a session cookie is
// present (guests are allowed — the purchase is simply not linked to a
// customer) and forwards the request unchanged to the real API.
// GiftCardPurchaseService remains the single source of truth; the response
// (which may carry the one-time full code) is passed straight through.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(CUSTOMER_SESSION_COOKIE)?.value;
  const body = await request.text();

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/gift-cards/purchase`, {
      method: "POST",
      headers,
      body,
      cache: "no-store",
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
