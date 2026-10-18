import type { CheckoutLineInput } from '@mocha-house/contracts';
import type { StorefrontFeatures } from '../../subscriptions/application/storefront-features.service';
import type { GiftCardTenderPlan } from '../../gift-cards/application/gift-card-redemption.service';

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
