import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { isDevCustomerAuthEnabled } from './auth-provider-mode';
import { CognitoTokenVerifier } from './cognito-token-verifier';
import { LocalDevTokenVerifier } from './local-dev-token-verifier';
import { extractBearerToken } from './bearer-token';
import type { CustomerAuthenticatedRequest } from './customer-identity';

// Best-effort counterpart to CustomerAuthGuard, for routes where signing in
// is optional (checkout: guest ordering must keep working with no account
// at all). This guard never rejects a request:
//   - no Authorization header -> proceeds as anonymous (no
//     customerIdentity set at all — indistinguishable from a guest today).
//   - a header that verifies successfully -> customerIdentity is attached,
//     exactly as CustomerAuthGuard would.
//   - a header present but invalid/expired/malformed -> the verification
//     failure is swallowed and the request still proceeds as anonymous. An
//     invalid or stale token must never be treated as an authenticated
//     customer, but it also must not block an otherwise-valid checkout —
//     the caller simply doesn't get their order associated with an account.
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
      // Swallowed by design — see class doc comment.
    }

    return true;
  }
}
