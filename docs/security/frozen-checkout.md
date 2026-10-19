# Frozen checkout prices and tenant-scoped payment keys (ESP-03 PR 7)

A paid restaurant order is created from exactly what the customer was
charged for. It is never re-priced after the charge. This covers food-order
checkout only. Gift-card purchases, CENTERIVO's own SaaS billing and the
payment provider are unchanged, and no real payment processor is connected.

## Business-scoped payment keys (decision D1)

- `PaymentAttempt` gains a unique index on `(tenantId, idempotencyKey)`.
- The existing global unique key is kept for compatibility. No key can name
  payments of two businesses, and every existing row stays valid.
- Every lookup stays scoped to the business, and no payment record is
  changed.

## The frozen checkout (saved checkout version 2)

Before the provider is called, the server saves the checkout it validated and
priced (PR 4), now with a `frozen` block:

| Frozen    | Details                                                                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lines     | Product, name, quantity, unit price (modifiers included), line total, currency, and the chosen modifiers (group and option ids and names), in the order submitted |
| Totals    | Subtotal, promotion or coupon discount, Mocha Bean reward discount, gift-card tender, and the amount charged                                                      |
| Promotion | The validated promotion or coupon plan (decision D2)                                                                                                              |
| Reward    | The validated reward plan                                                                                                                                         |
| Loyalty   | The standard Beans and any bonus Beans the order earns (decision D4)                                                                                              |

A frozen checkout is at most 256 KB (the database backstop rose from 64 KB),
and it contains no card data, codes, credentials or payment keys.

## Creating the order

A customer retry, automatic recovery and support recovery all create the
order the same way, inside the PR 4 order transaction (attempt row locked,
payment definitively succeeded). Before anything is written:

1. **The arithmetic is verified.**
   - Every amount is a non-negative whole number of minor units.
   - Each line total is its unit price times its quantity.
   - The lines add up to the subtotal.
   - The discounts match their plans, and the tender matches the saved
     gift-card plan.
   - Subtotal minus discounts minus tender equals the amount charged, which
     equals the payment's amount, in the payment's currency.
   - The frozen lines are the submitted products and quantities, line by
     line, and the reward is the one chosen.
   - The reward's Bean cost is a non-negative whole number, a freed item
     names a frozen line of its own product, and the bonus Beans are the sum
     of their items, each for a product in the order.
2. **Operational restrictions are checked (decision D5).** The order is not
   created if:
   - the business is suspended;
   - the location no longer exists, is inactive, or no longer takes online
     orders.

   Suspension is checked here because automatic and support recovery do not
   pass through the storefront's request checks.

3. **Then the order is created from the frozen data,** whatever happened
   since to menu prices, modifiers, product names or availability,
   promotions, rewards, bonus promotions or the earning rate. The
   promotion's current limits are read with its row locked, so a limit
   changed at the same moment cannot be exceeded.

A product, category or modifier taken off the menu after payment does not
stop an already-paid order (D5: ordinary menu changes). Withdrawing an item
for safety reasons is handled by the restaurant with the customer, for
example through the order's normal cancellation and refund process once that
is enabled.

Each effect still happens at most once, in the same transaction:

- the promotion redemption;
- the Mocha Bean reward;
- the gift-card tender;
- the standard and bonus Beans.

The existing unique keys (one order per payment, one ledger entry per type
per order, one gift-card redemption per order) guarantee this under retries
and concurrency.

## When the order cannot be created

The payment is never re-priced and never charged again. It stays
`SUCCEEDED`, keeps its saved checkout, and its reconciliation case stays open
(`FULFILMENT_FAILED`) for a person to review. This happens when:

| Situation                                                                                           | Why                                                                                                                                    |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| The frozen arithmetic or items do not match the payment                                             | Never fulfil something other than what was charged                                                                                     |
| The promotion's redemption limit (overall or per customer) is reached, or the promotion was deleted | Configured limits are never exceeded (D2). The frozen discount is honoured once the limit allows, for example after support raises it. |
| The reward was deleted                                                                              | The frozen reward must still be one of this business's rewards                                                                         |
| The customer's Mocha Beans or the gift card no longer cover the frozen amount                       | Balances never go negative and nothing is redeemed twice (D3)                                                                          |
| The business is suspended or the location stopped taking online orders                              | Operational restrictions are not bypassed (D5)                                                                                         |

PR 5 recovery treats these as non-retryable: no automatic retries, and the
case is shown as needing attention. Once the cause is resolved, support
recovery creates the order from the same frozen checkout.

## Compatibility

- Version-1 saved checkouts (payments in flight before PR 7) are still read
  and fulfilled exactly as before: re-priced and re-validated, and kept for
  review if the price no longer matches the charge.
- New checkouts are always saved as version 2.

## Migration

`20261118090000_frozen_checkout` only adds things:

- the business-scoped unique index;
- a version check allowing 1 and 2 (previously 1);
- a 256 KB payload backstop (previously 64 KB).

A read-only preflight refuses, changing nothing, if the index already exists.
The rollback (`prisma/rollbacks/20261118090000_frozen_checkout.down.sql`,
never automatic) refuses while any version-2 or oversized saved checkout
exists, because an API without PR 7 could not read it. Tested on disposable
databases only.

## Remaining requirements before live restaurant payments

- **Pre-charge promotion allocation (D2).** A limited promotion's redemption
  is counted when the order is created, not when the customer is charged.
  Two customers can therefore both be charged with the last redemption, and
  the second is kept for review rather than fulfilled. Reserving the
  redemption before the charge, and releasing it on a definitive decline or
  failure, would remove that case. This is required before live restaurant
  payments if limited promotions will be offered.
- The same applies to Mocha Bean and gift-card balances spent between the
  charge and the order. Such a payment is held for review, never fulfilled
  with a negative balance.
- Plan features and the "taking sales" decision (SC2b / SC4b) are still made
  once, before the charge, and are not re-evaluated when the order is
  created.
