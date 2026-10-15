// Guest tracking links (R1 / S3c). Pure helpers, usable in the browser.
//
// Ordinary tracking URLs are credential-free: /order/confirmation/<orderId>.
// Two older/shared forms still carry a credential and are converted on arrival:
//   - legacy:  /order/confirmation/<orderId>?token=<token>   (sent to servers)
//   - shared:  /order/confirmation/<orderId>#t=<token>       (a fragment is never
//              sent to any server and never appears in a Referer)

import { isValidAccessToken } from "@/lib/security/guest-session";

export function extractLinkCredential(
  search: string,
  hash: string,
): string | null {
  const fromFragment = new URLSearchParams(hash.replace(/^#/, "")).get("t");
  if (isValidAccessToken(fromFragment)) return fromFragment;
  const fromQuery = new URLSearchParams(search).get("token");
  if (isValidAccessToken(fromQuery)) return fromQuery;
  return null;
}

// True when the URL carries anything that should be removed from history, even
// if it was not a usable credential (a malformed ?token= must not linger).
export function hasCredentialParams(search: string, hash: string): boolean {
  return (
    new URLSearchParams(search).has("token") ||
    new URLSearchParams(hash.replace(/^#/, "")).has("t")
  );
}

export function buildShareUrl(
  origin: string,
  orderId: string,
  token: string,
): string {
  return `${origin}/order/confirmation/${encodeURIComponent(orderId)}#t=${encodeURIComponent(token)}`;
}
