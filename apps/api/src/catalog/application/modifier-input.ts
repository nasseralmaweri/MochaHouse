import { BadRequestException } from '@nestjs/common';
import {
  MODIFIER_GROUP_MAX_OPTIONS,
  MODIFIER_MAX_PRICE_ADJUSTMENT_MINOR_UNITS,
  MODIFIER_MAX_SELECTIONS_LIMIT,
  PRODUCT_MAX_MODIFIER_GROUPS,
} from '@mocha-house/contracts';
import {
  hasNulCharacter,
  parseId,
  parseName,
  requireObject,
} from './catalog-create-input';

// Product Modifier Management — HTTP-boundary validation. Every field is
// read explicitly (unknown keys are inert), and anything malformed is a 400
// before any read or write. The rules match the database CHECKs added by
// migration 20261114090000_modifier_value_checks.

export interface CreateModifierGroupInput {
  name: string;
  minSelections: number;
  maxSelections: number | null;
}

export interface UpdateModifierGroupInput {
  name?: string;
  minSelections?: number;
  maxSelections?: number | null;
  isActive?: boolean;
}

export interface CreateModifierOptionInput {
  name: string;
  priceAdjustment: number;
}

export interface UpdateModifierOptionInput {
  name?: string;
  priceAdjustment?: number;
  isActive?: boolean;
}

// Ids are generated UUIDs; anything longer is not one of ours.
const ID_MAX_LENGTH = 64;

export function parseCreateModifierGroup(
  body: unknown,
): CreateModifierGroupInput {
  const record = requireObject(body);
  const minSelections = parseMinSelections(record.minSelections);
  if (record.maxSelections === undefined) {
    throw new BadRequestException(
      'Choose a maximum number of choices, or no limit.',
    );
  }
  const maxSelections = parseMaxSelections(record.maxSelections);
  assertSelectionRange(minSelections, maxSelections);
  return {
    name: parseName(record.name, 'Modifier group'),
    minSelections,
    maxSelections,
  };
}

// The selection range is checked against the group's current values by
// the service (only one side may be in the request).
export function parseUpdateModifierGroup(
  body: unknown,
): UpdateModifierGroupInput {
  const record = requireObject(body);
  const input: UpdateModifierGroupInput = {};
  if (record.name !== undefined) {
    input.name = parseName(record.name, 'Modifier group');
  }
  if (record.minSelections !== undefined) {
    input.minSelections = parseMinSelections(record.minSelections);
  }
  if (record.maxSelections !== undefined) {
    input.maxSelections = parseMaxSelections(record.maxSelections);
  }
  if (record.isActive !== undefined) {
    input.isActive = parseBoolean(record.isActive, 'isActive');
  }
  return input;
}

export function parseCreateModifierOption(
  body: unknown,
): CreateModifierOptionInput {
  const record = requireObject(body);
  return {
    name: parseName(record.name, 'Option'),
    priceAdjustment: parsePriceAdjustment(record.priceAdjustment),
  };
}

export function parseUpdateModifierOption(
  body: unknown,
): UpdateModifierOptionInput {
  const record = requireObject(body);
  const input: UpdateModifierOptionInput = {};
  if (record.name !== undefined) {
    input.name = parseName(record.name, 'Option');
  }
  if (record.priceAdjustment !== undefined) {
    input.priceAdjustment = parsePriceAdjustment(record.priceAdjustment);
  }
  if (record.isActive !== undefined) {
    input.isActive = parseBoolean(record.isActive, 'isActive');
  }
  return input;
}

export function parseReorderModifierOptions(body: unknown): string[] {
  return parseIdList(
    requireObject(body).optionIds,
    MODIFIER_GROUP_MAX_OPTIONS,
    'optionIds',
  );
}

export function parseAttachModifierGroup(body: unknown): string {
  return parseModifierId(
    requireObject(body).modifierGroupId,
    'Choose a modifier group.',
  );
}

export function parseReorderProductModifierGroups(body: unknown): string[] {
  return parseIdList(
    requireObject(body).modifierGroupIds,
    PRODUCT_MAX_MODIFIER_GROUPS,
    'modifierGroupIds',
  );
}

// "Required" is derived from the minimum (>= 1), so only the range is
// checked: 0 <= min <= 20, and max is null or max(min, 1) <= max <= 20.
export function assertSelectionRange(
  minSelections: number,
  maxSelections: number | null,
): void {
  if (maxSelections !== null && maxSelections < Math.max(minSelections, 1)) {
    throw new BadRequestException(
      'The maximum number of choices must be at least the minimum (and at least 1).',
    );
  }
}

function parseMinSelections(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MODIFIER_MAX_SELECTIONS_LIMIT
  ) {
    throw new BadRequestException(
      `The minimum number of choices must be a whole number from 0 to ${MODIFIER_MAX_SELECTIONS_LIMIT}.`,
    );
  }
  return value;
}

function parseMaxSelections(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MODIFIER_MAX_SELECTIONS_LIMIT
  ) {
    throw new BadRequestException(
      `The maximum number of choices must be a whole number from 1 to ${MODIFIER_MAX_SELECTIONS_LIMIT}, or no limit.`,
    );
  }
  return value;
}

function parsePriceAdjustment(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MODIFIER_MAX_PRICE_ADJUSTMENT_MINOR_UNITS
  ) {
    throw new BadRequestException(
      `Price adjustment must be a whole number of cents from 0 to ${MODIFIER_MAX_PRICE_ADJUSTMENT_MINOR_UNITS}.`,
    );
  }
  return value;
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new BadRequestException(`${field} must be true or false.`);
  }
  return value;
}

export function parseModifierId(value: unknown, message: string): string {
  const id = parseId(value, message);
  if (id.length > ID_MAX_LENGTH) {
    throw new BadRequestException(message);
  }
  return id;
}

// A complete, duplicate-free list of ids (the service checks it is exactly
// the current set).
function parseIdList(value: unknown, max: number, field: string): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new BadRequestException(
      `${field} must be a list of at most ${max} ids.`,
    );
  }
  const ids = value.map((entry) => {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.length > ID_MAX_LENGTH ||
      hasNulCharacter(entry)
    ) {
      throw new BadRequestException(`${field} must contain only ids.`);
    }
    return entry;
  });
  if (new Set(ids).size !== ids.length) {
    throw new BadRequestException(`${field} must not repeat an id.`);
  }
  return ids;
}
