import {
  CanActivate,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { createTenantContext } from '@mocha-house/database';
import { InternalCognitoTokenVerifier } from './internal-cognito-token-verifier';
import { InternalLocalDevTokenVerifier } from './internal-local-dev-token-verifier';
import type { InternalAuthenticatedRequest } from './internal-identity';
import { InternalUsersService } from '../application/internal-users.service';
import { InternalTenantMembershipService } from '../application/internal-tenant-membership.service';
import type { TenantContextRequest } from '../../tenancy/tenant-context-request';
import {
  ACTIVE_TENANT_HEADER,
  readRequestedTenantId,
} from './active-tenant-header';
import { verifyInternalBearer } from './verify-internal-bearer';

export const BUSINESS_SELECTION_REQUIRED = 'BUSINESS_SELECTION_REQUIRED';

const NOT_PERMITTED =
  'This account is not permitted to access the internal area.';

// The internal-authentication + tenant-resolution + lifecycle boundary for
// every internal/Admin route. Completely separate from the customer
// boundary (CustomerAuthGuard): it reads no customer cookie or header
// contract, never sets request.customerIdentity, and a customer token —
// Cognito or dev — cannot pass it (different pool/audience in production;
// different secret and a mandatory internal marker claim for the dev
// provider).
//
// Milestone S0F — this guard is now the ONLY source of an Admin request's
// TenantContext (TenantContextMiddleware no longer runs on member routes,
// so SINGLE_TENANT_ID never stands in for an administrator's business).
// The chain is deliberately one-directional, so it can never become
// "need the tenant to authenticate / need the user to pick the tenant":
//   1. Extract + verify the Bearer token against the INTERNAL provider —
//      needs no tenant (missing/invalid/expired -> 401).
//   2. Read the requested business (X-Tenant-Id) as INTENT only
//      (malformed -> 400).
//   3. From the verified identity alone, find the businesses it may enter
//      (ACTIVE membership in an ACTIVE tenant) and choose the active one:
//      the requested business only if it is one of them; with no request,
//      the single enterable business. Anything else -> the generic 403
//      (or 409 BUSINESS_SELECTION_REQUIRED when several are enterable and
//      none was chosen).
//   4. Re-resolve the InternalUser INSIDE that tenant (never JIT-create;
//      ACTIVE required; INVITED/SUSPENDED/DISABLED/unknown -> the same 403).
//   5. Build the TenantContext (principalType 'member') for that tenant and
//      attach { tenantContext, internalIdentity, internalUser }.
// PermissionGuard / AuthorizationService then evaluate grants strictly
// inside this TenantContext.
@Injectable()
export class InternalAuthGuard implements CanActivate {
  constructor(
    private readonly cognitoVerifier: InternalCognitoTokenVerifier,
    private readonly localDevVerifier: InternalLocalDevTokenVerifier,
    private readonly internalUsers: InternalUsersService,
    private readonly memberships: InternalTenantMembershipService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<InternalAuthenticatedRequest & TenantContextRequest>();

    // RequestIdMiddleware runs on every route; its absence is a server
    // misconfiguration, never a client input.
    if (!request.requestId) {
      throw new InternalServerErrorException(
        'Request id is not established for this request.',
      );
    }

    const identity = await verifyInternalBearer(request.headers.authorization, {
      cognito: this.cognitoVerifier,
      localDev: this.localDevVerifier,
    });

    const requestedTenantId = readRequestedTenantId(
      request.headers[ACTIVE_TENANT_HEADER],
    );

    const selection = await this.memberships.selectActiveTenant(
      identity,
      requestedTenantId,
    );
    if (selection.outcome === 'selection-required') {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: BUSINESS_SELECTION_REQUIRED,
        message: `Select a business (${ACTIVE_TENANT_HEADER}) to continue.`,
      });
    }
    if (selection.outcome !== 'selected') {
      // Not a member, membership not ACTIVE, tenant not ACTIVE, no such
      // tenant, or no business at all — one generic message, so a caller
      // can never probe which tenants exist or why it was refused.
      throw new ForbiddenException(NOT_PERMITTED);
    }

    const resolution = await this.internalUsers.resolveForAuthentication(
      identity,
      selection.tenantId,
    );
    if (resolution.outcome !== 'active') {
      throw new ForbiddenException(NOT_PERMITTED);
    }

    request.tenantContext = createTenantContext({
      tenantId: resolution.user.tenantId,
      principalType: 'member',
      requestId: request.requestId,
    });
    request.internalIdentity = identity;
    request.internalUser = resolution.user;
    return true;
  }
}
