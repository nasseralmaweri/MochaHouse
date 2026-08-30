// Extracts a Bearer token from an Authorization header, or null. Identical
// in behaviour to the customer boundary's extractBearerToken, but kept as a
// separate copy on purpose: the internal boundary shares no code path with
// the customer boundary, so a future change to one can never accidentally
// alter the other. It is eight lines of pure string parsing — the cost of
// the copy is lower than the cost of a cross-boundary import.
export function extractInternalBearerToken(
  header: string | undefined,
): string | null {
  if (!header) {
    return null;
  }
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return null;
  }
  return token;
}
