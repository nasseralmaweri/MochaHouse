import {
  prepareReorder,
  type HistoricalReorderLine,
} from '@mocha-house/domain';
import type { LocationMenuResponse } from '@mocha-house/contracts';

// Pure unit tests for the reorder preparation logic — no DB, no HTTP.
// Same "the live menu is the only authority" boundary priceCart has.

function buildMenu(overrides: {
  isDigitalOrderingEnabled?: boolean;
  productAvailable?: boolean;
  effectivePrice?: number | null;
  sizeOptions?: {
    id: string;
    name: string;
    priceAdjustment: number;
    displayOrder: number;
  }[];
  extraRequiredGroup?: boolean;
  includeProduct?: boolean;
}): LocationMenuResponse {
  const sizeOptions = overrides.sizeOptions ?? [
    { id: 'opt-small', name: 'Small', priceAdjustment: 0, displayOrder: 1 },
    { id: 'opt-medium', name: 'Medium', priceAdjustment: 50, displayOrder: 2 },
    { id: 'opt-large', name: 'Large', priceAdjustment: 100, displayOrder: 3 },
  ];

  const modifierGroups = [
    {
      id: 'group-size',
      name: 'Size',
      displayOrder: 1,
      isRequired: true,
      minSelections: 1,
      maxSelections: 1,
      options: sizeOptions,
    },
    {
      id: 'group-milk',
      name: 'Milk',
      displayOrder: 2,
      isRequired: false,
      minSelections: 0,
      maxSelections: 1,
      options: [
        {
          id: 'opt-oat',
          name: 'Oat Milk',
          priceAdjustment: 70,
          displayOrder: 1,
        },
        {
          id: 'opt-almond',
          name: 'Almond Milk',
          priceAdjustment: 70,
          displayOrder: 2,
        },
      ],
    },
  ];

  if (overrides.extraRequiredGroup) {
    modifierGroups.push({
      id: 'group-strength',
      name: 'Strength',
      displayOrder: 3,
      isRequired: true,
      minSelections: 1,
      maxSelections: 1,
      options: [
        {
          id: 'opt-regular',
          name: 'Regular',
          priceAdjustment: 0,
          displayOrder: 1,
        },
        {
          id: 'opt-strong',
          name: 'Strong',
          priceAdjustment: 0,
          displayOrder: 2,
        },
      ],
    });
  }

  const products =
    overrides.includeProduct === false
      ? []
      : [
          {
            displayOrder: 1,
            effectivePrice:
              overrides.effectivePrice === undefined
                ? 350
                : overrides.effectivePrice,
            isAvailable: overrides.productAvailable ?? true,
            product: {
              id: 'product-1',
              name: 'Latte',
              slug: 'latte',
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
            modifierGroups,
          },
        ];

  return {
    location: {
      id: 'loc-1',
      name: 'Test Location',
      slug: 'test-location',
      isDigitalOrderingEnabled: overrides.isDigitalOrderingEnabled ?? true,
    },
    menu: { id: 'menu-1', name: 'Main Menu', slug: 'main-menu', products },
  };
}

function historicalLine(
  overrides: Partial<HistoricalReorderLine> = {},
): HistoricalReorderLine {
  return {
    productId: 'product-1',
    productName: 'Latte',
    quantity: 2,
    unitPrice: 400, // 350 base + 50 medium
    currency: 'USD',
    selections: [
      {
        groupId: 'group-size',
        groupName: 'Size',
        optionIds: ['opt-medium'],
        optionNames: ['Medium'],
      },
    ],
    ...overrides,
  };
}

describe('prepareReorder', () => {
  it('marks a fully unchanged order READY with current prices and current ids', () => {
    const result = prepareReorder(buildMenu({}), [historicalLine()]);

    expect(result.status).toBe('READY');
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.status).toBe('VALID');
    expect(item.quantity).toBe(2);
    expect(item.currentUnitPrice).toBe(400);
    expect(item.currentLineSubtotal).toBe(800);
    expect(item.selections).toEqual([
      {
        groupId: 'group-size',
        groupName: 'Size',
        optionIds: ['opt-medium'],
        optionNames: ['Medium'],
      },
    ]);
    expect(item.issues).toEqual([]);
    expect(result.currentEstimatedSubtotal).toBe(800);
  });

  it('uses the current effective price, not the historical one, and reports the change', () => {
    // Historical unit was 400; base price is now 500 -> current unit 550.
    const result = prepareReorder(buildMenu({ effectivePrice: 500 }), [
      historicalLine(),
    ]);

    const item = result.items[0];
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(item.status).toBe('CHANGED');
    expect(item.currentUnitPrice).toBe(550);
    expect(item.historicalUnitPrice).toBe(400);
    expect(item.issues.map((i) => i.code)).toContain('PRICE_CHANGED');
  });

  it('uses the current modifier price delta', () => {
    const result = prepareReorder(
      buildMenu({
        sizeOptions: [
          {
            id: 'opt-small',
            name: 'Small',
            priceAdjustment: 0,
            displayOrder: 1,
          },
          {
            id: 'opt-medium',
            name: 'Medium',
            priceAdjustment: 120, // was 50
            displayOrder: 2,
          },
        ],
      }),
      [historicalLine()],
    );
    const item = result.items[0];
    expect(item.currentUnitPrice).toBe(470); // 350 + 120
    expect(item.issues.map((i) => i.code)).toContain('PRICE_CHANGED');
  });

  it('marks a product that is gone from the menu UNAVAILABLE without substituting', () => {
    const result = prepareReorder(buildMenu({ includeProduct: false }), [
      historicalLine(),
    ]);
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.items[0].status).toBe('UNAVAILABLE');
    expect(result.items[0].issues[0].code).toBe('PRODUCT_NOT_ON_MENU');
    expect(result.items[0].currentUnitPrice).toBeUndefined();
    expect(result.currentEstimatedSubtotal).toBe(0);
  });

  it('marks an unavailable product UNAVAILABLE', () => {
    const result = prepareReorder(buildMenu({ productAvailable: false }), [
      historicalLine(),
    ]);
    expect(result.items[0].status).toBe('UNAVAILABLE');
    expect(result.items[0].issues[0].code).toBe('PRODUCT_UNAVAILABLE');
  });

  it('reports a removed historical modifier option and drops it (never substitutes)', () => {
    const result = prepareReorder(
      buildMenu({
        // "opt-medium" no longer exists.
        sizeOptions: [
          {
            id: 'opt-small',
            name: 'Small',
            priceAdjustment: 0,
            displayOrder: 1,
          },
          {
            id: 'opt-large',
            name: 'Large',
            priceAdjustment: 100,
            displayOrder: 2,
          },
        ],
      }),
      [historicalLine()],
    );
    const item = result.items[0];
    expect(item.status).toBe('CHANGED');
    // Removed option reported...
    expect(item.issues.map((i) => i.code)).toContain('MODIFIER_OPTION_REMOVED');
    // ...and because Size is required and now has 0 selections, review needed.
    expect(item.issues.map((i) => i.code)).toContain(
      'MODIFIER_REQUIRED_SELECTION_MISSING',
    );
    expect(item.needsCustomization).toBe(true);
    expect(item.selections).toEqual([]);
  });

  it('reports a removed modifier GROUP', () => {
    const result = prepareReorder(buildMenu({}), [
      historicalLine({
        selections: [
          {
            groupId: 'group-size',
            groupName: 'Size',
            optionIds: ['opt-medium'],
            optionNames: ['Medium'],
          },
          {
            groupId: 'group-syrup-GONE',
            groupName: 'Syrup',
            optionIds: ['opt-vanilla'],
            optionNames: ['Vanilla'],
          },
        ],
      }),
    ]);
    const item = result.items[0];
    expect(item.status).toBe('CHANGED');
    expect(item.issues.map((i) => i.code)).toContain('MODIFIER_GROUP_REMOVED');
    // Size still resolves fine.
    expect(item.selections.map((s) => s.groupId)).toEqual(['group-size']);
  });

  it('flags a NEW required group the historical order never had, without inventing a default', () => {
    const result = prepareReorder(buildMenu({ extraRequiredGroup: true }), [
      historicalLine(),
    ]);
    const item = result.items[0];
    expect(item.status).toBe('CHANGED');
    expect(item.needsCustomization).toBe(true);
    expect(item.issues.map((i) => i.code)).toContain(
      'MODIFIER_REQUIRED_SELECTION_MISSING',
    );
    // No "Strength" selection was invented.
    expect(item.selections.map((s) => s.groupId)).not.toContain(
      'group-strength',
    );
  });

  it('enforces current max-selection rules against the historical selection', () => {
    const result = prepareReorder(buildMenu({}), [
      historicalLine({
        selections: [
          {
            groupId: 'group-size',
            groupName: 'Size',
            optionIds: ['opt-small', 'opt-medium'], // 2 > current max 1
            optionNames: ['Small', 'Medium'],
          },
        ],
      }),
    ]);
    const item = result.items[0];
    expect(item.issues.map((i) => i.code)).toContain(
      'MODIFIER_SELECTION_COUNT_INVALID',
    );
    expect(item.needsCustomization).toBe(true);
  });

  it('preserves valid items when another item in the same order is unavailable (partial reorder)', () => {
    const menu = buildMenu({});
    const result = prepareReorder(menu, [
      historicalLine(), // valid
      historicalLine({ productId: 'ghost-product', productName: 'Old Muffin' }),
    ]);
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.items[0].status).toBe('VALID');
    expect(result.items[1].status).toBe('UNAVAILABLE');
    // Estimate counts only the restorable item.
    expect(result.currentEstimatedSubtotal).toBe(800);
  });
});
