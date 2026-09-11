import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FRANCHISE_INQUIRY_NOTE_MAX_LENGTH,
  type FranchiseInquiryNote,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';

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
  ): Promise<FranchiseInquiryNote[]> {
    authorization.assertCorporate('franchising.view');
    await this.assertInquiryExists(inquiryId);
    return this.load(inquiryId);
  }

  async addNote(
    inquiryId: string,
    rawBody: unknown,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<FranchiseInquiryNote[]> {
    authorization.assertCorporate('franchising.manage');
    await this.assertInquiryExists(inquiryId);

    const body = this.validateBody(rawBody);

    await this.prisma.$transaction(async (tx) => {
      const note = await tx.franchiseInquiryNote.create({
        data: {
          franchiseInquiryId: inquiryId,
          authorInternalUserId: actorInternalUserId,
          body,
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

  private async assertInquiryExists(inquiryId: string): Promise<void> {
    const found = await this.prisma.franchiseInquiry.findUnique({
      where: { id: inquiryId },
      select: { id: true },
    });
    if (!found) {
      throw new NotFoundException('Franchise inquiry not found.');
    }
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
