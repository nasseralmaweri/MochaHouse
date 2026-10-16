# Billing recovery — operator runbook (SC3c-2)

CENTERIVO's own SaaS subscription billing (Stripe **test mode**). Never
restaurant customer payments.

This runbook covers the one recovery outcome that needs a person: a
**restart** (a business restarting an ended subscription) for which Stripe
created — and may have charged — a new subscription that CENTERIVO could not
link.

## What the system does on its own

- The business is **not** linked to the new Stripe subscription and is
  **not** given access. Its state is unchanged (still `TRIAL_EXPIRED` or
  `CANCELED`; a billing suspension stays).
- **Nothing is changed at Stripe**: no cancellation, no refund, no
  modification. (No automatic policy is approved for that.)
- A durable review case is opened: kind **`UNLINKED_REPLACEMENT`**
  (Platform Console → Billing → cases, "A restart was created at the payment
  provider but not linked"). It is opened when the restart is rejected, or
  when a retryable failure (not paid yet, old subscription not ended yet)
  has exhausted its retries (12 attempts or 72 hours).
- While such a case is **open**, the business cannot start another restart
  (`BILLING_RECOVERY_UNDER_REVIEW`: "Your payment is being reviewed by our
  team. You won't be charged again…"). Once the case is **resolved**, that
  attempt is closed and the owner may restart again.

## The case's details (safe references only)

```
Reason <code>. Provider subscription sub_… (<status>), customer cus_….
First invoice in_…: <status>, <amount> paid (minor units).
Our Checkout <id>; replaces sub_… . Not linked; no access granted;
nothing changed at the provider.
```

No payment page URL is ever stored. Use the ids in the Stripe Dashboard
(test mode).

| Reason | Meaning |
| --- | --- |
| `UNEXPECTED_TRIAL` | Stripe created the subscription with a trial (restarts never include one). |
| `NOT_REPLACEABLE` | The business was no longer an ended subscription when the restart completed. |
| `LINKED_ELSEWHERE` | The business was already linked to a different subscription. |
| `PREVIOUS_UNVERIFIABLE` | The subscription being replaced could not be read or belongs to another customer. |
| `PREVIOUS_NOT_ENDED` | The old subscription never ended within the retry window. |
| `REPLACEMENT_NOT_PAID` | The new subscription's first invoice was never verifiably paid within the retry window. |

## Resolving it

1. **Find it in Stripe (test mode)** by the provider subscription and
   customer ids. Confirm the customer is the business's own (the Platform
   Console tenant billing view shows the stored customer id).
2. **Decide with the account owner / finance — manually, under an approved
   policy:**
   - **The owner should keep paying for CENTERIVO** and the cause is fixed
     (e.g. the old subscription has now ended): cancel the unlinked Stripe
     subscription **and** issue the refund of its first invoice per the
     approved refund policy, then resolve the case — the owner restarts
     cleanly (one new charge). *Do not* try to link it by hand; there is no
     manual link tool, by design.
   - **The charge was a mistake** (e.g. a Stripe configuration produced a
     trial): cancel the unlinked subscription in Stripe and refund per
     policy; fix the configuration first (Checkout restarts never include a
     trial).
   - **Unpaid** (`REPLACEMENT_NOT_PAID`, first invoice `open`): cancel the
     unlinked subscription so it does not try to collect later; no refund
     is needed if nothing was paid.
3. **Resolve the case** in the Platform Console (Billing → cases → Mark
   reviewed) — **only after** step 2 is done at Stripe. Resolving is the
   signal that the owner may restart, i.e. that a **new charge may happen**;
   resolving before the unlinked subscription is cancelled risks the owner
   paying twice. Resolution is audited (`platform.billing.case_resolved`)
   and final.
4. **Tell the owner** what happened and that they may restart.

Never grant access by other means (no reactivation: a business that still
owes is returned to its billing suspension; see SC3c-1), and never reuse
the unlinked subscription.

## Stripe settings this relies on

- Checkout offers card only. Renewal invoices and the hosted invoice page
  use the payment methods configured in the Stripe Dashboard (test mode):
  keep those to **cards** as well until asynchronous methods are supported.
- The Customer Portal configuration must allow only payment-method updates
  and invoice history (checked before every session).

## Related

- Supported payment methods: Checkout offers **card only** (synchronous
  confirmation). Asynchronous methods (bank debits, transfers, vouchers)
  are deliberately not offered until their confirmation and recovery
  lifecycle exists (`SUPPORTED_CHECKOUT_PAYMENT_METHOD_TYPES`, pinned by a
  test).
- Refund handling for **restaurant orders** during a billing suspension is a
  separate, unresolved capability and a **release blocker** for live billing
  enforcement (`BILLING_ENFORCEMENT_ENABLED` stays off).
