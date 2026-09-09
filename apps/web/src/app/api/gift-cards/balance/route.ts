import { NextRequest, NextResponse } from "next/server";

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

// Milestone 7H — server-side proxy for the public gift-card balance lookup.
// The code travels ONLY in the POST body (never a URL / query string), so
// this route forwards the body verbatim and passes the masked response
// through unchanged. No session cookie is attached: the lookup is public
// and returns nothing customer-specific. GiftCardBalanceService is
// authoritative.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.text();

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/gift-cards/balance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
