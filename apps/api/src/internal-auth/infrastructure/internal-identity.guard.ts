import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { InternalCognitoTokenVerifier } from './internal-cognito-token-verifier';
import { InternalLocalDevTokenVerifier } from './internal-local-dev-token-verifier';
import type { InternalAuthenticatedRequest } from './internal-identity';
import { verifyInternalBearer } from './verify-internal-bearer';

// Milestone S0F — authenticates the internal caller WITHOUT choosing a
// business. Only for endpoints that must work before a business is active
// (GET /api/v1/internal/businesses, which populates the Business switcher).
//
// It attaches request.internalIdentity and nothing else: no internalUser,
// no tenantContext, no authorization. It is never sufficient for an Admin
// route — those use InternalAuthGuard, which additionally resolves and
// validates the active tenant membership.
@Injectable()
export class InternalIdentityGuard implements CanActivate {
  constructor(
    private readonly cognitoVerifier: InternalCognitoTokenVerifier,
    private readonly localDevVerifier: InternalLocalDevTokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<InternalAuthenticatedRequest>();

    request.internalIdentity = await verifyInternalBearer(
      request.headers.authorization,
      { cognito: this.cognitoVerifier, localDev: this.localDevVerifier },
    );
    return true;
  }
}
