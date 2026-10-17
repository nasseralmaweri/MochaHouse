import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PLATFORM_PERMISSION_REQUIRED,
  type PlatformPermission,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { PLATFORM_AUDIT_ACTIONS } from '../application/platform-operators.service';
import type { PlatformAuthenticatedRequest } from '../infrastructure/platform-identity';

// SC3e-2 (owner decision D1) — a platform action an operator may take only
// with a GRANTED permission. Runs after PlatformAuthGuard (the class-level
// guard: a verified identity mapped to an ACTIVE operator) and re-reads the
// operator's live grants on EVERY request, so a revocation takes effect at
// once. A missing or revoked permission is refused (403) and audited.
// Grants exist only through the provisioning CLI — there is no API that
// creates one, so an operator can never grant itself anything.
//
// Separate from the business-staff permission system (PermissionGuard /
// RequirePermission), the billing workers and the verified provider
// webhooks, which never pass through here.
export const PLATFORM_PERMISSION_KEY = 'platform-permission';

@Injectable()
export class PlatformPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<
      PlatformPermission | undefined
    >(PLATFORM_PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    const request = context
      .switchToHttp()
      .getRequest<PlatformAuthenticatedRequest>();
    const operator = request.platformOperator;
    // Fail closed: misconfigured (no permission named, or the platform guard
    // did not run first).
    if (!permission || !operator || operator.status !== 'ACTIVE') {
      throw new ForbiddenException(refusal());
    }
    const granted = await this.prisma.platformOperatorPermission.findFirst({
      where: { operatorId: operator.id, permission, revokedAt: null },
      select: { id: true },
    });
    if (granted) return true;
    await this.prisma.platformAuditEvent.create({
      data: {
        action: PLATFORM_AUDIT_ACTIONS.accessDenied,
        outcome: 'DENIED',
        reasonCode: 'PERMISSION_REQUIRED',
        actorPlatformOperatorId: operator.id,
        requestReference: request.requestId ?? null,
      },
    });
    throw new ForbiddenException(refusal());
  }
}

function refusal() {
  return {
    statusCode: 403,
    error: 'Forbidden',
    code: PLATFORM_PERMISSION_REQUIRED,
    message: "Your operator account doesn't have permission for this action.",
  };
}

// Use on a platform controller method (the class carries PlatformAuthGuard).
export function RequirePlatformPermission(permission: PlatformPermission) {
  return applyDecorators(
    SetMetadata(PLATFORM_PERMISSION_KEY, permission),
    UseGuards(PlatformPermissionGuard),
  );
}
