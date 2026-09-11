import { NextRequest, NextResponse } from "next/server";

// Milestone 8D — same-origin proxy for a public, anonymous franchise
// inquiry, mirroring app/api/careers/[jobId]/apply/route.ts. The inquiry
// form runs in the browser; this route forwards the request unchanged to
// the real API. There is no session and no Authorization header — an
// inquiry is never linked to an account. FranchiseInquiriesPublicService
// remains the single source of truth: it validates every field and returns
// only { ok: true }. The API also applies its own ~5/min per-IP throttle.

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.text();

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/franchising/inquiries`, {
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
