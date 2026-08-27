// Shared by CustomerAuthGuard (mandatory) and OptionalCustomerAuthGuard
// (best-effort) so the two never drift on what counts as "a bearer token
// was presented" — only on what to do when there isn't one / it's invalid.
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return null;
  }
  return token;
}
