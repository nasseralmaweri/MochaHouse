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

// Milestone 7H — server-side proxy for step 1 of the two-step gift-card
// purchase (establish the PENDING purchase, mint a guest's recovery
// credential, NO charge). Mirrors app/api/gift-cards/purchase/route.ts: the
// form runs in the browser but the customer session is an httpOnly cookie,
// so this route attaches Authorization only when a session cookie is present
// (guests allowed) and forwards the request unchanged. The one-time
// recoveryCredential in the response is passed straight through to the
// client, which keeps it in memory only.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(CUSTOMER_SESSION_COOKIE)?.value;
  const body = await request.text();

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/gift-cards/purchase-intents`, {
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
