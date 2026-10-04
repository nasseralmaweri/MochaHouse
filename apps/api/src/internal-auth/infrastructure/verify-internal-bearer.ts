import { UnauthorizedException } from '@nestjs/common';
import { isDevInternalAuthEnabled } from './internal-auth-provider-mode';
import type { InternalCognitoTokenVerifier } from './internal-cognito-token-verifier';
import type { InternalLocalDevTokenVerifier } from './internal-local-dev-token-verifier';
import { extractInternalBearerToken } from './internal-bearer-token';
import type { InternalIdentity } from './internal-identity';

// Milestone S0F — step one of the internal boundary, shared by
// InternalAuthGuard (identity + active business) and InternalIdentityGuard
// (identity only, for the business list). Proves WHO the caller is and
// nothing else: it needs no tenant, reads no InternalUser, and is therefore
// the non-circular starting point of the chain
//   verified identity -> memberships -> active tenant -> TenantContext.
//
// Missing/malformed token, and any verification failure, are one 401.
export async function verifyInternalBearer(
  authorizationHeader: string | undefined,
  verifiers: {
    cognito: InternalCognitoTokenVerifier;
    localDev: InternalLocalDevTokenVerifier;
  },
): Promise<InternalIdentity> {
  const token = extractInternalBearerToken(authorizationHeader);
  if (!token) {
    throw new UnauthorizedException('Authentication required.');
  }

  const verifier = isDevInternalAuthEnabled()
    ? verifiers.localDev
    : verifiers.cognito;

  try {
    return await verifier.verify(token);
  } catch {
    throw new UnauthorizedException('Invalid or expired authentication.');
  }
}
