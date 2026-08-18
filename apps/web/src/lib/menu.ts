import type { LocationMenuResponse } from "@mocha-house/contracts";

// The API returns an empty 200 body (not JSON "null") when there is no
// effective menu for a location, so response.json() would throw — this
// safely handles both the empty-body and populated-JSON cases. Shared by
// the server-only and browser-safe API clients.
export async function parseLocationMenuResponse(
  response: Response,
): Promise<LocationMenuResponse | null> {
  const body = await response.text();
  return body ? (JSON.parse(body) as LocationMenuResponse) : null;
}
