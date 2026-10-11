import { BadRequestException } from '@nestjs/common';
import { assertValidCheckoutLines } from './validate-checkout-lines';

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

  it.each([
    ['non-array lines', 'nope'],
    ['null line', [null]],
    ['array line', [[]]],
    ['missing productId', [{ quantity: 1, selections: [] }]],
    ['empty productId', [{ productId: '', quantity: 1, selections: [] }]],
    ['non-integer quantity', [{ ...validLine, quantity: 1.5 }]],
    ['string quantity', [{ ...validLine, quantity: '1' }]],
    ['missing selections', [{ productId: 'p', quantity: 1 }]],
    ['null selection', [{ ...validLine, selections: [null] }]],
    [
      'non-string groupId',
      [{ ...validLine, selections: [{ groupId: 1, optionIds: [] }] }],
    ],
    [
      'non-array optionIds',
      [{ ...validLine, selections: [{ groupId: 'g', optionIds: 'o1' }] }],
    ],
    [
      'non-string optionId',
      [{ ...validLine, selections: [{ groupId: 'g', optionIds: [1] }] }],
    ],
  ])('rejects %s with a 400', (_name, lines) => {
    let error: unknown;
    try {
      assertValidCheckoutLines(lines);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getStatus()).toBe(400);
  });
});
