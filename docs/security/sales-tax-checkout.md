# Sales tax at checkout (V1 Sales Tax PR 2)

Checkout calculates sales tax from each location's **confirmed** tax settings
(PR 1), includes it in what the customer pays, and keeps an immutable record
of the calculation on the order. Tax reporting and item-specific refunds come
in PR 3.

## The switch

`SALES_TAX_ENABLED` must be exactly `"1"`. It is read on every request, like
`ORDER_CLOSURE_ENABLED`.

| Switch | New checkouts |
| --- | --- |
| Off (default) | Exactly as before: no tax, saved checkout version 2, `Order.taxMinorUnits` 0, no snapshot. |
| On | The location must have confirmed settings. If it has none, the quote shows `taxStatus: NOT_CONFIGURED` and checkout answers 409 `CHECKOUT_TAX_NOT_CONFIGURED` before anything is recorded. A confirmed zero-tax location is valid and charges $0 tax. |

A checkout that was already paid is always turned into an order with the tax
it was charged, whatever the switch says by then.

## How tax is calculated

The calculation lives in `apps/api/src/tax/domain/tax-calculation.ts`. It is
pure and uses only integers (BigInt for the products).

1. **Tax class per line.** Each line takes its product's own class if one is
   set, otherwise its category's class, otherwise the business default
   (Prepared Food).
2. **Store-funded discounts are allocated to lines.** The regular promotion
   is applied first, then the Mocha Bean reward, the same order checkout uses.
   - A freed item (`FREE_ITEM`) is allocated in full to its own line.
   - A targeted promotion is spread pro rata over the lines of its eligible
     products.
   - An order-wide promotion and a fixed Mocha Bean reward are spread over
     every line.
   - Pro-rata spreading uses whole cents: largest remainder first, ties go to
     the earlier line.
3. **Taxable amount per line** = line total − its allocated discounts.
4. **Each tax component is calculated once for the order.** The rate in ppm is
   applied to the sum of the taxable amounts of the lines in the component's
   classes, then **rounded half up once**. That tax is then allocated back to
   those lines with the same largest-remainder rule. A class that no
   component covers is not taxed.
5. **Gift cards are payment, never a discount.** A gift card is sized against
   the total *including* tax, and the external charge is total − gift card.

Every result is checked so that the lines add up to every component, the
components add up to the total, and the taxable amount equals subtotal −
discounts.

**Provider seam.** `SalesTaxProvider` (`sales-tax-provider.ts`) has one
implementation, the built-in calculator. It can be bound to
`SALES_TAX_PROVIDER` later; the source is recorded on the version and on the
order snapshot.

## Quote, review and charge

- **The quote shows the tax.** `CheckoutQuoteResponse` returns `taxStatus` and
  `tax`: each component, the total, the tax version and a `taxQuoteToken`.
  `total` includes tax.
- **The order request names what the customer reviewed.** It sends back the
  `taxQuoteToken`. The token is a digest of everything that decides the tax:
  the tax version and its components, **each line's tax class** (a category
  class or a product override can change without a new version), and the
  resulting tax per component and per line. Checkout recalculates it; if it is
  missing or different, the API answers 409 `CHECKOUT_TAX_CHANGED` before any
  payment attempt, saved checkout or hold exists. Nothing is charged, and the
  page reloads the quote so the customer reviews the new total. The token is
  not a secret and authorizes nothing; it only proves the customer saw this
  tax.
- **The checkout is frozen before the charge.** It is saved as version 3,
  holding the tax version, classes, components, each line's class and the
  full result. The payment amount includes the tax.
- **The order is created from the frozen checkout.** Before the order is
  written, the frozen tax is recalculated from its own frozen inputs (not
  today's rates) and must match exactly, ignoring key order. The frozen
  arithmetic must also agree:
  `subtotal − discounts + tax − gift card = charge = payment amount`.
  If either check fails, the payment is kept for review, exactly as other
  frozen-checkout mismatches are.

## The order record (migration `20261203090000_order_sales_tax`)

- **`Order.taxMinorUnits`** (≥ 0, default 0). Existing orders keep 0, so
  nothing is retroactive. A trigger stops it ever changing.
- **`OrderTaxSnapshot`**, one per taxed order:
  - Written once and never updated or deleted (trigger).
  - It holds the tax version and number, source, `pricesIncludeTax` (false),
    currency, subtotal, discounts, taxable amount, tax, total, gift card,
    amount charged, and `detail`: the full calculation with names as they
    were at checkout and the per-line allocations.
  - CHECKs tie the totals together.
  - On insert, a trigger requires the amounts, currency and location to
    match the order, and the version to be a confirmed (or since superseded)
    version of the order's own location.
  - A deferred trigger refuses to commit a taxed order without its snapshot.
- **`CheckoutSnapshot.version`** may now be 3.
- **Rollback:** `rollbacks/20261203090000_order_sales_tax.down.sql`. It
  refuses while any taxed order, snapshot or version-3 saved checkout exists.

## Display

Tax is shown on the cart ("added at checkout"), checkout, the order
confirmation and status page, the customer's order details and the staff
order details:

- one line per tax with its exact rate, or "Sales tax $0.00" for a zero-tax
  location;
- nothing for an order from before sales tax.

## Cancellation and payments

- Order closure checks the payment against
  `subtotal − discounts + tax − gift card`.
- A cancellation owes back the whole card charge (tax included) and restores
  the whole gift-card tender, so tax is never lost or counted twice.
- Card refunds are still capped at the payment amount.
- Item-specific refunds that keep the original tax per item, and the sales tax
  report: see [sales-tax-refunds-reporting.md](sales-tax-refunds-reporting.md) (PR 3).

## Zero-tax confirmation

Confirming settings with no taxes requires `acknowledgeNoTax: true`
(otherwise 409 `TAX_ZERO_ACKNOWLEDGEMENT_REQUIRED`). The Admin screen shows a
dedicated checkbox for it, and the audit event records
`noTaxAcknowledged: true`.

## Isolation

- Rules, classes and products are always read inside the order's own
  business and location.
- The snapshot's links are composite `(tenantId, id)` foreign keys, and it is
  registered in every tenancy inventory.

## Unresolved tax and legal decisions (not decided in code)

- **Mocha Bean rewards** are treated as **store-funded** discounts that reduce
  the taxable price, the same as store promotions. Some states treat
  loyalty-point redemptions differently. A tax adviser should confirm this
  for each state before launch.
- **Promotions and coupons** are all store-funded today. Nothing in CENTERIVO
  creates a third-party-funded discount (for example a manufacturer coupon).
  The calculation refuses any funding other than `STORE`, so a future one
  needs its own explicit rule.
- **Rounding** is half up once per tax component per order. Some
  jurisdictions require per-item or bracket rounding. Confirm before launch
  in each state.
- **Freed items** (free-item promotions or rewards) are untaxed because their
  whole price is discounted. Some states tax the full value of a "free" item
  when it comes with a purchase.
- **Gift-card purchases** remain untaxed (they are stored value, not a sale
  of goods).
