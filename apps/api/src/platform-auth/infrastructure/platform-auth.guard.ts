import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PlatformOperatorsService } from '../application/platform-operators.service';
import { isDevPlatformAuthEnabled } from './platform-auth-provider-mode';
import { PlatformAuthNotConfiguredError } from './platform-config';
import type {
  PlatformAuthenticatedRequest,
  PlatformIdentity,
} from './platform-identity';
import {
  PlatformCognitoTokenVerifier,
  PlatformLocalDevTokenVerifier,
} from './platform-token-verifiers';

const NOT_PERMITTED =
  'This account is not permitted to access the platform area.';

// SC1a — the ONLY gate in front of /api/v1/platform/*. Completely separate
// from the customer (CustomerAuthGuard) and tenant-staff (InternalAuthGuard)
// boundaries: it reads no customer or staff token contract, no tenant header
// (X-Tenant-Id is never read here), never sets a TenantContext, and consults
// no tenant membership or tenant role — a tenant's "platform-administrator"
// role means nothing here.
//
//   1. Bearer token, verified against the PLATFORM provider only (dedicated
//      Cognito pool, or the dev provider in a verified safe context).
//      Missing / malformed / wrong pool or audience / expired / no MFA
//      -> 401. Platform auth not configured -> 503 (fail closed).
//   2. Re-read the PlatformOperator for the verified (provider, subject) on
//      EVERY request: unknown or DISABLED -> the same generic 403 (and an
//      audit event). Only ACTIVE passes.
@Injectable()
export class PlatformAuthGuard implements CanActivate {
  constructor(
    private readonly cognitoVerifier: PlatformCognitoTokenVerifier,
    private readonly localDevVerifier: PlatformLocalDevTokenVerifier,
    private readonly operators: PlatformOperatorsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<PlatformAuthenticatedRequest>();
    if (!request.requestId) {
      throw new InternalServerErrorException(
        'Request id is not established for this request.',
      );
    }

    const identity = await this.verify(request.headers.authorization);

    const resolution = await this.operators.resolve(identity);
    if (resolution.outcome !== 'active') {
      await this.operators.recordDenied(
        identity,
        resolution,
        request.requestId,
      );
      throw new ForbiddenException(NOT_PERMITTED);
    }

    request.platformIdentity = identity;
    request.platformOperator = resolution.operator;
    return true;
  }

  private async verify(
    authorizationHeader: string | undefined,
  ): Promise<PlatformIdentity> {
    const token = extractPlatformBearerToken(authorizationHeader);
    if (!token) {
      throw new UnauthorizedException('Authentication required.');
    }
    const verifier = isDevPlatformAuthEnabled()
      ? this.localDevVerifier
      : this.cognitoVerifier;
    try {
      return await verifier.verify(token);
    } catch (error) {
      if (error instanceof PlatformAuthNotConfiguredError) {
        // Configuration detail stays server-side.
        throw new ServiceUnavailableException(
          'Platform authentication is not available.',
        );
      }
      throw new UnauthorizedException('Invalid or expired authentication.');
    }
  }
}

// A separate copy of the Bearer parsing on purpose (the boundaries share no
// code path — see internal-bearer-token.ts).
export function extractPlatformBearerToken(
  header: string | undefined,
): string | null {
  if (!header) {
    return null;
  }
  const [scheme, token, extra] = header.split(' ');
  if (scheme !== 'Bearer' || !token || extra !== undefined) {
    return null;
  }
  return token;
}
