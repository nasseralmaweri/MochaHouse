import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  SubmitFranchiseInquiryRequest,
  SubmitFranchiseInquiryResponse,
} from '@mocha-house/contracts';
import {
  FRANCHISE_INQUIRY_MESSAGE_MAX_LENGTH,
  FRANCHISE_INQUIRY_NAME_MAX_LENGTH,
  FRANCHISE_INQUIRY_SHORT_MAX_LENGTH,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';

// Milestone 8D — the PUBLIC franchise-inquiry submission. No auth, no
// account. Every field is validated server-side. The response is ONLY
// { ok: true } — never an id, never the stored record. Repeat submissions
// from the same email are allowed (no dedup). Submission is not audited
// (the row + createdAt is the record).
@Injectable()
export class FranchiseInquiriesPublicService {
  constructor(private readonly prisma: PrismaService) {}

  async submit(
    request: SubmitFranchiseInquiryRequest,
  ): Promise<SubmitFranchiseInquiryResponse> {
    const data = {
      firstName: this.text(
        request?.firstName,
        'first name',
        FRANCHISE_INQUIRY_NAME_MAX_LENGTH,
      ),
      lastName: this.text(
        request?.lastName,
        'last name',
        FRANCHISE_INQUIRY_NAME_MAX_LENGTH,
      ),
      email: this.email(request?.email),
      phone: this.text(
        request?.phone,
        'phone number',
        FRANCHISE_INQUIRY_SHORT_MAX_LENGTH,
      ),
      city: this.text(request?.city, 'city', FRANCHISE_INQUIRY_SHORT_MAX_LENGTH),
      state: this.text(
        request?.state,
        'state',
        FRANCHISE_INQUIRY_SHORT_MAX_LENGTH,
      ),
      country: this.text(
        request?.country,
        'country',
        FRANCHISE_INQUIRY_SHORT_MAX_LENGTH,
      ),
      preferredMarket: this.text(
        request?.preferredMarket,
        'preferred market',
        FRANCHISE_INQUIRY_SHORT_MAX_LENGTH,
      ),
      investmentRange: this.optionalText(
        request?.investmentRange,
        'investment range',
        FRANCHISE_INQUIRY_SHORT_MAX_LENGTH,
      ),
      timeframe: this.optionalText(
        request?.timeframe,
        'timeframe',
        FRANCHISE_INQUIRY_SHORT_MAX_LENGTH,
      ),
      businessExperience: this.optionalText(
        request?.businessExperience,
        'business experience',
        FRANCHISE_INQUIRY_MESSAGE_MAX_LENGTH,
      ),
      message: this.optionalText(
        request?.message,
        'additional information',
        FRANCHISE_INQUIRY_MESSAGE_MAX_LENGTH,
      ),
      consentAcknowledged: this.consent(request?.consentAcknowledged),
    };

    await this.prisma.franchiseInquiry.create({ data, select: { id: true } });
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

  private optionalText(
    raw: unknown,
    field: string,
    max: number,
  ): string | null {
    if (raw === undefined || raw === null) {
      return null;
    }
    if (typeof raw !== 'string') {
      throw new BadRequestException(`Your ${field} isn't valid.`);
    }
    const value = raw.trim();
    if (value.length === 0) {
      return null;
    }
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
      value.length > FRANCHISE_INQUIRY_SHORT_MAX_LENGTH ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    ) {
      throw new BadRequestException('A valid email address is required.');
    }
    return value;
  }

  private consent(raw: unknown): boolean {
    if (raw !== true) {
      throw new BadRequestException(
        'Please acknowledge that Mocha House may contact you regarding this inquiry.',
      );
    }
    return true;
  }
}
