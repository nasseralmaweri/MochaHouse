// R1 / S3a — what the web app tells a visitor, and passes on, when the API
// answers 429 Too Many Requests.

export const TOO_MANY_ATTEMPTS_MESSAGE =
  "Too many attempts. Please wait a few minutes and try again.";

// The headers a proxy route returns for an upstream response. Always the JSON
// content type; for a 429 also the API's Retry-After, so clients and
// browsers can honour it.
export function passthroughHeaders(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (upstream.status === 429) {
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter && /^\d{1,6}$/.test(retryAfter)) {
      headers["Retry-After"] = retryAfter;
    }
  }
  return headers;
}
