import {
  FROZEN_CHECKOUT_SNAPSHOT_VERSION,
  FrozenCheckoutMismatchError,
  LEGACY_CHECKOUT_SNAPSHOT_VERSION,
  UnreadableCheckoutSnapshotError,
  buildCheckoutSnapshot,
  freezeCheckout,
  readSavedCheckout,
  verifyFrozenCheckout,
  type FrozenCheckout,
  type SavedCheckout,
} from './checkout-snapshot';

// ESP-03 PR 7 — the frozen (version 2) saved checkout: what is frozen, how
// it is read back, and the arithmetic that must hold before an order is
// created from it.

const features = {
  loyalty: true,
  promotions: true,
  giftCards: true,
} as unknown as Parameters<typeof buildCheckoutSnapshot>[0]['features'];

function saved(
  overrides: Partial<Parameters<typeof freezeCheckout>[0]> = {},
  giftCardTender = 0,
): SavedCheckout & { frozen: FrozenCheckout } {
  const base = buildCheckoutSnapshot({
    locationId: 'loc-1',
    lines: [
      {
        productId: 'p-1',
        quantity: 2,
        selections: [{ groupId: 'g-1', optionIds: ['o-1'] }],
      },
      { productId: 'p-2', quantity: 1, selections: [] },
    ],
    guest: { name: 'Guest', phone: '5550000000' },
    customerId: 'c-1',
    rewardId: 'r-1',
    couponCode: 'SAVE',
    giftCardPlan:
      giftCardTender > 0
        ? {
            tenantId: 't-1',
            giftCardId: 'gc-1',
            last4: '1234',
            currency: 'USD',
            plannedTenderMinorUnits: giftCardTender,
          }
        : null,
    features,
  });
  const frozen = freezeCheckout({
    currency: 'USD',
    lines: [
      {
        productId: 'p-1',
        productName: 'Latte',
        quantity: 2,
        unitPrice: 450,
        lineTotal: 900,
        currency: 'USD',
        selections: [{ groupName: 'Milk', optionNames: ['Oat'] }],
        selectionSnapshots: [
          {
            groupId: 'g-1',
            groupName: 'Milk',
            optionIds: ['o-1'],
            optionNames: ['Oat'],
          },
        ],
      },
      {
        productId: 'p-2',
        productName: 'Muffin',
        quantity: 1,
        unitPrice: 300,
        lineTotal: 300,
        currency: 'USD',
        selections: [],
        selectionSnapshots: [],
      },
    ],
    subtotal: 1200,
    regularPlan: {
      promotionId: 'promo-1',
      discountMinorUnits: 100,
    } as never,
    rewardPlan: {
      rewardId: 'r-1',
      beanCost: 5,
      discountMinorUnits: 200,
    } as never,
    giftCardTender,
    charge: 1200 - 100 - 200 - giftCardTender,
    loyalty: { earnBeans: 9, bonus: null },
    ...overrides,
  });
  return { ...base, frozen };
}

const payment = (amount: number) => ({ amount, currency: 'USD' });

describe('frozen checkout (version 2)', () => {
  it('freezes the lines, discounts, tender, charge and loyalty', () => {
    const s = saved({}, 400);
    expect(s.frozen.totals).toEqual({
      subtotal: 1200,
      promotionDiscount: 100,
      rewardDiscount: 200,
      giftCardTender: 400,
      charge: 500,
    });
    expect(() => verifyFrozenCheckout(s, payment(500))).not.toThrow();
  });

  it('reads back both versions, and refuses anything else', () => {
    const s = saved();
    const raw = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
    expect(readSavedCheckout(FROZEN_CHECKOUT_SNAPSHOT_VERSION, raw)).toEqual(s);
    const v1 = { ...raw };
    delete v1.frozen;
    expect(
      readSavedCheckout(LEGACY_CHECKOUT_SNAPSHOT_VERSION, v1).frozen,
    ).toBeUndefined();
    expect(() =>
      readSavedCheckout(FROZEN_CHECKOUT_SNAPSHOT_VERSION, v1),
    ).toThrow(UnreadableCheckoutSnapshotError);
    expect(() => readSavedCheckout(3, raw)).toThrow(
      UnreadableCheckoutSnapshotError,
    );
    const broken = JSON.parse(JSON.stringify(raw)) as {
      frozen: { lines: { unitPrice: unknown }[] };
    };
    broken.frozen.lines[0].unitPrice = '450';
    expect(() =>
      readSavedCheckout(FROZEN_CHECKOUT_SNAPSHOT_VERSION, broken),
    ).toThrow(UnreadableCheckoutSnapshotError);
  });

  describe('is never fulfilled when it does not add up', () => {
    const cases: [
      string,
      (s: SavedCheckout & { frozen: FrozenCheckout }) => void,
      number?,
    ][] = [
      ['a charge that differs from the payment', () => undefined, 899],
      ['another currency', (s) => (s.frozen.currency = 'EUR')],
      [
        'a line total that is not price × quantity',
        (s) => (s.frozen.lines[0].lineTotal = 901),
      ],
      [
        'lines that do not sum to the subtotal',
        (s) =>
          (s.frozen.lines[1].lineTotal = s.frozen.lines[1].unitPrice = 200),
      ],
      [
        'a promotion discount that is not its plan',
        (s) => (s.frozen.totals.promotionDiscount = 50),
      ],
      [
        'a reward discount that is not its plan',
        (s) => (s.frozen.totals.rewardDiscount = 0),
      ],
      [
        'a gift-card tender that is not the saved plan',
        (s) => (s.frozen.totals.giftCardTender = 10),
      ],
      ['a negative amount', (s) => (s.frozen.totals.charge = -1)],
      ['a fractional amount', (s) => (s.frozen.lines[1].unitPrice = 299.5)],
      ['a zero quantity', (s) => (s.frozen.lines[1].quantity = 0)],
      ['a substituted product', (s) => (s.frozen.lines[1].productId = 'p-3')],
      [
        'a quantity that differs from the checkout',
        (s) => (s.lines[1].quantity = 2),
      ],
      ['a missing line', (s) => s.frozen.lines.pop()],
      ['another reward', (s) => (s.rewardId = 'r-2')],
      [
        'negative Beans',
        (s) => (s.frozen.loyalty = { earnBeans: -1, bonus: null }),
      ],
      ['a negative reward cost', (s) => (s.frozen.rewardPlan!.beanCost = -5)],
      [
        'a free item outside the frozen lines',
        (s) =>
          (s.frozen.rewardPlan!.freeItem = {
            productId: 'p-1',
            productName: 'Latte',
            lineIndex: 2,
          }),
      ],
      [
        'a free item naming another line’s product',
        (s) =>
          (s.frozen.rewardPlan!.freeItem = {
            productId: 'p-1',
            productName: 'Latte',
            lineIndex: 1,
          }),
      ],
      [
        'bonus items that do not add up to the bonus',
        (s) =>
          (s.frozen.loyalty = {
            earnBeans: 9,
            bonus: {
              totalBonusBeans: 10,
              items: [{ productId: 'p-1', bonusBeans: 4 }] as never,
            },
          }),
      ],
      [
        'a bonus for a product not in the order',
        (s) =>
          (s.frozen.loyalty = {
            earnBeans: 9,
            bonus: {
              totalBonusBeans: 4,
              items: [{ productId: 'p-9', bonusBeans: 4 }] as never,
            },
          }),
      ],
    ];
    it.each(cases)('%s', (_label, change, amount = 900) => {
      const s = saved();
      change(s);
      expect(() => verifyFrozenCheckout(s, payment(amount))).toThrow(
        FrozenCheckoutMismatchError,
      );
    });
  });
});
