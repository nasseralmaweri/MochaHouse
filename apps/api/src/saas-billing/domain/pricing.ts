import type { PlatformBillingInterval } from '@mocha-house/contracts';

// SC3a — list-price input rules (pure). Prices are integer minor units in
// USD for now. An annual price is stored as its own amount; an operator may
// derive it from a configurable discount on twelve monthly payments — the
// discount is an input, never a constant.

export const SUPPORTED_CURRENCIES = ['USD'] as const;
export const MAX_PRICE_MINOR_UNITS = 100_000_000; // $1,000,000.00

export class PriceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceInputError';
  }
}

export type PriceCreateInput =
  | {
      interval: PlatformBillingInterval;
      currency: 'USD';
      amountMinorUnits: number;
    }
  | {
      interval: 'YEAR';
      currency: 'USD';
      annualDiscountBasisPoints: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePriceCreate(body: unknown): PriceCreateInput {
  if (!isRecord(body)) throw new PriceInputError('A price is required.');
  const allowed = new Set([
    'interval',
    'currency',
    'amountMinorUnits',
    'annualDiscountBasisPoints',
  ]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new PriceInputError(`Unknown field "${key}".`);
    }
  }
  const interval = body.interval;
  if (interval !== 'MONTH' && interval !== 'YEAR') {
    throw new PriceInputError('Interval must be MONTH or YEAR.');
  }
  const currency = body.currency ?? 'USD';
  if (currency !== 'USD') {
    throw new PriceInputError('Only USD prices are supported for now.');
  }
  const hasAmount = body.amountMinorUnits !== undefined;
  const hasDiscount = body.annualDiscountBasisPoints !== undefined;
  if (hasAmount === hasDiscount) {
    throw new PriceInputError(
      'Give either an amount or (for an annual price) an annual discount.',
    );
  }
  if (hasAmount) {
    const amount = body.amountMinorUnits;
    if (
      typeof amount !== 'number' ||
      !Number.isInteger(amount) ||
      amount < 1 ||
      amount > MAX_PRICE_MINOR_UNITS
    ) {
      throw new PriceInputError(
        'The amount must be a whole number of cents between 1 and 100,000,000.',
      );
    }
    return { interval, currency, amountMinorUnits: amount };
  }
  if (interval !== 'YEAR') {
    throw new PriceInputError('A discount applies only to an annual price.');
  }
  const bps = body.annualDiscountBasisPoints;
  if (
    typeof bps !== 'number' ||
    !Number.isInteger(bps) ||
    bps < 1 ||
    bps > 9999
  ) {
    throw new PriceInputError(
      'The annual discount must be 1–9999 basis points (0.01%–99.99%).',
    );
  }
  return { interval: 'YEAR', currency, annualDiscountBasisPoints: bps };
}

// Twelve monthly payments less the discount, rounded to the nearest cent
// (half up). Never below one cent.
export function annualAmountFromDiscount(
  monthlyAmountMinorUnits: number,
  discountBasisPoints: number,
): number {
  const gross = monthlyAmountMinorUnits * 12;
  const net = Math.round((gross * (10_000 - discountBasisPoints)) / 10_000);
  return Math.min(Math.max(net, 1), MAX_PRICE_MINOR_UNITS);
}

// Informational: the discount an annual price gives against twelve monthly
// payments, in basis points (0 when it is not cheaper).
export function annualDiscountBasisPoints(
  monthlyAmountMinorUnits: number,
  annualAmountMinorUnits: number,
): number {
  const gross = monthlyAmountMinorUnits * 12;
  if (gross <= 0 || annualAmountMinorUnits >= gross) return 0;
  return Math.round(((gross - annualAmountMinorUnits) * 10_000) / gross);
}

export interface BillingPolicyInput {
  trialDays: number;
  trialRequiresPaymentMethod: boolean;
  gracePeriodDays: number;
}

export function parseBillingPolicy(body: unknown): BillingPolicyInput {
  if (!isRecord(body)) throw new PriceInputError('A policy is required.');
  const allowed = new Set([
    'trialDays',
    'trialRequiresPaymentMethod',
    'gracePeriodDays',
  ]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new PriceInputError(`Unknown field "${key}".`);
    }
  }
  const { trialDays, trialRequiresPaymentMethod, gracePeriodDays } = body;
  if (
    typeof trialDays !== 'number' ||
    !Number.isInteger(trialDays) ||
    trialDays < 0 ||
    trialDays > 90
  ) {
    throw new PriceInputError(
      'Trial days must be a whole number from 0 to 90.',
    );
  }
  if (typeof trialRequiresPaymentMethod !== 'boolean') {
    throw new PriceInputError('Say whether a trial requires a payment method.');
  }
  if (
    typeof gracePeriodDays !== 'number' ||
    !Number.isInteger(gracePeriodDays) ||
    gracePeriodDays < 1 ||
    gracePeriodDays > 60
  ) {
    throw new PriceInputError(
      'Grace period days must be a whole number from 1 to 60.',
    );
  }
  return { trialDays, trialRequiresPaymentMethod, gracePeriodDays };
}
