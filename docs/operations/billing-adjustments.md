# Refunds and credits (SC3e-3)

This covers Stripe **test mode only**. `BILLING_ENFORCEMENT_ENABLED` and
`BILLING_NOTIFICATIONS_ENABLED` stay off, and no refund notifications are sent.

It applies only to **CENTERIVO subscription invoices**, which are what a
business pays CENTERIVO. Refunds to a restaurant's own customers (orders,
gift cards, card payments) are a separate system and are not built here.
They remain a **launch blocker** for live billing enforcement.

## What an adjustment is

An adjustment is always a **Stripe credit note** on one of the business's
**paid** invoices. There are two kinds:

| Kind | Effect |
|---|---|
| Refund | The money goes back to the original payment method (the credit note's `refund_amount`). |
| Credit | The business's Stripe balance absorbs the amount, so it reduces future invoices. No money is returned (`credit_amount`). |

The scope is either the **whole invoice** or **part of one invoice line**.
For a partial adjustment you enter a pre-tax amount, and Stripe adds the tax.
CENTERIVO never calculates tax or totals itself: every amount comes from
Stripe's own credit-note preview.

A request is refused unless all of the following are true:

- Stripe's invoice matches our records: the same invoice, customer,
  subscription and currency, in test mode.
- The invoice is paid.
- The amount is no more than what remains. Remaining means paid, minus
  earlier credit notes, minus refunds made on the payment without a credit
  note.
- For a refund, the payment can still return the amount.
- No other CENTERIVO adjustment on the invoice is open. The database allows
  one at a time.

Goodwill credits that are not tied to an invoice are **not** supported.

## No access effects (D5)

An adjustment changes nothing else:

- The subscription, its plan, status and modules stay as they are.
- No suspension (SECURITY or administrative) is lifted.
- A full refund does **not** stop future charges. The subscription keeps
  renewing until it is cancelled separately.

The request and approval screens both say this, and the person confirming
must tick a box that says it too.

## Approval policy (D2)

| Request | Approvers needed |
|---|---|
| Under $250 USD | 1 |
| $250 USD or more | 2, different people |
| Any currency other than USD | 2 (until a conversion policy is approved) |
| A full refund of an annual period (a billed line of 300 days or more) | 2, whatever the amount |

Amounts are counted per invoice: the threshold uses this request plus everything already refunded or credited on the same invoice. Splitting a $480 refund into two $240 requests still needs two approvers for the second. The database also refuses carrying out a request without its approvals, or after it expired.

Every approver must be independent:

- The requester never approves its own request. This is refused by the API
  and by a database trigger.
- One operator fills one position: one decision per operator per request.
- An approval counts only while that operator is **ACTIVE** and still holds
  `billing.adjustments.approve`. It is counted again when the request is
  carried out and when the sweep re-sends it.
- A request expires **72 hours** after it is made.

A request needs `billing.adjustments.request`. A decision needs
`billing.adjustments.approve`. Both need a sign-in within the last 15
minutes and a written note (10–500 characters).

The same person may hold both permissions, but never acts twice on one
request.

The amount, tax, currency, invoice, kind and requester are recorded at
request time and **cannot change**; the database refuses it. If Stripe's
preview differs when the request is carried out, nothing is issued and the
adjustment ends `FAILED` with `PREVIEW_CHANGED`. Request it again.

## How it is carried out (D3)

1. The final approval **reserves** the adjustment (`EXECUTING`) in the same
   database transaction. A concurrent approval then finds it no longer
   pending.
2. Immediately before Stripe is called, CENTERIVO checks the invoice, the
   remaining amount and Stripe's preview again.
3. Stripe receives one credit note, sent with:
   - the idempotency key `centerivo-adjustment-<id>`;
   - the metadata `centerivo_adjustment_id`.
4. The adjustment counts as done only when **Stripe** confirms it:

| Stripe holds | Status |
|---|---|
| The credit note for exactly the approved total and tax (credit) | `SUCCEEDED` |
| That, plus a refund that succeeded (refund) | `SUCCEEDED` |
| A refund that is still pending | `SUBMITTED` (the business sees it "in progress") |
| A failed refund, or anything that doesn't match | `REVIEW`, with a review case |

If the call to Stripe times out or fails, the adjustment stays `EXECUTING`.
It is never treated as done, and never as failed.

**The sweep** runs with plan-change maintenance. For each `EXECUTING`
adjustment it first looks in Stripe for a credit note carrying the
adjustment's id:

- If it finds one, it confirms it. This covers a late success.
- If it finds none and the adjustment was reserved **less than one hour
  ago**, with its approvals still counting, it re-sends with the **same**
  key. Stripe keeps idempotency for 24 hours.
- Otherwise it never re-sends. The adjustment goes to `REVIEW`, and a
  `BILLING_ADJUSTMENT_UNCERTAIN` case opens.

### Resolving a reviewed adjustment

Open it under **Billing → Refunds and credits**. With
`billing.adjustments.approve`, and only if you are not the requester, choose **Check and resolve** and write a note.
CENTERIVO reads Stripe again:

- If our credit note exists after all, the adjustment is confirmed instead.
- If it doesn't, the adjustment is closed as `FAILED` / `NOT_ISSUED`.

Nothing is sent to Stripe either way.

Before resolving, look the invoice up in the Stripe dashboard. If Stripe issues the credit note later anyway, reconciliation opens a `BILLING_ADJUSTMENT_MISMATCH` case. It never adopts or reverses the credit note.

## Adjustments made directly in Stripe (D4)

Credit notes, and refunds without a credit note, that were made in the Stripe
dashboard are found in three ways:

- verified `invoice.*` events;
- `charge.refunded` and `refund.*` events;
- the reconciliation run, which checks paid invoices from the last 400 days.

Each is recorded **once** (unique Stripe ids) as an **external** adjustment
(`RECORDED`), and an `EXTERNAL_BILLING_ADJUSTMENT` case opens. There is one
open case per business; every adjustment is listed on its page.

External adjustments are:

- never repeated, reversed or treated as approved here;
- shown in the invoice history;
- counted when working out what remains on the invoice.

A refund event for any payment that isn't a CENTERIVO invoice is ignored.
This includes a restaurant order's payment.

## What the business sees (D6)

Each invoice in **Billing** shows its refunds and credits:

- the kind and amount;
- whether it is completed or in progress (in progress covers `EXECUTING`,
  `SUBMITTED` and `REVIEW`).

Requests that are still awaiting approval are not shown, and neither is who
requested or approved anything. Businesses cannot request, approve or carry
out adjustments.

## Financial permissions and the bootstrap (D7)

`billing.adjustments.request`, `billing.adjustments.approve` and
`platform.permissions.manage` are **financial permissions**. The plain CLI
`grant` refuses them, and the database refuses them too.

### Normal grants: the console

An operator holding `platform.permissions.manage` grants and revokes
permissions under **Billing → Operator permissions** (`/platform/operators`).
Each change needs a recent sign-in and a reason.

Nobody can change their own permissions. The API refuses it, and the
database rejects a grant whose grantor is its holder. Every change is
audited:

- `platform.operator.permission_granted` / `_revoked`;
- the grant row also keeps who granted or revoked it.

### The initial bootstrap (one time)

The bootstrap works only while `platform.permissions.manage` has **never** been granted, even if it was later revoked or its holder disabled. Once it has been granted, the bootstrap is closed for good, and all further grants go through the console. Revoking or disabling every manager does not reopen it. Recovery from losing every manager needs a new, separately approved procedure.

A typed name, or the approval reference itself, is **not proof** of
approval. The reference must point to an approval that is recorded
independently, for example a change ticket approved by a second accountable
person. That approval must exist before the command is run.

1. Record the approval outside CENTERIVO. It must name the operator emails
   and the permissions.
2. A second person checks the target database and the operator emails.
3. Run the command, granting the permission **holders first** and
   `platform.permissions.manage` **last**. Granting manage closes the
   bootstrap.

   ```bash
   DATABASE_URL=... pnpm --filter @mocha-house/database platform:operator bootstrap --confirm-database <db> --email <operator email> --permission billing.adjustments.approve --reason "Initial billing approver" --approval-reference CHG-1234
   ```

4. Check the result with `platform:operator permissions`.
5. Check the audit events (`platform.operator.permission_bootstrapped`). The
   grant row records:
   - `grantedVia = CLI_BOOTSTRAP`;
   - the approval reference;
   - the OS account and host that ran it (`executedBy`).
6. Attach the output to the approval record.

With a single manager, that person cannot grant themselves anything, so a
second manager must be granted by the first.

## Stripe test-mode validation (still required)

These checks need real Stripe test mode before any live use:

1. A credit-note **preview** on a paid invoice, using line-based amounts plus
   `refund_amount` or `credit_amount`. Confirm Stripe accepts the allocation
   for each kind. If it refuses, nothing is issued: the request fails at
   preview, or the adjustment fails at creation with the amount check.
2. Tax: confirm the previewed total and tax for a taxed invoice match the
   issued credit note.
3. Events: confirm `charge.refunded` and `refund.updated` arrive on the SaaS
   webhook endpoint, and that a refund's status moves `pending` →
   `succeeded`.
4. A refund made from the Stripe dashboard is recorded as external exactly
   once.
5. Idempotency: replaying a create with the same key returns the same credit
   note.
