# Order rejection and cancellation (R1 / S5b)

S5b is the **closure writer** on top of the S5a foundation
(`order-closure-foundation.md`). Staff can now reject a new order or cancel an
accepted one, and the system reverses what the order consumed. It ships **off**.
**No money moves on a card**: the card-paid amount becomes a refund *obligation*
that a person settles later (S5c).

## What staff can do

| Action | From | To | Endpoint |
|---|---|---|---|
| Reject | `RECEIVED` | `REJECTED` | `POST /api/v1/admin/orders/:orderId/reject` `{ locationId, reasonCode, note? }` |
| Cancel | `ACCEPTED` / `PREPARING` / `READY` | `CANCELLED` | `POST /api/v1/admin/orders/:orderId/cancel` `{ locationId, expectedStatus, reasonCode, note? }` |

`COMPLETED`, `REJECTED` and `CANCELLED` are terminal. Every other move is a 409.

* **Permission.** The `orders.cancel` permission is held at CORPORATE scope or per
  LOCATION, and checked for the order's own location. It is separate from
  `orders.manage_status`, so being able to advance orders does not let anyone close them.
* **Reason codes.** A reason code is required:
  * Rejection: `ITEM_UNAVAILABLE`, `STORE_TOO_BUSY`, `STORE_CLOSING`, `DUPLICATE_ORDER`,
    `SUSPECTED_FRAUD`, `OTHER`.
  * Cancellation: `CUSTOMER_REQUEST`, `ITEM_UNAVAILABLE`, `EQUIPMENT_FAILURE`,
    `STORE_CLOSING`, `DUPLICATE_ORDER`, `SUSPECTED_FRAUD`, `OTHER`.
* **Note.** An optional internal note of 1–500 characters is accepted. Control characters
  are refused, and `OTHER` requires a note. The note is stored on `OrderClosure` only
  and shown on the staff order detail. It never appears in:
  * any customer response;
  * the status history;
  * the audit event, which records only whether a note exists;
  * any log or error message.
* **Concurrency.** Cancel carries `expectedStatus`. If the order has moved since the
  staff member looked at it, the request is a 409 and nothing changes.
* **Idempotency.** Repeating a close returns the existing closure with `closed: false`
  and writes nothing. Closing an order the *other* way (cancelling a rejected order)
  is a 409.

## What one closure does (one transaction, or nothing)

1. It locks the `Order` row, scoped to its business and location, and checks the move.
2. It changes the status conditionally (`WHERE status = <the status just read>`).
3. **Promotion / coupon:** it releases one total use and, if the redemption counted
   against the customer, one per-customer use. No counter goes below zero.
4. **Gift card:** it restores exactly the tender, to the card the order's own
   `REDEMPTION` entry names, as a `REDEMPTION_REVERSAL` entry plus a balance increment.
   A deactivated card still gets its value back. If the restoration would push the card
   above its $2,000 maximum, the close is **refused** and HQ must correct the card first.
5. **Mocha Beans:**
   * Redeemed Beans come back first (`REDEEM_REVERSAL`).
   * Earned and bonus Beans are then recovered (`EARN_REVERSAL`, `BONUS_EARN_REVERSAL`),
     each clamped at the balance so it never goes negative.
   * Whatever the customer already spent is the **shortfall**, recorded on
     `OrderClosure.loyaltyShortfallBeans`. Earned − recovered = shortfall.
6. **Card refund:** an `OrderRefundObligation` is created in `DUE` for exactly
   `PaymentAttempt.amount` (the card-paid part), and only when that charge
   **genuinely succeeded**, meaning all of these hold:
   * `status = SUCCEEDED`;
   * `paymentState` is NULL or `SUCCEEDED`;
   * the attempt is not flagged for reconciliation;
   * a real provider reference exists.

   A gift card or reward covering everything means nothing is owed. An order whose
   payment is not confirmed, or whose figures disagree with its payment, is **not closed
   automatically** (409, "contact support").
7. It writes `OrderClosure`, an `OrderStatusHistory` row and an `InternalAuditEvent`
   (`order.rejected` / `order.cancelled`, with codes and amounts only).

**Lock order** (closure and checkout use the same one):
Order → Promotion → PromotionCustomerUsage → GiftCard → CustomerLoyaltyAccount.

**Advance vs. close.** Since S5b, an `advance` whose conditional update finds the
order changed (for example, cancelled a moment earlier) returns 409. It is no longer
reported as an idempotent success.

**Notifications.** A pending "your order is ready" email for an order that has since
been rejected or cancelled is **not sent**. The event completes with code
`ORDER_CLOSED` and is not a failure: it does not count as a dead letter and does not
alert. The worker checks the status when it resolves the email and again, under a row
lock, in the same transaction that records the send intent. Only a cancellation that
commits *after* the send has started can still be followed by the email.

## Refunds (not done by S5b)

S5b never marks a refund settled. The database enforces the following when a person
later records one (S5c):

* **`MANUAL_EXTERNAL`:**
  * the staff member who recorded it;
  * a `settlementReference` (the terminal or processor refund reference: evidence);
  * a **different** person from the one who closed the order.
* **`PROCESSOR`:** the processor's refund id.
* **`REFUNDED`** is terminal, and an obligation can never be deleted.

To find what is owed, query obligations where `status = 'DUE'`. They are tenant-scoped
and joined to `OrderClosure` for the reason and the actor.

## Enabling it (per environment, in this order)

1. Deploy the application (API, web, worker). Web clients have understood the new
   statuses since S5a.
2. Apply `20261020090000_order_closure_writer_guards`, which needs the S5a migrations.
   It refuses to run if a closed order without a closure, or a settled obligation,
   already exists.
3. **Confirm the trigger-bypass gate (security follow-up T-2).** The guards are
   triggers and CHECKs:
   * A **superuser** can switch triggers off with `SET session_replication_role = replica`.
   * A **table owner** can `ALTER TABLE … DISABLE TRIGGER`.

   Locally and in CI the application role is both. In production the API must connect
   as a `NOSUPERUSER` role that owns none of these tables. The application never
   disables triggers itself; this is about what a compromised or misused connection
   could do. Check with:

   ```sql
   SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
   SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
     FROM pg_class c
    WHERE c.relname IN ('Order', 'OrderClosure', 'OrderRefundObligation',
                        'GiftCardTransaction', 'MochaBeanLedgerEntry');
   ```

   Both should show the runtime role as **not** superuser and **not** the owner.
4. Grant `orders.cancel`:
   * A **new** database's seed grants it to Platform Administrator (which holds every
     key) and to Store Manager.
   * An **existing** database's roles do not change on reseed. Grant it through
     Administration → Access levels, deliberately, to the people who should hold it.
5. Set `ORDER_CLOSURE_ENABLED=1` on the API. Any other value, including `true`, keeps
   it **off**; the endpoints then answer 404 and write nothing.

To switch off, unset the flag. Closed orders, closures and obligations stay valid.

## Rollback

* **Code.** Unset the flag first. Rolling back the application is safe while no order
  has been closed.
* **Migration.** `prisma/rollbacks/20261020090000_order_closure_writer_guards.down.sql`
  is applied as a new forward migration. It **refuses** once any order is
  `REJECTED` / `CANCELLED`, because the INSERT guard must then stay. If S5a must also
  be rolled back, roll back S5b first.

## Busy orders

A closure waits at most 5 s for any one row lock (`lock_timeout`), and the
transaction as a whole may run for up to 15 s. A busy order is answered with
**503 "try again"**, and nothing has changed. This happens when a checkout is still
holding the order's promotion, gift-card or Mocha Bean rows. Retrying is safe: a
closure is exactly-once, and a repeat after success is an idempotent replay.

## Database privileges the runtime roles need

* **API:** DML on the closure tables. It needs no UPDATE or DELETE on `OrderClosure`,
  since the table is append-only by trigger anyway.
* **Worker:** `SELECT … FOR SHARE` on `"Order"` when it starts a READY send.
  PostgreSQL requires UPDATE privilege on at least one column of `"Order"` for that,
  for example `GRANT UPDATE ("updatedAt") ON "Order" TO <worker role>`. Check this
  before giving the worker a least-privilege role (T-2).

## Known limits (S5c and later)

* **Coupons are always released.** Cancelling an order releases its coupon or
  promotion use, even when the food was already made (`READY`). If the business wants
  to keep the use for some reasons (for example a no-show), that is a policy decision
  for a later slice.
* **Simulated payments produce obligations.** An order paid through the simulated
  `fake` provider (development and staging only; production refuses it) still produces
  a `DUE` obligation. S5c must refuse to settle, or visibly label, an obligation whose
  payment was simulated.
* **No rate limit on closing.** Every closure is audited and `orders.cancel` is
  granted explicitly, but there is no per-person rate limit. Consider an alert on
  closure volume.

* No customer email is sent when an order is rejected or cancelled. The tracking page
  already shows plain wording, introduced in S5a.
* No settlement API exists yet. Obligations stay `DUE` until S5c.
* No staff UI exists in this slice. The API is the surface.
* Orders whose payment needs reconciliation, or whose gift card is at its maximum
  balance, need support or HQ action before they can be closed.
