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

// Milestone 7C — server-side proxy for the checkout reward-eligibility
// quote, mirroring app/api/checkout/route.ts. The cart lives in
// localStorage so the browser must ask for the quote itself, but the
// customer session is an httpOnly cookie the browser can't read. This route
// runs server-side, reads the cookie, and forwards `{ locationId, lines }`
// to the real API. A signed-out visitor has no rewards — no forward, an
// empty response.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(CUSTOMER_SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ balance: 0, rewards: [] });
  }

  const body = await request.text();

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/orders/reward-eligibility`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body,
      cache: "no-store",
    });
  } catch {
    // The quote is a nicety — never block checkout on it.
    return NextResponse.json({ balance: 0, rewards: [] });
  }

  if (response.status === 401) {
    // Session expired between page load and this call — treat as guest.
    return NextResponse.json({ balance: 0, rewards: [] });
  }

  const responseBody = await response.text();
  return new NextResponse(responseBody, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}
