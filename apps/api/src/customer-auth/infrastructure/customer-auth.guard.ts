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

// The customer-authentication boundary: verifies a Bearer token and
// attaches the resulting CustomerIdentity to the request, or rejects the
// request outright. This is the only place Cognito-vs-dev mechanics are
// chosen (see isDevCustomerAuthEnabled) — everything downstream (the
// customers module, controllers) only ever sees the provider-neutral
// CustomerIdentity, never a raw token or Cognito payload.
//
// Every failure — missing header, malformed token, expired token, invalid
// signature, unknown issuer — collapses to the same generic 401. Customer
// authentication is intentionally a separate boundary from internal/Admin
// authentication (see internal-auth/infrastructure/internal-auth.guard.ts)
// and must never be applied to admin/store routes.
@Injectable()
export class CustomerAuthGuard implements CanActivate {
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
      throw new UnauthorizedException('Authentication required.');
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
