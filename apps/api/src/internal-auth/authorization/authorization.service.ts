import { Injectable, Logger } from '@nestjs/common';
import type { TenantContext } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthorizationContext, type ScopeGrant } from './authorization-context';
import {
  isKnownPermissionKey,
  type InternalPermissionKey,
} from './permission-catalog';

@Injectable()
export class AuthorizationService {
  private readonly logger = new Logger(AuthorizationService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Builds the effective authorization context for an ACTIVE internal user
  // from persisted data only:
  //   InternalUser -> InternalUserRoleAssignment -> InternalRole
  //                -> InternalRolePermission
  // Never reads a role name to make a decision. Every stored permissionKey
  // is validated against the closed code vocabulary — an unknown key is
  // dropped (logged once) and can never grant a capability. Scope
  // invariants (CORPORATE => scopeId null; LOCATION => scopeId present) are
  // re-checked here; a malformed assignment contributes nothing.
  //
  // Milestone S0D-2E — the role-assignment lookup is now scoped to BOTH
  // internalUserId AND the caller's trusted TenantContext. Tenant A must
  // never inherit, observe, or evaluate Tenant B's role assignments: even
  // though every assignment's own tenantId already agrees with its
  // InternalUser's tenantId (enforced where assignments are created, and by
  // the migration's same-tenant checks), this filter is the authorization
  // engine's OWN tenant boundary, not a hope that upstream data stays
  // consistent. `tenant` is always the request's server-resolved
  // TenantContext — never a client-supplied id.
  async loadContext(
    internalUserId: string,
    tenant: TenantContext,
  ): Promise<AuthorizationContext> {
    const assignments = await this.prisma.internalUserRoleAssignment.findMany({
      where: { internalUserId, tenantId: tenant.tenantId },
      include: { role: { include: { permissions: true } } },
    });

    const grants = new Map<InternalPermissionKey, ScopeGrant[]>();

    for (const assignment of assignments) {
      const grant = this.toValidScopeGrant(assignment);
      if (!grant) {
        continue;
      }
      for (const rolePermission of assignment.role.permissions) {
        const key = rolePermission.permissionKey;
        if (!isKnownPermissionKey(key)) {
          this.logger.warn(
            `Ignoring unknown stored permission key "${key}" on role "${assignment.role.key}".`,
          );
          continue;
        }
        const existing = grants.get(key) ?? [];
        if (
          !existing.some(
            (g) =>
              g.scopeType === grant.scopeType && g.scopeId === grant.scopeId,
          )
        ) {
          existing.push(grant);
        }
        grants.set(key, existing);
      }
    }

    return AuthorizationContext.create(grants);
  }

  private toValidScopeGrant(assignment: {
    scopeType: 'CORPORATE' | 'LOCATION';
    scopeId: string | null;
    role: { key: string };
  }): ScopeGrant | null {
    if (assignment.scopeType === 'CORPORATE') {
      if (assignment.scopeId !== null) {
        this.logger.warn(
          `Ignoring CORPORATE assignment with a non-null scopeId (role "${assignment.role.key}").`,
        );
        return null;
      }
      return { scopeType: 'CORPORATE', scopeId: null };
    }
    if (assignment.scopeType === 'LOCATION') {
      if (!assignment.scopeId) {
        this.logger.warn(
          `Ignoring LOCATION assignment with no scopeId (role "${assignment.role.key}").`,
        );
        return null;
      }
      return { scopeType: 'LOCATION', scopeId: assignment.scopeId };
    }
    return null;
  }
}
