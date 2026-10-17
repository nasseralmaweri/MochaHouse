# Operator billing controls (SC3e-2)

This covers Stripe **test mode only**. Billing enforcement and notifications
stay disabled. Nothing described here refunds, credits or charges anyone.
Refunds and credits come in SC3e-3.

## Operator permissions

Every billing **write** in the Platform Console needs a granted permission.
Reading needs none. The API reads an operator's grants again on every
request, so a revocation takes effect at once.

| Permission | Allows |
|---|---|
| `billing.prices.manage` | Create and archive plan prices |
| `billing.policy.manage` | Change the billing policy |
| `billing.accounts.manage` | Start billing, set the billing contact, extend grace, preview a plan change |
| `billing.reconciliation.run` | Run reconciliation and the enforcement sweep |
| `billing.cases.manage` | Recheck and close review cases |
| `billing.schedules.release` | Release a leftover Stripe schedule on a case |
| `billing.complimentary.manage` | Grant, withdraw and revoke complimentary arrangements |

### Bootstrap: granting and revoking

Permissions are granted **only** by the human-run provisioning CLI. No API
route grants one, so an operator can never grant itself anything.

Rules:

- Every grant and revocation needs a reason.
- Only an ACTIVE operator can be granted a permission.
- Each change writes a platform audit event
  (`platform.operator.permission_granted` / `_revoked`).
- A revoked grant is kept as history.
- No operator gets any permission automatically, so grant the least needed.

```bash
DATABASE_URL=... pnpm --filter @mocha-house/database platform:operator grant --confirm-database <db> --email <operator email> --permission billing.cases.manage --reason "Reviews billing cases"
```

```bash
DATABASE_URL=... pnpm --filter @mocha-house/database platform:operator revoke --confirm-database <db> --email <operator email> --permission billing.cases.manage --reason "Left the billing team"
```

```bash
DATABASE_URL=... pnpm --filter @mocha-house/database platform:operator permissions --confirm-database <db>
```

`--confirm-database` must name the target database exactly. The connection
string is never printed.

Billing workers and verified Stripe webhooks do not use these permissions.
They are authorized on their own.

## Complimentary arrangements

An arrangement always names a **plan version**, and the business gets that
version's modules only. It is either indefinite or runs until a date (at
most three years).

### When it is refused

Nothing is changed when an arrangement is refused. That happens when:

- any of the customer's Stripe invoices is unpaid, on any subscription past
  or present (debt is never waived here);
- the subscription is past due or unpaid;
- a plan change, schedule, cancellation or payment page is open;
- an arrangement is already open.

### How it starts

- **A paying business.** Stripe is told to cancel the subscription *at the
  end of the period already paid*. CENTERIVO re-reads Stripe to verify this.
  The arrangement starts only once Stripe confirms the subscription
  **ended**. Nothing is refunded or credited.
- **An ended subscription, or one that never set up payment.** The
  arrangement starts at once.

### Withdrawing a scheduled arrangement

Withdrawing undoes the Stripe cancellation, verified by re-reading Stripe.
The business keeps paying as before.

If the cancellation is undone **outside** CENTERIVO, the arrangement is
withdrawn and a `COMPLIMENTARY_CANCELLATION_UNDONE` review case opens. It is
never re-issued automatically.

If Stripe never confirms the cancellation, the request is re-sent with the
same idempotency key for 30 minutes. After that the arrangement is
withdrawn.

### Expiry and revocation

When an arrangement expires or is revoked, the business returns to billing
exactly as before: its customer, plan, price and one-trial record.

- **An ended subscription** must be restarted through a new Checkout.
- **A business that never set up payment** goes back to payment setup.

In both cases:

- nothing is charged automatically;
- no Stripe subscription is reactivated or created;
- no new trial is ever offered after an arrangement.

### Suspensions

Starting an arrangement lifts a **billing** suspension (when enforcement is
on). It never lifts a security or requested suspension.

### Where to see them

Arrangements appear on the business's console page and under
**Billing → Complimentary arrangements**, with attention counts on the
billing overview.

## Review cases

Each case has its own page, showing its action history, which is
append-only.

- **Recheck** (`billing.cases.manage`). Reads Stripe again for the case's
  subscription and re-runs our checks. It never writes to Stripe and never
  adopts a Stripe price.
- **Release a leftover schedule** (`billing.schedules.release`).
  - It needs a sign-in within 15 minutes and a reason.
  - It applies only to the schedule attached to *that case's* subscription
    right now.
  - It is refused for a schedule that an open scheduled plan change holds;
    the business cancels that one from its billing page.
  - The schedule is released, never cancelled: cancelling a schedule cancels
    the subscription.
  - One idempotency key is used per case and schedule.
- **Close** (`billing.cases.manage`) records an outcome code and a note.
  `NEEDS_FINANCIAL_ADJUSTMENT` marks a case for the SC3e-3 refund and credit
  work.

## Invoice history across restarts

The invoices of an earlier Stripe subscription stay in the business's
history and keep updating. This applies only when the earlier subscription
is proven to be the business's by **our own completed restart Checkout**,
never by a value from a browser or an event.

Refunds made directly in Stripe, outside credit notes, are not detected
yet. That comes in SC3e-3.
