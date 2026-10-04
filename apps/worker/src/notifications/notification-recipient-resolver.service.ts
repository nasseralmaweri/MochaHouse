import { Injectable } from '@nestjs/common';
import type { NotificationRecipientPurpose } from '@mocha-house/contracts';
import { PrismaService } from '../prisma/prisma.service';

// Milestone S0D-2C-3 — resolves the tenant-owned recipient for a Careers /
// Franchising business notification. Replaces reading
// CAREERS_NOTIFICATION_EMAIL / FRANCHISING_NOTIFICATION_EMAIL directly from
// process.env in NotificationDispatchService, which was a single,
// process-wide address — unsafe once a second tenant exists (Tenant B's
// applications/inquiries must never route to Tenant A's inbox).
//
// The `(tenantId, purpose)` composite unique key is the full lookup — there
// is no id-only query path, so a Tenant A row can never resolve for a
// Tenant B call even if `purpose` were guessable. A missing row returns
// `null`; the caller is responsible for the fail-closed FAILED-delivery
// behaviour (never a fallback to another tenant's or a global recipient).
@Injectable()
export class NotificationRecipientResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    tenantId: string,
    purpose: NotificationRecipientPurpose,
  ): Promise<string | null> {
    const row = await this.prisma.notificationRecipient.findUnique({
      where: { tenantId_purpose: { tenantId, purpose } },
      select: { email: true },
    });
    return row?.email ?? null;
  }
}
