import { BadRequestException, Injectable } from '@nestjs/common';
import {
  FRANCHISE_INQUIRY_NOTE_MAX_LENGTH,
  type FranchiseInquiryNote,
} from '@mocha-house/contracts';
import type { TenantContext } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { requireTenantOwnership } from '../../tenancy/tenant-ownership';

// Milestone 8D — internal franchise-inquiry notes. APPEND-ONLY: list + add,
// no edit, no delete. `franchising.view` reads; `franchising.manage` adds.
// Both are CORPORATE-only (prospect PII); every method also calls
// assertCorporate. Adding a note writes the FranchiseInquiryNote row AND the
// `franchising.note_added` InternalAuditEvent (note id + length only — never
// the body) in ONE transaction.
@Injectable()
export class FranchiseInquiryNotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
  ) {}

  async listForInquiry(
    inquiryId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<FranchiseInquiryNote[]> {
    authorization.assertCorporate('franchising.view');
    await this.assertInquiryOwned(inquiryId, tenant);
    return this.load(inquiryId);
  }

  async addNote(
    inquiryId: string,
    rawBody: unknown,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<FranchiseInquiryNote[]> {
    authorization.assertCorporate('franchising.manage');
    // Milestone S0D-2D — ownership before validating/writing the note, so a
    // Tenant B inquiry reports the same 404 a missing one would.
    const tenantId = await this.assertInquiryOwned(inquiryId, tenant);

    const body = this.validateBody(rawBody);

    await this.prisma.$transaction(async (tx) => {
      const note = await tx.franchiseInquiryNote.create({
        data: {
          franchiseInquiryId: inquiryId,
          authorInternalUserId: actorInternalUserId,
          body,
          // Milestone S0D-2D — copied from the validated parent inquiry,
          // never from client input.
          tenantId,
        },
        select: { id: true },
      });
      await this.audit.recordFranchiseInquiryNoteAdded(tx, {
        actorInternalUserId,
        franchiseInquiryId: inquiryId,
        noteId: note.id,
        noteLength: body.length,
      });
    });

    return this.load(inquiryId);
  }

  private validateBody(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new BadRequestException('A note body is required.');
    }
    const body = raw.trim();
    if (body.length > FRANCHISE_INQUIRY_NOTE_MAX_LENGTH) {
      throw new BadRequestException(
        `A note can be at most ${FRANCHISE_INQUIRY_NOTE_MAX_LENGTH} characters.`,
      );
    }
    return body;
  }

  // Milestone S0D-2D — returns the parent's own tenantId so a note copies
  // ownership from it, and reports a foreign inquiry exactly like a missing
  // one. Reads use it too, so another tenant's notes are never listed.
  private async assertInquiryOwned(
    inquiryId: string,
    tenant: TenantContext,
  ): Promise<string> {
    const found = await this.prisma.franchiseInquiry.findUnique({
      where: { id: inquiryId },
      select: { id: true, tenantId: true },
    });
    return requireTenantOwnership(
      found,
      tenant,
      'Franchise inquiry not found.',
    );
  }

  async load(inquiryId: string): Promise<FranchiseInquiryNote[]> {
    const notes = await this.prisma.franchiseInquiryNote.findMany({
      where: { franchiseInquiryId: inquiryId },
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
