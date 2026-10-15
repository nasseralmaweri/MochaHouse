# Order closure foundation (R1 / S5a)

S5a is the **database and compatibility foundation** for rejecting and cancelling
orders. It is behaviour-neutral: **nothing writes `REJECTED` or `CANCELLED` yet, no
API can reach them, no benefit is reversed and no money moves.** The closure writer
is S5b; refund processing is S5c.

## What exists after S5a

| Piece | What it is |
|---|---|
| `OrderStatus` | `REJECTED` (turned away while `RECEIVED`) and `CANCELLED` (called off from `ACCEPTED` / `PREPARING` / `READY`). Both are **terminal**, like `COMPLETED`. |
| `OrderClosure` | One **append-only** row per closed order: kind, the status it was closed from, a machine reason code, an optional note (≤ 500), the acting staff member, and summary snapshots (`refundDueMinorUnits`, `giftCardRestoredMinorUnits`, `loyaltyShortfallBeans`). It is a summary, never the source of truth for money. |
| `OrderRefundObligation` | Money owed back on the **external (card)** payment. Starts `DUE`; `PROCESSING` / `REFUNDED` / `FAILED` exist for S5c. |
| Ledger types | `GiftCardTransactionType.REDEMPTION_REVERSAL`; `MochaBeanEntryType.REDEEM_REVERSAL`, `EARN_REVERSAL`, `BONUS_EARN_REVERSAL`. |

## Financial rules the database enforces

* **A refund is never settled silently.** `REFUNDED` requires a settlement method and
  time, plus the staff member who recorded it (`MANUAL_EXTERNAL`) or the processor's
  refund id (`PROCESSOR`). Any other status must carry none of that. `REFUNDED` is
  terminal, the obligation's identity (order, closure, payment attempt, amount, currency,
  tenant) never changes, and it cannot be deleted. A processor refund id settles at most
  one obligation per business.
* **The closure and the obligation cannot disagree.** Checked at commit: the order's
  status equals the closure kind, and an obligation exists exactly when
  `refundDueMinorUnits > 0`, for exactly that amount.
* **Benefits are reversed at most once.** One gift-card restoration per order (partial
  unique index), one loyalty reversal per type per order (`(type, orderId)` unique).
  Signs are fixed per type (restored/returned positive, recovered negative) and every
  reversal names an order and the acting staff member.
* **Loyalty shortfall is recorded, not hidden.** A recovery is clamped at the account's
  balance; the part that could not be recovered goes in
  `OrderClosure.loyaltyShortfallBeans`, so earned − recovered = shortfall always
  reconciles.
* **A closed order never changes status again** (trigger on `Order`).
* **Tenant isolation.** Every row is tenant-scoped, every relationship is a composite
  `(tenantId, id)` foreign key, and `tenantId` is immutable.
* The gift-card tender is never "refunded" as money: it is restored to the card.

## What changed for existing code (all neutral today)

* **Classification** (`@mocha-house/domain`): both statuses are terminal; "advance" never
  steps into or out of them; `isCommercialSaleOrderStatus` / `NON_SALE_ORDER_STATUSES` are
  the one definition of what counts as a sale.
* **Reports:** order counts, digital sales and average order value exclude `REJECTED` and
  `CANCELLED`; `statusBreakdown` includes them so they stay visible. Location performance
  and customer growth exclude them the same way. The CSV adds the two breakdown rows and,
  only when closed orders exist, a one-line note.
* **Customer tracking:** the polling client accepts the new statuses (an unknown status is
  a failed poll, which is why this ships first), stops polling, shows plain wording ("The
  shop couldn't take your order", "Your order was cancelled") and never says a closed order
  is "complete".
* **Staff:** the queue lists active orders only; "advance" has no next step from a closed
  order (a 409 that says so). No cancel or reject action exists, and **`orders.cancel` is
  not granted** to anyone.
* **Admin ledgers** label the new reversal types.

## Deployment order

1. Deploy the application (web, API, contracts) — it understands the new values.
2. Apply the migrations (`…_order_closure_enum_values`, `…_foundation`, `…_validate_checks`).
3. Only in S5b: ship the writer behind a feature flag, after (1) and (2) everywhere.

An older web client that meets a closed order treats it as a failed poll, so no writer may
ship until (1) is live everywhere. Nothing writes the values in S5a, so (1) and (2) may
happen in either order today.

## Rollback

`prisma/rollbacks/20261019090100_order_closure_foundation.down.sql` (as a *new forward
migration*) drops the tables, triggers, functions, ledger CHECKs and the partial index. It
**refuses to run** if any order is closed or any closure, obligation or reversal exists.
**Enum values cannot be removed** in PostgreSQL: they stay, unused. Rolling back the
*code* is always safe in S5a, because nothing writes them.

## For S5b (not decided here)

The writer, the `orders.cancel` permission and its data grant, the reason catalogue, the
lock order (Order → Promotion → PromotionCustomerUsage → GiftCard → LoyaltyAccount), the
customer-visible reason, and the exact promotion-counter treatment.
