import { BadRequestException, Injectable } from '@nestjs/common';
import {
  JOB_APPLICATION_NOTE_MAX_LENGTH,
  type JobApplicationNote,
} from '@mocha-house/contracts';
import type { TenantContext } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { requireTenantOwnership } from '../../tenancy/tenant-ownership';

// Milestone 8C — internal applicant notes. APPEND-ONLY: list + add, no edit,
// no delete. `applicants.view` reads; `applicants.manage` adds. Both are
// CORPORATE-only (candidate PII); every method also calls assertCorporate.
// Adding a note writes the JobApplicationNote row AND the
// `applicants.note_added` InternalAuditEvent (note id + length only — never
// the body) in ONE transaction.
@Injectable()
export class JobApplicationNotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
  ) {}

  async listForApplication(
    applicationId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<JobApplicationNote[]> {
    authorization.assertCorporate('applicants.view');
    await this.assertApplicationOwned(applicationId, tenant);
    return this.load(applicationId);
  }

  async addNote(
    applicationId: string,
    rawBody: unknown,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<JobApplicationNote[]> {
    authorization.assertCorporate('applicants.manage');
    // Milestone S0D-2D — ownership before validating/writing the note, so a
    // Tenant B application reports the same 404 a missing one would.
    const tenantId = await this.assertApplicationOwned(applicationId, tenant);

    const body = this.validateBody(rawBody);

    await this.prisma.$transaction(async (tx) => {
      const note = await tx.jobApplicationNote.create({
        data: {
          jobApplicationId: applicationId,
          authorInternalUserId: actorInternalUserId,
          body,
          // Milestone S0D-2D — copied from the validated parent
          // application, never from client input.
          tenantId,
        },
        select: { id: true },
      });
      await this.audit.recordJobApplicationNoteAdded(tx, {
        actorInternalUserId,
        jobApplicationId: applicationId,
        noteId: note.id,
        noteLength: body.length,
      });
    });

    return this.load(applicationId);
  }

  private validateBody(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new BadRequestException('A note body is required.');
    }
    const body = raw.trim();
    if (body.length > JOB_APPLICATION_NOTE_MAX_LENGTH) {
      throw new BadRequestException(
        `A note can be at most ${JOB_APPLICATION_NOTE_MAX_LENGTH} characters.`,
      );
    }
    return body;
  }

  // Milestone S0D-2D — returns the parent's own tenantId so a note copies
  // ownership from it, and reports a foreign application exactly like a
  // missing one. Reads use it too, so another tenant's notes are never
  // listed.
  private async assertApplicationOwned(
    applicationId: string,
    tenant: TenantContext,
  ): Promise<string> {
    const found = await this.prisma.jobApplication.findUnique({
      where: { id: applicationId },
      select: { id: true, tenantId: true },
    });
    return requireTenantOwnership(found, tenant, 'Application not found.');
  }

  async load(applicationId: string): Promise<JobApplicationNote[]> {
    const notes = await this.prisma.jobApplicationNote.findMany({
      where: { jobApplicationId: applicationId },
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
