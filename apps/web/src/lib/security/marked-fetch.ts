import {
  REQUEST_MARKER_HEADER,
  REQUEST_MARKER_VALUE,
} from "./request-origin";

// fetch() for this app's own /api proxy routes (R1 / S3b): adds the custom
// request header that rejectUntrustedOrigin() requires on state-changing calls.
// Only same-origin relative "/api/" URLs are touched, so a request to any other
// host never carries the marker. Safe methods are left alone.
//
// Pure module (no `server-only`): it runs in the browser.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isOwnApiUrl(input: RequestInfo | URL): boolean {
  return typeof input === "string" && input.startsWith("/api/");
}

export function markedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  if (!isOwnApiUrl(input) || SAFE_METHODS.has(method)) {
    return fetch(input, init);
  }
  const headers = new Headers(init?.headers);
  headers.set(REQUEST_MARKER_HEADER, REQUEST_MARKER_VALUE);
  return fetch(input, { ...init, headers });
}
