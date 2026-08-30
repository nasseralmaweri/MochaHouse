import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { isDevInternalAuthEnabled } from './internal-auth-provider-mode';
import { InternalCognitoTokenVerifier } from './internal-cognito-token-verifier';
import { InternalLocalDevTokenVerifier } from './internal-local-dev-token-verifier';
import { extractInternalBearerToken } from './internal-bearer-token';
import type {
  InternalAuthenticatedRequest,
  InternalIdentity,
} from './internal-identity';
import { InternalUsersService } from '../application/internal-users.service';

// The internal-authentication + lifecycle boundary for every internal/Admin
// route. Completely separate from the customer boundary (CustomerAuthGuard):
// it reads no customer cookie or header contract, never sets
// request.customerIdentity, and a customer token — Cognito or dev — cannot
// pass it (different pool/audience in production; different secret and a
// mandatory internal marker claim for the dev provider).
//
// A valid external token is necessary but NOT sufficient. The required
// sequence, every request:
//   1. Extract the Bearer token (missing -> 401).
//   2. Verify it against the INTERNAL provider (dev or Cognito, chosen
//      per-request, fail-closed) (invalid/expired -> 401).
//   3. Build the provider-neutral InternalIdentity.
//   4. Resolve it to an EXISTING Mocha House InternalUser (never JIT-create).
//   5. Require InternalUser.status === ACTIVE. Unknown identity, INVITED,
//      SUSPENDED and DISABLED all collapse to the same generic 403.
//   6. Attach { internalIdentity, internalUser } to the request.
//   7. Continue.
@Injectable()
export class InternalAuthGuard implements CanActivate {
  constructor(
    private readonly cognitoVerifier: InternalCognitoTokenVerifier,
    private readonly localDevVerifier: InternalLocalDevTokenVerifier,
    private readonly internalUsers: InternalUsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<InternalAuthenticatedRequest>();

    const token = extractInternalBearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException('Authentication required.');
    }

    const verifier = isDevInternalAuthEnabled()
      ? this.localDevVerifier
      : this.cognitoVerifier;

    let identity: InternalIdentity;
    try {
      identity = await verifier.verify(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired authentication.');
    }

    const resolution =
      await this.internalUsers.resolveForAuthentication(identity);

    if (resolution.outcome !== 'active') {
      // Unknown identity / INVITED / SUSPENDED / DISABLED — one generic
      // message, so the response never distinguishes "no such internal
      // user" from "your account is not active".
      throw new ForbiddenException(
        'This account is not permitted to access the internal area.',
      );
    }

    request.internalIdentity = identity;
    request.internalUser = resolution.user;
    return true;
  }
}
