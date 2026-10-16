import { SetMetadata } from '@nestjs/common';

// SC3c-1 — staff of a business suspended for BILLING (never SECURITY or
// REQUESTED) keep a narrow operational wind-down: their session is admitted
// ONLY to routes marked with this decorator (see InternalAuthGuard). Every
// other admin route — including any route added later — refuses it with 403
// BUSINESS_BILLING_SUSPENDED (fail closed). Only routes that finish what the
// business already took on belong here: viewing and completing previously
// accepted orders, refunds/reversals through the existing order-closure
// safeguards, and the billing page. Never new sales, gift-card issuance,
// promotions, loyalty activity or general administration.
export const BILLING_WIND_DOWN_ALLOWED = 'billing-wind-down-allowed';

export const AllowDuringBillingWindDown = () =>
  SetMetadata(BILLING_WIND_DOWN_ALLOWED, true);
