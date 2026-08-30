import { NextRequest, NextResponse } from "next/server";
import { INTERNAL_SESSION_COOKIE } from "@/lib/internal-auth/session";

// Server-side proxy for the internal Admin API, mirroring the pattern of
// app/api/checkout/route.ts. It exists purely to bridge one gap: the Admin
// pages run in the browser (a location-picker driven queue), but the
// internal session lives in an HttpOnly cookie the browser can never read.
// This route runs server-side, where the cookie IS readable, reads it, and
// forwards the request to the real API with Authorization attached. The
// internal bearer token is therefore never exposed to client-side JS.
//
//   /api/internal/admin/<path><query>  ->  <API_URL>/admin/<path><query>
//
// No admin logic of its own — the API's controllers/services remain the
// single source of truth, and InternalAuthGuard on the API still does the
// real authentication + lifecycle enforcement. This route only fails fast
// with 401 when there is no cookie at all, to save a round trip.

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;

  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }

  return apiUrl;
}

const FORWARDED_METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);

async function proxy(
  request: NextRequest,
  segments: string[],
): Promise<NextResponse> {
  if (!FORWARDED_METHODS.has(request.method)) {
    return NextResponse.json(
      { message: "Method not allowed." },
      { status: 405 },
    );
  }

  const token = request.cookies.get(INTERNAL_SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json(
      { message: "Authentication required." },
      { status: 401 },
    );
  }

  const path = segments.map(encodeURIComponent).join("/");
  const search = request.nextUrl.search;
  const target = `${getApiUrl()}/admin/${path}${search}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  const hasBody = request.method !== "GET" && request.method !== "DELETE";
  const body = hasBody ? await request.text() : undefined;
  if (hasBody) {
    headers["Content-Type"] =
      request.headers.get("content-type") ?? "application/json";
  }

  let response: Response;
  try {
    response = await fetch(target, {
      method: request.method,
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
    headers: {
      "Content-Type":
        response.headers.get("content-type") ?? "application/json",
    },
  });
}

type RouteContext = { params: Promise<{ path?: string[] }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const { path = [] } = await context.params;
  return proxy(request, path);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { path = [] } = await context.params;
  return proxy(request, path);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { path = [] } = await context.params;
  return proxy(request, path);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { path = [] } = await context.params;
  return proxy(request, path);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { path = [] } = await context.params;
  return proxy(request, path);
}
