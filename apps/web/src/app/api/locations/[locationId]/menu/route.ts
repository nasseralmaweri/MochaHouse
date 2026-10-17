import { NextRequest, NextResponse } from "next/server";
import { storefrontApiFetch } from "@/lib/storefront-context";

// SC4f-1 — same-origin proxy for the cart's menu revalidation
// (getLocationMenuFromBrowser). The cart lives in localStorage, so it must
// re-check prices from the browser; it used to call the API directly, which
// left the API unable to tell which storefront asked. Now the browser calls
// this route and the web server forwards it with the signed storefront
// context of the address the shopper is on, so the prices are always that
// business's — never another's. A read with no session and no body: it
// forwards nothing from the browser but the location id.

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

const LOCATION_ID = /^[A-Za-z0-9-]{1,64}$/;

type RouteContext ={ params: Promise<{ locationId: string }> };

export async function GET(
  _request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const { locationId } = await context.params;
  // Only an id-shaped value is forwarded (never "." / ".." or other path
  // pieces that would change the API path).
  if (!LOCATION_ID.test(locationId)) {
    return NextResponse.json(
      { message: "Unknown location." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  // Outside the try: a missing setting is a deployment error, not an outage.
  const target = `${getApiUrl()}/locations/${locationId}/menu`;

  let response: Response;
  try {
    response = await storefrontApiFetch(target, { cache: "no-store" });
  } catch (error) {
    // fetch() reports an unreachable server as a TypeError; anything else
    // (such as a missing storefront secret) is a deployment error.
    if (!(error instanceof TypeError)) throw error;
    return NextResponse.json(
      { message: "Could not reach the server." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const responseBody = await response.text();
  return new NextResponse(responseBody, {
    status: response.status,
    headers: {
      "Content-Type": "application/json",
      // One business's prices: never stored by a shared cache.
      "Cache-Control": "no-store",
    },
  });
}
