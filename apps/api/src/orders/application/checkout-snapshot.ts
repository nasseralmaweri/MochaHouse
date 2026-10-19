import type { CheckoutLineInput } from '@mocha-house/contracts';
import type { StorefrontFeatures } from '../../subscriptions/application/storefront-features.service';
import type { GiftCardTenderPlan } from '../../gift-cards/application/gift-card-redemption.service';
import type { RegularDiscountPlan } from '../../promotions/application/promotion-checkout.service';
import type { RedemptionPlan } from '../../loyalty/application/loyalty-redemption.service';
import type { LoyaltyBonusPlan } from '../../loyalty/application/loyalty-bonus.service';

// ESP-03 PR 4 — the saved checkout (CheckoutSnapshot.payload, version 1).
//
// Everything the order transaction needs, decided and validated by the
// server BEFORE the payment provider is called, and nothing else:
//   * the location and the cart lines with their choices (ids only);
//   * the guest contact as it will appear on the order (trimmed);
//   * the customer, the chosen reward and the normalised coupon code;
//   * the gift-card tender plan — the card's id, last four and amount,
//     NEVER its code (a code is a bearer secret);
//   * the plan features decided at checkout, carried as-is so a plan change
//     while the payment is processed cannot change the order.
// No card data, credentials, idempotency keys or provider secrets. The
// order is always created from THIS data — never from a retried request.

export const CHECKOUT_SNAPSHOT_VERSION = 1;

export interface CheckoutSnapshotPayload {
  locationId: string;
  lines: CheckoutLineInput[];
  guest: { name: string; phone: string; email: string | null };
  customerId: string | null;
  rewardId: string | null;
  couponCode: string | null;
  giftCardPlan: {
    giftCardId: string;
    last4: string;
    currency: string;
    plannedTenderMinorUnits: number;
  } | null;
  features: StorefrontFeatures;
}

export function buildCheckoutSnapshot(input: {
  locationId: string;
  lines: CheckoutLineInput[];
  guest: { name: string; phone: string; email?: string | null };
  customerId: string | null;
  rewardId: string | null;
  couponCode: string | null;
  giftCardPlan: GiftCardTenderPlan | null;
  features: StorefrontFeatures;
}): CheckoutSnapshotPayload {
  return {
    locationId: input.locationId,
    // Only the validated fields of each line — anything else the client
    // sent is not part of the order and is not kept.
    lines: input.lines.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      selections: line.selections.map((selection) => ({
        groupId: selection.groupId,
        optionIds: [...selection.optionIds],
      })),
    })),
    guest: {
      name: input.guest.name.trim(),
      phone: input.guest.phone.trim(),
      email: input.guest.email?.trim() || null,
    },
    customerId: input.customerId,
    rewardId: input.rewardId,
    couponCode: input.couponCode,
    giftCardPlan: input.giftCardPlan
      ? {
          giftCardId: input.giftCardPlan.giftCardId,
          last4: input.giftCardPlan.last4,
          currency: input.giftCardPlan.currency,
          plannedTenderMinorUnits: input.giftCardPlan.plannedTenderMinorUnits,
        }
      : null,
    features: { ...input.features },
  };
}

export class UnreadableCheckoutSnapshotError extends Error {
  constructor() {
    super('The saved checkout could not be read.');
    this.name = 'UnreadableCheckoutSnapshotError';
  }
}

// Reads a saved checkout back. Anything not in the exact version-1 shape is
// refused (never guessed): the payment then stays for review.
export function readCheckoutSnapshot(
  version: number,
  raw: unknown,
): CheckoutSnapshotPayload {
  if (version !== CHECKOUT_SNAPSHOT_VERSION || !isRecord(raw)) {
    throw new UnreadableCheckoutSnapshotError();
  }
  const { locationId, lines, guest, customerId, rewardId, couponCode } = raw;
  const giftCardPlan = raw.giftCardPlan;
  const features = raw.features;
  const ok =
    typeof locationId === 'string' &&
    Array.isArray(lines) &&
    lines.length > 0 &&
    lines.every(isLine) &&
    isRecord(guest) &&
    typeof guest.name === 'string' &&
    typeof guest.phone === 'string' &&
    (guest.email === null || typeof guest.email === 'string') &&
    isNullableString(customerId) &&
    isNullableString(rewardId) &&
    isNullableString(couponCode) &&
    (giftCardPlan === null || isGiftCardPlan(giftCardPlan)) &&
    isRecord(features) &&
    Object.values(features).every((value) => typeof value === 'boolean');
  if (!ok) {
    throw new UnreadableCheckoutSnapshotError();
  }
  return raw as unknown as CheckoutSnapshotPayload;
}

// The gift-card tender plan the order transaction applies, rebuilt from the
// saved checkout; the card is always the payment's own business's.
export function giftCardPlanOf(
  snapshot: CheckoutSnapshotPayload,
  tenantId: string,
): GiftCardTenderPlan | null {
  return snapshot.giftCardPlan ? { tenantId, ...snapshot.giftCardPlan } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isLine(value: unknown): value is CheckoutLineInput {
  return (
    isRecord(value) &&
    typeof value.productId === 'string' &&
    typeof value.quantity === 'number' &&
    Number.isInteger(value.quantity) &&
    Array.isArray(value.selections) &&
    value.selections.every(
      (selection) =>
        isRecord(selection) &&
        typeof selection.groupId === 'string' &&
        Array.isArray(selection.optionIds) &&
        selection.optionIds.every((id) => typeof id === 'string'),
    )
  );
}

function isGiftCardPlan(
  value: unknown,
): value is NonNullable<CheckoutSnapshotPayload['giftCardPlan']> {
  return (
    isRecord(value) &&
    typeof value.giftCardId === 'string' &&
    typeof value.last4 === 'string' &&
    typeof value.currency === 'string' &&
    typeof value.plannedTenderMinorUnits === 'number' &&
    Number.isInteger(value.plannedTenderMinorUnits)
  );
}

// --- ESP-03 PR 7: the frozen checkout (version 2) -----------------------------
//
// Everything the server validated and priced before the charge, frozen in
// the saved checkout so the order is created from it EXACTLY — never
// re-priced, whatever later happens to menu prices, modifiers, promotions or
// rewards:
//   * every line: product, name, quantity, unit price (modifiers included),
//     line total, currency and the chosen modifiers (names and ids);
//   * the subtotal, the regular discount (promotion / coupon plan), the
//     reward plan, the gift-card tender and the amount charged;
//   * the loyalty Beans the order earns (standard and bonus), computed at
//     checkout and only applied when the order is created.
// The frozen arithmetic is verified against the payment before the order is
// created (verifyFrozenCheckout). Version 1 (ids only, re-priced at
// fulfilment) stays readable for payments already in flight.

export const LEGACY_CHECKOUT_SNAPSHOT_VERSION = 1;
export const FROZEN_CHECKOUT_SNAPSHOT_VERSION = 2;

export interface FrozenLine {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  currency: string;
  selections: { groupName: string; optionNames: string[] }[];
  selectionSnapshots: {
    groupId: string;
    groupName: string;
    optionIds: string[];
    optionNames: string[];
  }[];
}

export interface FrozenCheckout {
  currency: string;
  lines: FrozenLine[];
  subtotal: number;
  regularPlan: RegularDiscountPlan | null;
  rewardPlan: RedemptionPlan | null;
  // null when nothing is earned (a guest, or loyalty not in the plan).
  loyalty: { earnBeans: number; bonus: LoyaltyBonusPlan | null } | null;
  totals: {
    subtotal: number;
    promotionDiscount: number;
    rewardDiscount: number;
    giftCardTender: number;
    charge: number;
  };
}

export type SavedCheckout = CheckoutSnapshotPayload & {
  // Present on version 2 only.
  frozen?: FrozenCheckout;
};

export function freezeCheckout(input: {
  currency: string;
  lines: FrozenLine[];
  subtotal: number;
  regularPlan: RegularDiscountPlan | null;
  rewardPlan: RedemptionPlan | null;
  giftCardTender: number;
  charge: number;
  loyalty: FrozenCheckout['loyalty'];
}): FrozenCheckout {
  return {
    currency: input.currency,
    lines: input.lines.map((line) => ({
      productId: line.productId,
      productName: line.productName,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      currency: line.currency,
      selections: line.selections.map((s) => ({
        groupName: s.groupName,
        optionNames: [...s.optionNames],
      })),
      selectionSnapshots: line.selectionSnapshots.map((s) => ({
        groupId: s.groupId,
        groupName: s.groupName,
        optionIds: [...s.optionIds],
        optionNames: [...s.optionNames],
      })),
    })),
    subtotal: input.subtotal,
    regularPlan: input.regularPlan ? { ...input.regularPlan } : null,
    rewardPlan: input.rewardPlan ? { ...input.rewardPlan } : null,
    loyalty: input.loyalty,
    totals: {
      subtotal: input.subtotal,
      promotionDiscount: input.regularPlan?.discountMinorUnits ?? 0,
      rewardDiscount: input.rewardPlan?.discountMinorUnits ?? 0,
      giftCardTender: input.giftCardTender,
      charge: input.charge,
    },
  };
}

// Reads a saved checkout of either version. Anything not in the exact shape
// of its version is refused (never guessed): the payment then stays for
// review.
export function readSavedCheckout(
  version: number,
  raw: unknown,
): SavedCheckout {
  if (version === LEGACY_CHECKOUT_SNAPSHOT_VERSION) {
    return readCheckoutSnapshot(version, raw);
  }
  if (version !== FROZEN_CHECKOUT_SNAPSHOT_VERSION || !isRecord(raw)) {
    throw new UnreadableCheckoutSnapshotError();
  }
  const { frozen, ...base } = raw;
  const checkout = readCheckoutSnapshot(LEGACY_CHECKOUT_SNAPSHOT_VERSION, base);
  if (!isFrozenCheckout(frozen)) {
    throw new UnreadableCheckoutSnapshotError();
  }
  return { ...checkout, frozen };
}

// Thrown when a frozen checkout does not add up, or does not match what was
// charged: the order is never created from it (the payment stays for
// review).
export class FrozenCheckoutMismatchError extends Error {
  constructor(reason: string) {
    super(`The frozen checkout does not match the payment (${reason}).`);
    this.name = 'FrozenCheckoutMismatchError';
  }
}

// The frozen arithmetic, and its agreement with the payment and with the
// saved checkout's own inputs. Every amount is a non-negative integer in
// minor units.
export function verifyFrozenCheckout(
  checkout: SavedCheckout & { frozen: FrozenCheckout },
  payment: { amount: number; currency: string },
): void {
  const f = checkout.frozen;
  const fail = (reason: string): never => {
    throw new FrozenCheckoutMismatchError(reason);
  };
  const amounts = [
    f.subtotal,
    f.totals.subtotal,
    f.totals.promotionDiscount,
    f.totals.rewardDiscount,
    f.totals.giftCardTender,
    f.totals.charge,
  ];
  if (!amounts.every(isMinorUnits)) fail('amounts');
  if (f.lines.length === 0) fail('no lines');
  for (const line of f.lines) {
    if (
      !isMinorUnits(line.unitPrice) ||
      !isMinorUnits(line.lineTotal) ||
      !Number.isInteger(line.quantity) ||
      line.quantity < 1 ||
      line.lineTotal !== line.unitPrice * line.quantity ||
      line.currency !== f.currency
    ) {
      fail('line');
    }
  }
  const lineSum = f.lines.reduce((sum, line) => sum + line.lineTotal, 0);
  if (lineSum !== f.subtotal || f.totals.subtotal !== f.subtotal) {
    fail('subtotal');
  }
  if (f.totals.promotionDiscount !== (f.regularPlan?.discountMinorUnits ?? 0)) {
    fail('promotion discount');
  }
  if (f.totals.rewardDiscount !== (f.rewardPlan?.discountMinorUnits ?? 0)) {
    fail('reward discount');
  }
  if (
    f.totals.giftCardTender !==
    (checkout.giftCardPlan?.plannedTenderMinorUnits ?? 0)
  ) {
    fail('gift-card tender');
  }
  if (
    f.subtotal -
      f.totals.promotionDiscount -
      f.totals.rewardDiscount -
      f.totals.giftCardTender !==
    f.totals.charge
  ) {
    fail('total');
  }
  if (f.totals.charge !== payment.amount) fail('amount charged');
  if (f.currency !== payment.currency) fail('currency');
  // The frozen order is the one the customer submitted: the same products
  // and quantities, line by line, as the saved checkout's lines.
  if (
    f.lines.length !== checkout.lines.length ||
    f.lines.some(
      (line, i) =>
        line.productId !== checkout.lines[i].productId ||
        line.quantity !== checkout.lines[i].quantity,
    )
  ) {
    fail('lines differ from the checkout');
  }
  if ((f.rewardPlan?.rewardId ?? null) !== checkout.rewardId) fail('reward');
  if (f.rewardPlan !== null && !isMinorUnits(f.rewardPlan.beanCost)) {
    fail('reward cost');
  }
  // A freed unit (FREE_ITEM promotion or reward) names a frozen line of its
  // own product.
  for (const freeItem of [f.regularPlan?.freeItem, f.rewardPlan?.freeItem]) {
    if (
      freeItem &&
      (!Number.isInteger(freeItem.lineIndex) ||
        freeItem.lineIndex < 0 ||
        freeItem.lineIndex >= f.lines.length ||
        f.lines[freeItem.lineIndex].productId !== freeItem.productId)
    ) {
      fail('free item');
    }
  }
  if (f.loyalty !== null) {
    const bonus = f.loyalty.bonus;
    if (
      !isMinorUnits(f.loyalty.earnBeans) ||
      (bonus !== null &&
        (!isMinorUnits(bonus.totalBonusBeans) ||
          !bonus.items.every(
            (item) =>
              isMinorUnits(item.bonusBeans) &&
              f.lines.some((line) => line.productId === item.productId),
          ) ||
          bonus.items.reduce((sum, item) => sum + item.bonusBeans, 0) !==
            bonus.totalBonusBeans))
    ) {
      fail('loyalty');
    }
  }
}

function isMinorUnits(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isFrozenLine(value: unknown): value is FrozenLine {
  return (
    isRecord(value) &&
    typeof value.productId === 'string' &&
    typeof value.productName === 'string' &&
    typeof value.currency === 'string' &&
    typeof value.quantity === 'number' &&
    typeof value.unitPrice === 'number' &&
    typeof value.lineTotal === 'number' &&
    Array.isArray(value.selections) &&
    value.selections.every(
      (s) =>
        isRecord(s) &&
        typeof s.groupName === 'string' &&
        isStringArray(s.optionNames),
    ) &&
    Array.isArray(value.selectionSnapshots) &&
    value.selectionSnapshots.every(
      (s) =>
        isRecord(s) &&
        typeof s.groupId === 'string' &&
        typeof s.groupName === 'string' &&
        isStringArray(s.optionIds) &&
        isStringArray(s.optionNames),
    )
  );
}

function isFrozenCheckout(value: unknown): value is FrozenCheckout {
  if (!isRecord(value)) return false;
  const totals = value.totals;
  const loyalty = value.loyalty;
  return (
    typeof value.currency === 'string' &&
    Array.isArray(value.lines) &&
    value.lines.every(isFrozenLine) &&
    typeof value.subtotal === 'number' &&
    (value.regularPlan === null ||
      (isRecord(value.regularPlan) &&
        typeof value.regularPlan.promotionId === 'string' &&
        typeof value.regularPlan.discountMinorUnits === 'number')) &&
    (value.rewardPlan === null ||
      (isRecord(value.rewardPlan) &&
        typeof value.rewardPlan.rewardId === 'string' &&
        typeof value.rewardPlan.beanCost === 'number' &&
        typeof value.rewardPlan.discountMinorUnits === 'number')) &&
    (loyalty === null ||
      (isRecord(loyalty) &&
        typeof loyalty.earnBeans === 'number' &&
        (loyalty.bonus === null ||
          (isRecord(loyalty.bonus) &&
            typeof loyalty.bonus.totalBonusBeans === 'number' &&
            Array.isArray(loyalty.bonus.items))))) &&
    isRecord(totals) &&
    [
      'subtotal',
      'promotionDiscount',
      'rewardDiscount',
      'giftCardTender',
      'charge',
    ].every((key) => typeof totals[key] === 'number')
  );
}
