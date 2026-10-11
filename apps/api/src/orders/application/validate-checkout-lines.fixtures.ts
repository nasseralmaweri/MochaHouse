// Malformed checkout cart lines, shared by the unit spec
// (validate-checkout-lines.spec.ts) and the HTTP integration spec
// (orders/api/checkout-safety.spec.ts) so both prove the same cases.
// Each entry is [case name, the `lines` value to send].
export function malformedLineCases(validLine: {
  productId: string;
  quantity: number;
  selections: Array<{ groupId: string; optionIds: string[] }>;
}): Array<[string, unknown]> {
  return [
    ['non-array lines', 'nope'],
    ['null line', [null]],
    ['array line', [[]]],
    ['missing productId', [{ quantity: 1, selections: [] }]],
    ['empty productId', [{ productId: '', quantity: 1, selections: [] }]],
    ['non-integer quantity', [{ ...validLine, quantity: 1.5 }]],
    ['string quantity', [{ ...validLine, quantity: '1' }]],
    ['null selections', [{ ...validLine, selections: null }]],
    ['object selections', [{ ...validLine, selections: {} }]],
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
  ];
}
