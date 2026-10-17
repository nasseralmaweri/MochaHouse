import { BadRequestException } from '@nestjs/common';
import {
  validateLocationProfile,
  validateOpeningHours,
  type StoredOpeningPeriod,
  type ValidLocationProfile,
} from '@mocha-house/contracts';

// SC4d — HTTP-boundary validation for the location profile and opening-hours
// routes. The rules are the shared ones the web form also runs (contracts);
// the API is the authority. Only known fields are read — a tenant id, slug
// or online-ordering flag in the body is ignored — and anything malformed is
// a 400 before any read or write.

export function parseLocationProfile(body: unknown): ValidLocationProfile {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('The request body must be an object.');
  }
  const result = validateLocationProfile(body as Record<string, unknown>);
  if (!result.ok) {
    throw new BadRequestException({
      statusCode: 400,
      message: result.message,
      field: result.field,
    });
  }
  return result.value;
}

export function parseOpeningHours(body: unknown): StoredOpeningPeriod[] {
  const result = validateOpeningHours(body);
  if (!result.ok) {
    throw new BadRequestException(result.message);
  }
  return result.periods;
}
