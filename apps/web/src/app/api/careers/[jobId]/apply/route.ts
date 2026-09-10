import { NextRequest, NextResponse } from "next/server";

// Milestone 8C — same-origin proxy for a public, anonymous job application,
// mirroring app/api/gift-cards/purchase/route.ts. The apply form runs in the
// browser; this route forwards the request unchanged to the real API. There
// is no session and no Authorization header — an application is never linked
// to an account. JobApplicationsPublicService remains the single source of
// truth: it enforces the job's public visibility (a non-visible job is 404,
// never revealing its existence), validates every field, and returns only
// { ok: true }. The API also applies its own ~5/min per-IP throttle.

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

type RouteContext = { params: Promise<{ jobId: string }> };

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const { jobId } = await context.params;
  const body = await request.text();

  let response: Response;
  try {
    response = await fetch(
      `${getApiUrl()}/careers/jobs/${encodeURIComponent(jobId)}/applications`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        cache: "no-store",
      },
    );
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
