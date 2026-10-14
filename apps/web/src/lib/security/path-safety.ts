// Path safety for catch-all proxies (R1 / S3b).
//
// A proxy that rebuilds `<apiBase>/admin/<segments>` must never let a caller
// steer the request to another part of the API. The WHATWG URL parser
// collapses `..` and `.` segments (and their %2e forms), so
// `/api/v1/admin/../internal/me` would silently become `/api/v1/internal/me`.
// Segments are therefore rejected outright, after repeated decoding, if they
// could be read as navigation, and the final URL is verified to stay inside
// the permitted prefix.

const MAX_DECODE_ROUNDS = 4;

// Decodes until stable. null = malformed escape or still changing after the
// bounded number of rounds (treated as hostile).
function fullyDecode(segment: string): string | null {
  let current = segment;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  return null;
}

const FORBIDDEN_CHARACTERS = new RegExp("[/\\\\\\u0000-\\u001f\\u007f;]");
const ONLY_DOTS_OR_SPACE = new RegExp("^[.\\s]+$");

export function isSafeProxySegment(segment: string): boolean {
  if (segment.length === 0) return false;
  const decoded = fullyDecode(segment);
  if (decoded === null) return false;
  if (decoded === "." || decoded === "..") return false;
  // No separators, backslashes (some layers treat them as "/"), semicolons
  // (path-parameter tricks), control characters or NUL, in any decoding.
  if (FORBIDDEN_CHARACTERS.test(decoded)) return false;
  // Dots and whitespace only: may be trimmed or normalised by another layer.
  if (ONLY_DOTS_OR_SPACE.test(decoded)) return false;
  return true;
}

export function areSafeProxySegments(segments: readonly string[]): boolean {
  return segments.length > 0 && segments.every(isSafeProxySegment);
}

// Builds `<base>/<prefix>/<segments>` + search, or null when the segments are
// unsafe or the resulting URL is not strictly under `<base path>/<prefix>/`
// on the same origin.
export function buildProxyTarget(
  apiBase: string,
  prefix: string,
  segments: readonly string[],
  search: string,
): string | null {
  if (!areSafeProxySegments(segments)) return null;
  let base: URL;
  try {
    base = new URL(apiBase);
  } catch {
    return null;
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  const allowedPrefix = `${basePath}/${prefix}/`;
  const raw = `${apiBase.replace(/\/+$/, "")}/${prefix}/${segments
    .map(encodeURIComponent)
    .join("/")}${search}`;
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return null;
  }
  if (target.origin !== base.origin) return null;
  if (!target.pathname.startsWith(allowedPrefix)) return null;
  if (target.pathname.length <= allowedPrefix.length) return null;
  return target.toString();
}
