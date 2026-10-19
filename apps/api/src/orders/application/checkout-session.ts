import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { CheckoutLineInput } from '@mocha-house/contracts';

// ESP-03 PR 6 — server-owned checkout sessions and server-generated payment
// keys.
//
//   * A checkout session is created by the server; the caller holds a random
//     256-bit token (`cs_` + 43 base64url characters). Only its SHA-256 hash
//     is stored, so a database reader cannot use a session.
//   * Every payment attempt's idempotency key is generated here, by the
//     server (`ck_` for checkout, `gc_` for gift cards + 256 random bits). A
//     client never supplies one, so a client can never choose, reuse or
//     collide with another payment's key.
//   * The request fingerprint is an HMAC-SHA256, keyed with the session's own
//     token, over the canonical, server-validated, order-defining checkout:
//     business, location, customer, guest / order details, every line with
//     its quantity and modifier choices, reward, coupon and gift card. Keyed
//     with the token (never stored), it cannot be reversed from the database
//     even for low-entropy inputs such as a phone number. It is never logged.

export const CHECKOUT_TOKEN_PATTERN = /^cs_[A-Za-z0-9_-]{43}$/;

// New payment attempts are accepted for 24 hours after a session starts; the
// token is recognised for replays (a retry, a lost response) for 7 days.
export const CHECKOUT_SESSION_NEW_ATTEMPTS_MS = 24 * 60 * 60 * 1000;
export const CHECKOUT_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export function generateCheckoutToken(): string {
  return `cs_${randomBytes(32).toString('base64url')}`;
}

export function hashCheckoutToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generatePaymentKey(kind: 'ck' | 'gc'): string {
  return `${kind}_${randomBytes(32).toString('base64url')}`;
}

export interface CheckoutIdentityInput {
  tenantId: string;
  locationId: string;
  customerId: string | null;
  guest: { name: string; phone: string; email?: string | null };
  lines: CheckoutLineInput[];
  rewardId: string | null;
  couponCode: string | null;
  giftCardCode: string | null;
}

// The canonical form: fixed key order, values normalised exactly as the
// order will record them (the saved checkout trims guest details); modifier
// choices sorted so the same choices in another order are the same checkout.
// Line order is kept: it is the order of the lines on the order.
export function canonicalCheckout(input: CheckoutIdentityInput): string {
  return JSON.stringify([
    'v1',
    input.tenantId,
    input.locationId,
    input.customerId,
    [
      input.guest.name.trim(),
      input.guest.phone.trim(),
      input.guest.email?.trim() || null,
    ],
    input.lines.map((line) => [
      line.productId,
      line.quantity,
      [...line.selections]
        .map((s) => [s.groupId, [...s.optionIds].sort()] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    ]),
    input.rewardId,
    input.couponCode,
    input.giftCardCode,
  ]);
}

export function checkoutFingerprint(
  token: string,
  input: CheckoutIdentityInput,
): string {
  return createHmac('sha256', token)
    .update(canonicalCheckout(input), 'utf8')
    .digest('hex');
}
