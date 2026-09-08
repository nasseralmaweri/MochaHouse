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

// Milestone 7E — server-side proxy for the unified checkout pricing quote,
// mirroring app/api/checkout/route.ts. The cart lives in localStorage so the
// browser must ask for the quote itself, but the customer session is an
// httpOnly cookie the browser can't read. This route runs server-side,
// attaches the session cookie when present (guests are allowed — they just
// get no rewards), and forwards to the real API. CheckoutService remains
// the single source of pricing truth.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(CUSTOMER_SESSION_COOKIE)?.value;
  const body = await request.text();

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/orders/checkout-quote`, {
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
