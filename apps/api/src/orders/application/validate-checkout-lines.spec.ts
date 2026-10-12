import { BadRequestException } from '@nestjs/common';
import { assertValidCheckoutLines } from './validate-checkout-lines';
import { malformedLineCases } from './validate-checkout-lines.fixtures';

describe('assertValidCheckoutLines', () => {
  const validLine = {
    productId: 'p1',
    quantity: 2,
    selections: [{ groupId: 'g1', optionIds: ['o1', 'o1'] }],
  };

  it('accepts valid lines, empty selections, duplicate optionIds and extra keys', () => {
    expect(() =>
      assertValidCheckoutLines([
        validLine,
        { productId: 'p2', quantity: 1, selections: [], extra: true },
      ]),
    ).not.toThrow();
  });

  it('treats a line with no selections key as having no selections', () => {
    const lines: unknown[] = [{ productId: 'p3', quantity: 1 }];
    expect(() => assertValidCheckoutLines(lines)).not.toThrow();
    expect(lines[0]).toEqual({ productId: 'p3', quantity: 1, selections: [] });
  });

  it.each(malformedLineCases(validLine))(
    'rejects %s with a 400',
    (_name, lines) => {
      let error: unknown;
      try {
        assertValidCheckoutLines(lines);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getStatus()).toBe(400);
    },
  );
});
