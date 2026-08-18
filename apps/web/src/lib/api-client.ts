import type { LocationMenuResponse } from "@mocha-house/contracts";
import { parseLocationMenuResponse } from "@/lib/menu";

// Browser-safe counterpart to lib/api.ts's getLocationMenu. The cart lives
// in localStorage (browser-only), so /order/cart must revalidate it
// directly from the client — Server Components can't read localStorage.
// This is the one ordering screen with a genuine client-side fetch need;
// every other screen fetches server-side via lib/api.ts's server-only
// API_URL. See apps/web/.env.example.
function getPublicApiUrl(): string {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;

  if (!apiUrl) {
    throw new Error(
      "NEXT_PUBLIC_API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }

  return apiUrl;
}

export async function getLocationMenuFromBrowser(
  locationId: string,
): Promise<LocationMenuResponse | null> {
  const response = await fetch(
    `${getPublicApiUrl()}/locations/${locationId}/menu`,
  );

  if (!response.ok) {
    throw new Error(`Failed to load location menu (${response.status}).`);
  }

  return parseLocationMenuResponse(response);
}
