# Sales tax refunds and reporting (V1 Sales Tax PR 3)

Refunds and cancellations of taxed orders return sales tax that is attributed
from the order's **original** tax snapshot (PR 2). Tax is never recalculated
at today's rates. A sales tax report shows the results. Everything here only
reads or records: no refund is ever issued automatically.

## Item refunds

Staff with `orders.refund` at the order's location (the owner, or a Refund
Manager there) choose items and quantities on a **completed** taxed order.

1. **Preview.** `POST /api/v1/admin/orders/:orderId/refunds/items/preview`
   records nothing. For each chosen line it returns the line's net price
   after discounts plus its tax per component, all from the snapshot.
2. **Request.** The existing `POST .../refunds` with `items` added. The
   amount must equal what the items return, as previewed; otherwise the
   request is refused (409) and staff refresh and check again.
3. **Under the payment's lock,** the items are allocated again, counting
   every earlier item refund whose card refund still counts. The card refund
   (`PaymentRefund`) and its tax record (`OrderTaxRefund`, its lines and its
   per-line components) are written in the **same transaction**.

Partial quantities are refunded cumulatively, per line and per component:
after *k* of *q* units, exactly ⌊amount × *k* / *q*⌋ has been returned, and the
last unit takes exactly what is left. Several partial refunds therefore always
add up to the line exactly, never more.

**Everything else is the existing card-refund flow, unchanged:**
- Stripe test mode only, the original card and the order's own connected
  account.
- Capacity under the payment lock, request ids and fingerprints (the
  fingerprint changes only when `items` is present), replay, recheck,
  reconciliation and late-failure review.

### Which refunds count
- **Items stay taken** while their card refund is `REQUESTED`, `PENDING`,
  `UNKNOWN` or `SUCCEEDED`.
- **Items can be refunded again** when it is `FAILED`, `CANCELED`,
  `NOT_CREATED` or `FAILED_AFTER_SUCCESS`, because no money reached the
  customer.
- **Tax counts as refunded only when the card refund is `SUCCEEDED`.**

### Restrictions (existing, kept)
- **Card only.** A refund goes back to the card only, within what the card
  paid. Gift-card balances are never touched by a refund; they are restored
  only by a full cancellation, as before.
- **Mixed tender.** On an order paid partly by gift card, items worth more
  than what remains refundable on the card are refused.
- **Historical orders.** Orders from before sales tax have no snapshot. They
  cannot be refunded item by item, and amount refunds work exactly as before.
- **Unmatched lines.** A taxed order whose lines have no position
  (`OrderLine.lineIndex`, set by checkout from this PR on) cannot be refunded
  item by item.

## Amount refunds

Amount refunds are unchanged. On a taxed order, their tax is **not attributed**:
a proportional share is never assumed. Each one is shown as "Tax not
attributed" in the refund history and listed on the report, and the report
then withholds net tax.

## Cancellations

Rejecting or cancelling a taxed order writes a `CLOSURE` tax record with every
line in full, in the closure's own transaction. It counts as refunded:
- **at once** when nothing was card-paid (the gift card is restored at once);
- **when the card money is refunded**, otherwise: the obligation is fully
  covered by succeeded refunds, or settled, with nothing returned since.

Card refunds of a cancelled order's obligation carry the attribution
`CANCELLATION`; they are never unattributed.

## Records (migration `20261204090000_order_tax_refunds`)

**New tables and columns**
- **`OrderLine.lineIndex`:** the line's position, as in the snapshot. It is
  nullable (older orders have none), unique per order (partial index), and
  never changed once set.
- **`OrderTaxRefund`** (`ITEM` or `CLOSURE`), with **`OrderTaxRefundLine`**
  and **`OrderTaxRefundComponent`** (one per line and component). Each holds
  the location and the original order, snapshot and card refund or closure.

**Guarantees enforced by the database**
- **Immutable.** A record is never updated or deleted.
- **On insert,** a record must name its own order's snapshot, location and
  currency. An `ITEM` record must also:
  - name its own order's CENTERIVO card refund;
  - be for exactly merchandise + tax;
  - be for a completed order.
- **At commit,** the lines and components must add up. Every line must:
  - be a line of the order;
  - stay within its quantity and within its snapshot amounts.

  No record may exceed the snapshot.
- **Tenancy.** Composite tenant foreign keys, and every new table is
  registered in the tenancy inventories.

**Rollback:** `rollbacks/20261204090000_order_tax_refunds.down.sql`. It
refuses while any tax refund is recorded.

## The report

`GET /api/v1/admin/reports/sales-tax?startDate=&endDate=&locationId=`
(`reports.view`, corporate), with `.../export` for the CSV, and **Admin →
Reports → Sales Tax**.

**Included orders and dates**
- **Orders taxed at checkout only.** Historical untaxed orders are not
  included.
- **Collected:** sales and tax collected are counted by order date.
- **Refunded:** confirmed refunds only, counted by the tax record's date.
- **Time zone:** dates are in the business reporting time zone.

**Figures, totalled per location and per tax component**
- taxable sales, exempt sales and net sales;
- tax collected, tax refunded and net tax;
- pending and failed refunds (shown apart, never counted).

**Unresolved refunds.** Amount-only refunds of taxed orders, and
cancellations whose lines could not be matched, are listed as unresolved.
While any exist in the period, every net figure is withheld: null in the API,
"Not final" in the page and the CSV.

**CSV.** The export comes from the same result as the page, with a warning
row whenever net tax is withheld.

## Unresolved decisions (not decided in code)

1. **Refunding to a gift card.** Item refunds go to the card only (existing
   rule). On a split-tender order, items worth more than the card's remaining
   amount cannot be refunded item by item. Whether a gift card should be
   credited in that case is a product decision.
2. **Attributing amount refunds after the fact.** An amount refund's tax stays
   unattributed. There is no flow yet for staff to attribute it later to
   items. Deciding that flow (and who may use it) is a product decision; until
   then the report withholds net tax.
3. **Report date basis.** Refunds are reported by the date the refund was
   recorded, not the date Stripe confirmed it. Confirm with the tax adviser
   which period a refund belongs to.
4. **Partial-unit rounding.** Partial quantities take ⌊amount × k / q⌋
   cumulatively, so the last unit absorbs the remainder. Confirm this is
   acceptable for each state.
