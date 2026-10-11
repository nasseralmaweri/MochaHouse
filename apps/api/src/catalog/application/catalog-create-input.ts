import { BadRequestException } from '@nestjs/common';
import {
  CATALOG_DESCRIPTION_MAX_LENGTH,
  CATALOG_MAX_PRICE_MINOR_UNITS,
  CATALOG_NAME_MAX_LENGTH,
  isValidCatalogSlug,
} from '@mocha-house/contracts';

// HTTP-boundary validation for the S1 Admin catalog creation routes. The
// contracts are TypeScript interfaces, so nothing has checked the body's
// runtime shape before this point: every field is read explicitly, unknown
// keys are ignored, and anything malformed is a 400 before any read or
// write.

export interface CreateCategoryInput {
  name: string;
  slug: string | null;
  isActive: boolean;
}

export interface CreateProductInput {
  name: string;
  categoryId: string;
  description: string | null;
  basePrice: number | null;
  isActive: boolean;
  slug: string | null;
}

export interface AddMenuProductInput {
  productId: string;
  isActive: boolean;
}

export function parseCreateCategory(body: unknown): CreateCategoryInput {
  const record = requireObject(body);
  return {
    name: parseName(record.name, 'Category'),
    slug: parseOptionalSlug(record.slug),
    isActive: parseOptionalBoolean(record.isActive, true, 'isActive'),
  };
}

export function parseCreateProduct(body: unknown): CreateProductInput {
  const record = requireObject(body);
  return {
    name: parseName(record.name, 'Product'),
    categoryId: parseId(record.categoryId, 'Choose a category.'),
    description: parseDescription(record.description),
    basePrice: parseBasePrice(record.basePrice),
    isActive: parseOptionalBoolean(record.isActive, true, 'isActive'),
    slug: parseOptionalSlug(record.slug),
  };
}

export function parseAddMenuProduct(body: unknown): AddMenuProductInput {
  const record = requireObject(body);
  return {
    productId: parseId(record.productId, 'Choose a product.'),
    // Hidden unless explicitly shown: adding a product to a menu never
    // publishes it by surprise.
    isActive: parseOptionalBoolean(record.isActive, false, 'isActive'),
  };
}

function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('The request body must be an object.');
  }
  return body as Record<string, unknown>;
}

function parseName(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException(`${label} name is required.`);
  }
  const name = value.trim();
  if (name.length > CATALOG_NAME_MAX_LENGTH) {
    throw new BadRequestException(
      `${label} name must be at most ${CATALOG_NAME_MAX_LENGTH} characters.`,
    );
  }
  return name;
}

function parseId(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException(message);
  }
  return value.trim();
}

function parseDescription(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException('Description must be text.');
  }
  const description = value.trim();
  if (description.length > CATALOG_DESCRIPTION_MAX_LENGTH) {
    throw new BadRequestException(
      `Description must be at most ${CATALOG_DESCRIPTION_MAX_LENGTH} characters.`,
    );
  }
  return description.length === 0 ? null : description;
}

function parseBasePrice(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > CATALOG_MAX_PRICE_MINOR_UNITS
  ) {
    throw new BadRequestException(
      `Standard price must be a whole number of cents from 0 to ${CATALOG_MAX_PRICE_MINOR_UNITS}, or null for no standard price.`,
    );
  }
  return value;
}

function parseOptionalSlug(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException('Web address must be text.');
  }
  const slug = value.trim();
  if (slug.length === 0) {
    return null;
  }
  if (!isValidCatalogSlug(slug)) {
    throw new BadRequestException(
      'Web address may contain only lower-case letters, numbers and single hyphens.',
    );
  }
  return slug;
}

function parseOptionalBoolean(
  value: unknown,
  fallback: boolean,
  field: string,
): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new BadRequestException(`${field} must be true or false.`);
  }
  return value;
}
