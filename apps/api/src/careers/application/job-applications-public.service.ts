import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  SubmitJobApplicationRequest,
  SubmitJobApplicationResponse,
} from '@mocha-house/contracts';
import {
  JOB_APPLICATION_MESSAGE_MAX_LENGTH,
  JOB_APPLICATION_NAME_MAX_LENGTH,
  JOB_APPLICATION_SHORT_MAX_LENGTH,
  JOB_APPLICATION_URL_MAX_LENGTH,
} from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { isPubliclyVisible } from './job-opening-mapper';

const JOB_INCLUDE = {
  location: { select: { id: true, name: true, isActive: true } },
} satisfies Prisma.JobOpeningInclude;

// Milestone 8C — the PUBLIC job-application submission. No auth, no account.
// The job must currently be publicly visible (PUBLISHED + corporate or
// active-location) or the request is 404 — a non-visible job's existence is
// never revealed. Every field is validated server-side. The response is
// ONLY { ok: true } — never an id, never the stored record. Multiple
// applications from the same email are allowed (no dedup). Submission is not
// audited (the row + createdAt is the record).
@Injectable()
export class JobApplicationsPublicService {
  constructor(private readonly prisma: PrismaService) {}

  async submit(
    jobId: string,
    request: SubmitJobApplicationRequest,
  ): Promise<SubmitJobApplicationResponse> {
    const job =
      typeof jobId === 'string'
        ? await this.prisma.jobOpening.findUnique({
            where: { id: jobId },
            include: JOB_INCLUDE,
          })
        : null;
    if (!job || !isPubliclyVisible(job)) {
      throw new NotFoundException('Job opening not found.');
    }

    const data = {
      jobOpeningId: job.id,
      jobTitleSnapshot: job.title,
      firstName: this.text(
        request?.firstName,
        'first name',
        JOB_APPLICATION_NAME_MAX_LENGTH,
      ),
      lastName: this.text(
        request?.lastName,
        'last name',
        JOB_APPLICATION_NAME_MAX_LENGTH,
      ),
      email: this.email(request?.email),
      phone: this.text(
        request?.phone,
        'phone number',
        JOB_APPLICATION_SHORT_MAX_LENGTH,
      ),
      location: this.text(
        request?.location,
        'city and state',
        JOB_APPLICATION_SHORT_MAX_LENGTH,
      ),
      workAuthorized: this.bool(request?.workAuthorized),
      availability: this.text(
        request?.availability,
        'availability',
        JOB_APPLICATION_SHORT_MAX_LENGTH,
      ),
      message: this.text(
        request?.message,
        'message',
        JOB_APPLICATION_MESSAGE_MAX_LENGTH,
      ),
      resumeUrl: this.optionalUrl(request?.resumeUrl),
    };

    await this.prisma.jobApplication.create({ data, select: { id: true } });
    return { ok: true };
  }

  private text(raw: unknown, field: string, max: number): string {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new BadRequestException(`Your ${field} is required.`);
    }
    const value = raw.trim();
    if (value.length > max) {
      throw new BadRequestException(
        `Your ${field} must be at most ${max} characters.`,
      );
    }
    return value;
  }

  private email(raw: unknown): string {
    if (typeof raw !== 'string') {
      throw new BadRequestException('A valid email address is required.');
    }
    const value = raw.trim();
    // Deliberately permissive — one @, a dot in the domain, no spaces.
    if (
      value.length === 0 ||
      value.length > JOB_APPLICATION_SHORT_MAX_LENGTH ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    ) {
      throw new BadRequestException('A valid email address is required.');
    }
    return value;
  }

  private bool(raw: unknown): boolean {
    if (typeof raw !== 'boolean') {
      throw new BadRequestException(
        'Please answer whether you are legally authorized to work in the U.S.',
      );
    }
    return raw;
  }

  private optionalUrl(raw: unknown): string | null {
    if (raw === undefined || raw === null || raw === '') {
      return null;
    }
    if (typeof raw !== 'string') {
      throw new BadRequestException('The link must be a URL or left blank.');
    }
    const value = raw.trim();
    if (value.length === 0) {
      return null;
    }
    if (value.length > JOB_APPLICATION_URL_MAX_LENGTH) {
      throw new BadRequestException('That link is too long.');
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new BadRequestException(
        'Enter a valid link starting with http:// or https://, or leave it blank.',
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException(
        'The link must start with http:// or https://.',
      );
    }
    return value;
  }
}
