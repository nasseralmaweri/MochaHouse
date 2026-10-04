import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthorizationService } from './authorization.service';
import {
  isKnownPermissionKey,
  type InternalPermissionKey,
} from './permission-catalog';
import { REQUIRE_PERMISSION_METADATA } from './require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../infrastructure/internal-identity';
import type { TenantContextRequest } from '../../tenancy/tenant-context-request';

// The authorization layer, applied AFTER InternalAuthGuard:
//   @UseGuards(InternalAuthGuard, PermissionGuard)
//
// InternalAuthGuard has already proven the caller is an ACTIVE internal
// user and set request.internalUser. This guard then:
//   1. Requires request.internalUser (defense in depth — 403 if absent).
//   2. Reads the route's @RequirePermission metadata. No metadata under
//      this guard is a configuration error -> deny (fail closed).
//   3. Loads the user's effective AuthorizationContext (from role
//      assignments, never a role name).
//   4. Requires the permission to be held through a scope type the
//      permission actually allows (a LOCATION grant cannot satisfy a
//      CORPORATE-only permission).
//   5. Attaches request.authorization for the service layer, which does
//      the resource/location-specific checks.
//
// This guard never inspects a client-supplied locationId — that belongs to
// the service layer, together with the persisted-resource cross-check.
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorizationService: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<InternalAuthenticatedRequest & TenantContextRequest>();

    if (!request.internalUser) {
      throw new ForbiddenException('Internal authentication is required.');
    }

    // Milestone S0D-2E — the same trusted, server-resolved TenantContext
    // every other tenant-scoped write path reads via
    // @CurrentTenantContext(); here read directly since a guard runs
    // outside the param-decorator pipeline. TenantContextMiddleware runs
    // before every guard, so its absence is a server misconfiguration, not
    // a client input to validate.
    if (!request.tenantContext) {
      throw new InternalServerErrorException(
        'Tenant context is not established for this request.',
      );
    }

    const required = this.reflector.getAllAndOverride<
      InternalPermissionKey | undefined
    >(REQUIRE_PERMISSION_METADATA, [context.getHandler(), context.getClass()]);

    if (!required || !isKnownPermissionKey(required)) {
      // A route wired through PermissionGuard with no (or an invalid)
      // declared permission is a bug — never an implicit allow.
      throw new ForbiddenException('This action is not permitted.');
    }

    const authorization = await this.authorizationService.loadContext(
      request.internalUser.id,
      request.tenantContext,
    );

    if (!authorization.has(required)) {
      throw new ForbiddenException(
        'You do not have permission to perform this action.',
      );
    }

    request.authorization = authorization;
    return true;
  }
}
