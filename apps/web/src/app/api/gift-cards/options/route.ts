import { NextResponse } from "next/server";

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

// Milestone 7H — server-side proxy for the public gift-card purchase
// options (preset amounts + custom-amount rules). No auth, no body; this
// route exists only so the browser page has a same-origin endpoint and the
// API base URL stays server-only. GiftCardConfigurationService is the
// single source of truth.
export async function GET(): Promise<NextResponse> {
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/gift-cards/purchase-options`, {
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { message: "Could not reach the server." },
      { status: 503 },
    );
  }

  const body = await response.text();
  return new NextResponse(body, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}
