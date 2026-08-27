import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { isDevCustomerAuthEnabled } from './auth-provider-mode';
import { CognitoTokenVerifier } from './cognito-token-verifier';
import { LocalDevTokenVerifier } from './local-dev-token-verifier';
import { extractBearerToken } from './bearer-token';
import type { CustomerAuthenticatedRequest } from './customer-identity';

// Best-effort counterpart to CustomerAuthGuard, for routes where signing in
// is optional (checkout: guest ordering must keep working with no account
// at all). "Optional" means authentication is not *required* — it does
// not mean a token that was actually presented gets a pass if it's wrong:
//   - no Authorization header at all -> proceeds as anonymous (no
//     customerIdentity set) — this is the only case treated as a guest.
//   - a header that verifies successfully -> customerIdentity is attached,
//     exactly as CustomerAuthGuard would.
//   - a header present but malformed/invalid/tampered/expired -> rejected
//     with the same generic 401 CustomerAuthGuard would use. Silently
//     downgrading an explicitly-presented bad token to "guest" would let a
//     customer's order vanish from their own history the moment their
//     session expires mid-checkout, with no indication anything went
//     wrong — worse than failing loudly.
// Uses the same per-request Cognito-vs-dev selection as CustomerAuthGuard
// (see isDevCustomerAuthEnabled) — this is the only place that decision is
// made, never duplicated inside checkout itself.
@Injectable()
export class OptionalCustomerAuthGuard implements CanActivate {
  constructor(
    private readonly cognitoVerifier: CognitoTokenVerifier,
    private readonly localDevVerifier: LocalDevTokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<CustomerAuthenticatedRequest>();

    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      return true;
    }

    const verifier = isDevCustomerAuthEnabled()
      ? this.localDevVerifier
      : this.cognitoVerifier;

    try {
      request.customerIdentity = await verifier.verify(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired authentication.');
    }

    return true;
  }
}
