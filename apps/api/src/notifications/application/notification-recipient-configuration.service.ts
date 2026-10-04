import { BadRequestException, Injectable } from '@nestjs/common';
import {
  NOTIFICATION_RECIPIENT_PURPOSES,
  type AdminNotificationRecipientsResponse,
  type NotificationRecipientPurpose,
  type UpdateNotificationRecipientRequest,
} from '@mocha-house/contracts';
import type { TenantContext } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';

const EMAIL_MAX_LENGTH = 320;
// Deliberately permissive — one @, a dot in the domain, no spaces. Same
// pattern already used for public Careers / Franchising submissions.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// HQ configuration of WHERE a Careers/Franchising business notification is
// sent (Milestone S0D-2C-3). Replaces the old global
// CAREERS_NOTIFICATION_EMAIL / FRANCHISING_NOTIFICATION_EMAIL env vars,
// which could only ever hold one, process-wide address — unsafe once a
// second tenant exists. `notifications.routing.view` /
// `notifications.routing.manage` are CORPORATE-only in the permission
// catalog; every method also calls `assertCorporate`.
//
// Tenant isolation is STRUCTURAL, not an extra check: every read and write
// below goes through the `(tenantId, purpose)` composite unique key, so a
// Tenant B caller can never address Tenant A's row even by guessing a
// purpose string — there is no id-only lookup anywhere in this service.
//
// Deliberately NOT a keyed-singleton-with-lazy-defaults service like
// GiftCardConfigurationService: a missing row here is a legitimate,
// intentional "not configured" state the worker must fail closed on, so
// this service never creates a default row — only an explicit `update`
// (an authorized admin action) ever creates one.
@Injectable()
export class NotificationRecipientConfigurationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
  ) {}

  async list(
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminNotificationRecipientsResponse> {
    authorization.assertCorporate('notifications.routing.view');
    const rows = await this.prisma.notificationRecipient.findMany({
      where: { tenantId: tenant.tenantId },
      select: { purpose: true, email: true, updatedAt: true },
    });
    const byPurpose = new Map(rows.map((row) => [row.purpose, row]));
    return {
      recipients: NOTIFICATION_RECIPIENT_PURPOSES.map((purpose) => {
        const row = byPurpose.get(purpose);
        return {
          purpose,
          email: row?.email ?? null,
          updatedAt: row?.updatedAt.toISOString() ?? null,
        };
      }),
    };
  }

  async update(
    purposeParam: string,
    request: UpdateNotificationRecipientRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<{
    purpose: NotificationRecipientPurpose;
    email: string;
    updatedAt: string;
  }> {
    authorization.assertCorporate('notifications.routing.manage');
    const purpose = this.validatePurpose(purposeParam);
    const email = this.validateEmail(request?.email);

    const current = await this.prisma.notificationRecipient.findUnique({
      where: { tenantId_purpose: { tenantId: tenant.tenantId, purpose } },
      select: { email: true, updatedAt: true },
    });

    if (current?.email === email) {
      // No-op — nothing changed, nothing to audit.
      return { purpose, email: current.email, updatedAt: current.updatedAt.toISOString() };
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.notificationRecipient.upsert({
        where: { tenantId_purpose: { tenantId: tenant.tenantId, purpose } },
        create: { tenantId: tenant.tenantId, purpose, email },
        update: { email },
      });
      await this.audit.recordNotificationRecipientUpdated(tx, {
        actorInternalUserId,
        purpose,
        before: current ? { email: current.email } : null,
        after: { email },
      });
      return row;
    });

    return {
      purpose,
      email: updated.email,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  private validatePurpose(raw: string): NotificationRecipientPurpose {
    if (
      !NOTIFICATION_RECIPIENT_PURPOSES.includes(
        raw as NotificationRecipientPurpose,
      )
    ) {
      throw new BadRequestException('Unknown notification purpose.');
    }
    return raw as NotificationRecipientPurpose;
  }

  private validateEmail(raw: unknown): string {
    if (typeof raw !== 'string') {
      throw new BadRequestException('A valid recipient email is required.');
    }
    const value = raw.trim();
    if (
      value.length === 0 ||
      value.length > EMAIL_MAX_LENGTH ||
      !EMAIL_PATTERN.test(value)
    ) {
      throw new BadRequestException('A valid recipient email is required.');
    }
    return value;
  }
}
