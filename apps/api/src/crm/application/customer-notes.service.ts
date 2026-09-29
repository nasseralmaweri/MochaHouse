import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CUSTOMER_NOTE_MAX_LENGTH,
  type CustomerNote,
} from '@mocha-house/contracts';
import type { TenantContext } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { requireTenantOwnership } from '../../tenancy/tenant-ownership';

// Milestone 8A — internal CRM notes. APPEND-ONLY: list + add, no edit, no
// delete. `customers.view` reads; `customers.notes.manage` adds. Both are
// CORPORATE-only in the permission catalog (PermissionGuard already rejects
// a LOCATION grant); every method also calls the matching assertCorporate.
// Adding a note writes the CustomerNote row AND the `crm.note_added`
// InternalAuditEvent in ONE transaction.
@Injectable()
export class CustomerNotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
  ) {}

  async listForCustomer(
    customerId: string,
    authorization: AuthorizationContext,
  ): Promise<CustomerNote[]> {
    authorization.assertCorporate('customers.view');
    await this.assertCustomerExists(customerId);
    return this.load(customerId);
  }

  // Milestone S0D-2B-2 — the note belongs to its Customer's tenant: the
  // server loads the Customer (the path's customerId is only a lookup key),
  // requires it to belong to the request's explicit TenantContext, and
  // copies that tenant onto the note. Another tenant's Customer is reported
  // exactly like a missing one, before any write — so neither a note nor
  // its audit event is ever written for it. The author's tenant is not
  // checked here: InternalUser tenancy is converted in a later slice.
  async addNote(
    customerId: string,
    rawBody: unknown,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<CustomerNote[]> {
    authorization.assertCorporate('customers.notes.manage');
    const tenantId = await this.requireOwnedCustomer(customerId, tenant);

    const body = this.validateBody(rawBody);

    await this.prisma.$transaction(async (tx) => {
      const note = await tx.customerNote.create({
        data: {
          tenantId,
          customerId,
          authorInternalUserId: actorInternalUserId,
          body,
        },
        select: { id: true },
      });
      await this.audit.recordCustomerNoteAdded(tx, {
        actorInternalUserId,
        customerId,
        noteId: note.id,
        noteLength: body.length,
      });
    });

    return this.load(customerId);
  }

  private validateBody(raw: unknown): string {
    if (typeof raw !== 'string') {
      throw new BadRequestException('A note body is required.');
    }
    const body = raw.trim();
    if (body.length === 0) {
      throw new BadRequestException('A note body is required.');
    }
    if (body.length > CUSTOMER_NOTE_MAX_LENGTH) {
      throw new BadRequestException(
        `A note can be at most ${CUSTOMER_NOTE_MAX_LENGTH} characters.`,
      );
    }
    return body;
  }

  private async assertCustomerExists(customerId: string): Promise<void> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer) {
      throw new NotFoundException('Customer not found.');
    }
  }

  // Write-path ownership only (S0D-2B-2); read isolation is S0E's job.
  // Returns the Customer's own tenantId. A Customer's tenant never changes,
  // so checking it before the transaction leaves no race.
  private async requireOwnedCustomer(
    customerId: string,
    tenant: TenantContext,
  ): Promise<string> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { tenantId: true },
    });
    return requireTenantOwnership(customer, tenant, 'Customer not found.');
  }

  private async load(customerId: string): Promise<CustomerNote[]> {
    const notes = await this.prisma.customerNote.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        body: true,
        createdAt: true,
        authorInternalUser: { select: { displayName: true, email: true } },
      },
    });
    return notes.map((note) => ({
      id: note.id,
      body: note.body,
      authorLabel: note.authorInternalUser
        ? note.authorInternalUser.displayName ?? note.authorInternalUser.email
        : null,
      createdAt: note.createdAt.toISOString(),
    }));
  }
}
