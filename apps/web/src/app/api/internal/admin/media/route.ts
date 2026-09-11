import { NextRequest, NextResponse } from "next/server";
import { INTERNAL_SESSION_COOKIE } from "@/lib/internal-auth/session";

// Milestone 8F — a DEDICATED proxy for /api/v1/admin/media, sitting in
// front of the generic [...path] catch-all (see
// app/api/internal/admin/[...path]/route.ts) at the same path segment.
// The generic proxy reads every request body as text before forwarding it
// — safe for JSON, but it would corrupt a binary multipart image upload.
// POST here forwards the raw bytes (`request.arrayBuffer()`) and the
// original multipart Content-Type (boundary included) untouched. GET
// (list) has no body and behaves exactly like the generic proxy would.
//
// Other /admin/media/* routes (e.g. POST .../:id/deactivate) have an
// extra path segment and are NOT matched by this file, so Next.js falls
// through to the generic catch-all for those, unchanged.

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

function requireToken(request: NextRequest): string | null {
  return request.cookies.get(INTERNAL_SESSION_COOKIE)?.value ?? null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = requireToken(request);
  if (!token) {
    return NextResponse.json({ message: "Authentication required." }, { status: 401 });
  }

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/media${request.nextUrl.search}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ message: "Could not reach the server." }, { status: 503 });
  }

  const body = await response.text();
  return new NextResponse(body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") ?? "application/json",
    },
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = requireToken(request);
  if (!token) {
    return NextResponse.json({ message: "Authentication required." }, { status: 401 });
  }

  const contentType = request.headers.get("content-type");
  if (!contentType || !contentType.startsWith("multipart/form-data")) {
    return NextResponse.json(
      { message: "Expected a multipart/form-data upload." },
      { status: 400 },
    );
  }

  const bytes = await request.arrayBuffer();

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/media`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": contentType,
      },
      body: bytes,
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ message: "Could not reach the server." }, { status: 503 });
  }

  const body = await response.text();
  return new NextResponse(body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") ?? "application/json",
    },
  });
}
