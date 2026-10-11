import { BadRequestException } from '@nestjs/common';

// Structural check of the cart lines on a checkout body. The contract types
// are interfaces, so Nest cannot validate them at the framework layer and
// malformed nested data would otherwise reach priceCart as a 500. This checks
// shape only: unknown keys are ignored, duplicate optionIds are allowed, and
// business rules (unknown products, quantity limits) stay in priceCart.
// Callers run it after their own "Cart is empty." check.
export function assertValidCheckoutLines(lines: unknown): void {
  if (!Array.isArray(lines)) {
    throw new BadRequestException('Cart is empty.');
  }
  lines.forEach((line: unknown, index) => {
    const at = `lines[${index}]`;
    if (!isRecord(line)) {
      throw new BadRequestException(`${at} must be an object.`);
    }
    if (typeof line.productId !== 'string' || line.productId.length === 0) {
      throw new BadRequestException(`${at}.productId must be a string.`);
    }
    if (!Number.isInteger(line.quantity)) {
      throw new BadRequestException(`${at}.quantity must be an integer.`);
    }
    if (!Array.isArray(line.selections)) {
      throw new BadRequestException(`${at}.selections must be an array.`);
    }
    line.selections.forEach((selection: unknown, selectionIndex) => {
      const selectionAt = `${at}.selections[${selectionIndex}]`;
      if (!isRecord(selection)) {
        throw new BadRequestException(`${selectionAt} must be an object.`);
      }
      if (typeof selection.groupId !== 'string') {
        throw new BadRequestException(
          `${selectionAt}.groupId must be a string.`,
        );
      }
      if (
        !Array.isArray(selection.optionIds) ||
        selection.optionIds.some((id: unknown) => typeof id !== 'string')
      ) {
        throw new BadRequestException(
          `${selectionAt}.optionIds must be an array of strings.`,
        );
      }
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
