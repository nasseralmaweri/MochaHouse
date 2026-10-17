import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PLATFORM_OPERATOR_NOT_ACTIVE,
  PLATFORM_PERMISSION_SELF,
  PLATFORM_PERMISSIONS,
  type PlatformOperatorDirectoryResponse,
  type PlatformPermission,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { runSerializable } from '../../prisma/serializable-transaction';
import { isUuid } from '../../platform-subscriptions/application/plan-input';
import type { PlatformOperatorRow } from '../infrastructure/platform-identity';
import { PLATFORM_AUDIT_ACTIONS } from './platform-operators.service';

// SC3e-3 (owner decision D7) — the authenticated, audited way to grant and
// revoke operator permissions, including the financial ones: by an operator
// holding platform.permissions.manage (verified identity with MFA, a recent
// sign-in, a reason), NEVER for itself (also refused by the database). The
// plain CLI cannot grant financial permissions; the only other path is the
// documented one-time bootstrap. Every change is in the platform audit trail
// and on the grant row (who granted / revoked it).

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code,
    message,
  });
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function parsePermissionChange(body: unknown): {
  permission: PlatformPermission;
  reason: string;
} {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).sort().join(',') !== 'permission,reason'
  ) {
    throw new BadRequestException('Send exactly { permission, reason }.');
  }
  const { permission, reason } = body as {
    permission: unknown;
    reason: unknown;
  };
  if (!PLATFORM_PERMISSIONS.includes(permission as PlatformPermission)) {
    throw new BadRequestException('Choose a known permission.');
  }
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < 10 || text.length > 500 || hasControlCharacter(text)) {
    throw new BadRequestException(
      'A reason of 10 to 500 characters (one line) is required.',
    );
  }
  return { permission: permission as PlatformPermission, reason: text };
}

const permissionCode = (permission: PlatformPermission) =>
  permission.toUpperCase().replace(/\./g, '_');

@Injectable()
export class PlatformPermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  async directory(): Promise<PlatformOperatorDirectoryResponse> {
    const operators = await this.prisma.platformOperator.findMany({
      orderBy: { email: 'asc' },
      select: {
        id: true,
        email: true,
        displayName: true,
        status: true,
        permissions: {
          where: { revokedAt: null },
          orderBy: { permission: 'asc' },
          select: {
            permission: true,
            grantedAt: true,
            grantedVia: true,
            grantReason: true,
            grantedBy: { select: { id: true, email: true } },
          },
        },
      },
    });
    return {
      operators: operators.map((operator) => ({
        id: operator.id,
        email: operator.email,
        displayName: operator.displayName,
        status: operator.status,
        permissions: operator.permissions
          .filter((grant) =>
            (PLATFORM_PERMISSIONS as readonly string[]).includes(
              grant.permission,
            ),
          )
          .map((grant) => ({
            permission: grant.permission as PlatformPermission,
            grantedAt: grant.grantedAt.toISOString(),
            grantedVia: grant.grantedVia as 'CLI' | 'CLI_BOOTSTRAP' | 'CONSOLE',
            grantedBy: grant.grantedBy,
            reason: grant.grantReason,
          })),
      })),
    };
  }

  async grant(
    targetOperatorId: string,
    input: { permission: PlatformPermission; reason: string },
    actor: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformOperatorDirectoryResponse> {
    await this.change(
      targetOperatorId,
      input,
      actor,
      requestReference,
      'grant',
    );
    return this.directory();
  }

  async revoke(
    targetOperatorId: string,
    input: { permission: PlatformPermission; reason: string },
    actor: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformOperatorDirectoryResponse> {
    await this.change(
      targetOperatorId,
      input,
      actor,
      requestReference,
      'revoke',
    );
    return this.directory();
  }

  private async change(
    targetOperatorId: string,
    input: { permission: PlatformPermission; reason: string },
    actor: PlatformOperatorRow,
    requestReference: string | undefined,
    step: 'grant' | 'revoke',
  ): Promise<void> {
    if (!isUuid(targetOperatorId))
      throw new NotFoundException('Operator not found.');
    if (targetOperatorId === actor.id) {
      throw conflict(
        PLATFORM_PERMISSION_SELF,
        "You can't change your own permissions; another operator must.",
      );
    }
    await runSerializable(this.prisma, async (tx) => {
      const target = await tx.platformOperator.findUnique({
        where: { id: targetOperatorId },
        select: { id: true, status: true },
      });
      if (!target) throw new NotFoundException('Operator not found.');
      if (step === 'grant') {
        if (target.status !== 'ACTIVE') {
          throw conflict(
            PLATFORM_OPERATOR_NOT_ACTIVE,
            'Only an active operator can be granted a permission.',
          );
        }
        const live = await tx.platformOperatorPermission.findFirst({
          where: {
            operatorId: target.id,
            permission: input.permission,
            revokedAt: null,
          },
          select: { id: true },
        });
        if (live) return;
        await tx.platformOperatorPermission.create({
          data: {
            operatorId: target.id,
            permission: input.permission,
            grantReason: input.reason,
            grantedVia: 'CONSOLE',
            grantedByOperatorId: actor.id,
          },
        });
      } else {
        const { count } = await tx.platformOperatorPermission.updateMany({
          where: {
            operatorId: target.id,
            permission: input.permission,
            revokedAt: null,
          },
          data: {
            revokedAt: new Date(),
            revokeReason: input.reason,
            revokedByOperatorId: actor.id,
          },
        });
        if (count === 0) return;
      }
      await tx.platformAuditEvent.create({
        data: {
          action:
            step === 'grant'
              ? PLATFORM_AUDIT_ACTIONS.operatorPermissionGranted
              : PLATFORM_AUDIT_ACTIONS.operatorPermissionRevoked,
          outcome: 'SUCCEEDED',
          actorPlatformOperatorId: actor.id,
          reasonCode: permissionCode(input.permission),
          targetType: 'platform_operator',
          targetId: target.id,
          requestReference: requestReference ?? null,
        },
      });
    });
  }
}
