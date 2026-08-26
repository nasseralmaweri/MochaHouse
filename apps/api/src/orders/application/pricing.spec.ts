import { priceCart } from '@mocha-house/domain';
import type { LocationMenuResponse } from '@mocha-house/contracts';

// Pure unit tests for the authoritative repricing/validation function used
// by checkout — no database, no HTTP. This is what actually stands between
// a client-submitted cart and what gets charged, so every rejection path
// is exercised here directly, in addition to being exercised indirectly
// through the checkout integration test.

function buildMenu(
  overrides: {
    isDigitalOrderingEnabled?: boolean;
    isAvailable?: boolean;
    effectivePrice?: number | null;
  } = {},
): LocationMenuResponse {
  return {
    location: {
      id: 'loc-1',
      name: 'Test Location',
      slug: 'test-location',
      isDigitalOrderingEnabled: overrides.isDigitalOrderingEnabled ?? true,
    },
    menu: {
      id: 'menu-1',
      name: 'Main Menu',
      slug: 'main-menu',
      products: [
        {
          displayOrder: 1,
          effectivePrice:
            overrides.effectivePrice === undefined
              ? 350
              : overrides.effectivePrice,
          isAvailable: overrides.isAvailable ?? true,
          product: {
            id: 'product-1',
            name: 'Drip Coffee',
            slug: 'drip-coffee',
            description: null,
            basePrice: 350,
            currency: 'USD',
            category: {
              id: 'cat-1',
              name: 'Coffee',
              slug: 'coffee',
              displayOrder: 1,
            },
          },
          modifierGroups: [
            {
              id: 'group-size',
              name: 'Size',
              displayOrder: 1,
              isRequired: true,
              minSelections: 1,
              maxSelections: 1,
              options: [
                {
                  id: 'opt-small',
                  name: 'Small',
                  priceAdjustment: 0,
                  displayOrder: 1,
                },
                {
                  id: 'opt-medium',
                  name: 'Medium',
                  priceAdjustment: 50,
                  displayOrder: 2,
                },
                {
                  id: 'opt-large',
                  name: 'Large',
                  priceAdjustment: 100,
                  displayOrder: 3,
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

describe('priceCart', () => {
  it('computes unit price and subtotal from the live menu, ignoring any client-side price', () => {
    const result = priceCart(buildMenu(), [
      {
        productId: 'product-1',
        quantity: 2,
        selections: [{ groupId: 'group-size', optionIds: ['opt-medium'] }],
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 350 base + 50 medium adjustment = 400/unit, x2 quantity = 800.
    expect(result.lines[0].unitPrice).toBe(400);
    expect(result.lines[0].lineTotal).toBe(800);
    expect(result.subtotal).toBe(800);
    expect(result.currency).toBe('USD');
  });

  it('rejects when digital ordering is disabled at the location', () => {
    const result = priceCart(buildMenu({ isDigitalOrderingEnabled: false }), [
      {
        productId: 'product-1',
        quantity: 1,
        selections: [{ groupId: 'group-size', optionIds: ['opt-small'] }],
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DIGITAL_ORDERING_DISABLED');
  });

  it('rejects an empty cart', () => {
    const result = priceCart(buildMenu(), []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EMPTY_CART');
  });

  it('rejects a product that is not on the menu', () => {
    const result = priceCart(buildMenu(), [
      { productId: 'unknown-product', quantity: 1, selections: [] },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRODUCT_NOT_ON_MENU');
  });

  it('rejects a product marked unavailable at the location', () => {
    const result = priceCart(buildMenu({ isAvailable: false }), [
      {
        productId: 'product-1',
        quantity: 1,
        selections: [{ groupId: 'group-size', optionIds: ['opt-small'] }],
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRODUCT_UNAVAILABLE');
  });

  it('rejects a product with no effective price', () => {
    const result = priceCart(buildMenu({ effectivePrice: null }), [
      {
        productId: 'product-1',
        quantity: 1,
        selections: [{ groupId: 'group-size', optionIds: ['opt-small'] }],
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRODUCT_UNAVAILABLE');
  });

  it('rejects a required modifier group left unselected', () => {
    const result = priceCart(buildMenu(), [
      { productId: 'product-1', quantity: 1, selections: [] },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MODIFIER_SELECTION_COUNT_INVALID');
  });

  it('rejects more selections than maxSelections allows', () => {
    const result = priceCart(buildMenu(), [
      {
        productId: 'product-1',
        quantity: 1,
        selections: [
          { groupId: 'group-size', optionIds: ['opt-small', 'opt-medium'] },
        ],
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MODIFIER_SELECTION_COUNT_INVALID');
  });

  it('rejects an option id that does not exist on the group', () => {
    const result = priceCart(buildMenu(), [
      {
        productId: 'product-1',
        quantity: 1,
        selections: [
          { groupId: 'group-size', optionIds: ['opt-does-not-exist'] },
        ],
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MODIFIER_OPTION_NOT_FOUND');
  });

  it('rejects an invalid quantity', () => {
    const result = priceCart(buildMenu(), [
      {
        productId: 'product-1',
        quantity: 0,
        selections: [{ groupId: 'group-size', optionIds: ['opt-small'] }],
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_QUANTITY');
  });

  it('dedupes a duplicated option id within a group before counting it', () => {
    const result = priceCart(buildMenu(), [
      {
        productId: 'product-1',
        quantity: 1,
        selections: [
          { groupId: 'group-size', optionIds: ['opt-small', 'opt-small'] },
        ],
      },
    ]);
    // Deduped to a single selection, which satisfies max=1.
    expect(result.ok).toBe(true);
  });
});
