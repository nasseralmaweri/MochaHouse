# Billing contacts, grace extensions and billing email — operator runbook (SC3c-3)

CENTERIVO's own SaaS subscription billing (Stripe **test mode**). Never
restaurant customer payments or restaurant notifications.

Both switches are **off** by default and need separate approval to turn on
anywhere persistent:

- `BILLING_ENFORCEMENT_ENABLED=1`: suspensions, entitlement changes, the
  expiry sweep and its reminders.
- `BILLING_NOTIFICATIONS_ENABLED=1`: billing notices are queued (API) and
  delivered (worker).

## Billing contact

- Each business has at most one **designated billing contact**, one of its
  **own** staff (the database refuses another business's staff). It is set
  to the first owner when billing starts. An operator can reassign it from
  Platform Console → Tenant → Billing. This needs a recent sign-in and is
  audited (`platform.billing.contact_assigned`: the business, who was
  designated, and who was replaced).
- Only ACTIVE staff with **billing.manage business-wide** can be designated.
- Billing email goes to the **designated contact** if they are eligible
  **at the moment of sending**. Otherwise it goes to the **earliest eligible
  administrator**. If nobody qualifies, nothing is sent.
- Eligible means all three:
  - ACTIVE;
  - billing.manage business-wide;
  - the identity provider confirmed the stored email address as verified at
    a sign-in in the last **90 days** (`BILLING_EMAIL_VERIFICATION_MAX_AGE_DAYS`
    in the code). A sign-in longer ago, or a verification of a different
    address, does not count.
- **`BILLING_CONTACT_MISSING` case:** no one eligible, so nothing was sent.
  Ask a staff member who manages billing to sign in to CENTERIVO, which
  re-verifies their email, or designate someone who has. Resolve the case
  once the panel shows a recipient.

- **`BILLING_CONTACT_UNVERIFIED` case:** the designated contact could not
  receive a notice, because their email is unverified, the verification
  expired, or they lost eligibility. The notice still goes to the fallback
  administrator if one is eligible; otherwise nothing is sent and
  `BILLING_CONTACT_MISSING` is opened too.
  - An expired verification never drops a notice silently.
  - **To fix:** ask the contact to sign in, or designate someone else. Then
    resolve the case.

### Release requirement: ongoing verification of the billing contact

The 90-day rule is a **conservative development default (provisional)**.
Today an email counts as verified only when the person signs in. A verified
billing contact who does not sign in for 90 days therefore stops receiving
billing email directly. That is surfaced by `BILLING_CONTACT_UNVERIFIED`,
never silent.

**Before live billing enforcement**, CENTERIVO needs a reliable way to keep
the designated contact's email verified without depending on sign-ins (for
example, periodic confirmation of the billing address). This is deliberately
**not** part of SC3c-3, which adds no new identity system. Until then,
operators must act on `BILLING_CONTACT_UNVERIFIED` cases.

## More time to pay

Platform Console → Tenant → Billing → **More time to pay**. Every grant needs
a recent sign-in and a written reason (10–500 characters, kept in the
business's history), and is audited (`platform.billing.grace_extended`).

- **Past due** (grace period running): the grace period is extended.
- **Unpaid** (grace over): an explicit **grace exception**. It gives
  temporary access and lifts **only** a billing suspension, never a security
  or administrative one. The subscription stays **unpaid**, and nothing is
  recorded as paid.
- **Limits:**
  - at most 14 days each time;
  - at most 60 days in total per unpaid episode, which starts at the first
    failed payment.
- Before granting, Stripe is read live. If Stripe has ended the
  subscription, or it is not past due or unpaid there, the grant is refused
  (`BILLING_NOT_RECOVERABLE`).
- **Expiry is automatic** (the sweep, while enforcement is on). Premium
  modules stop at the exact end. A billing suspension returns at the next
  sweep (every 5 minutes by default).
- **Never automatic:** no subscription is created and nothing is charged or
  refunded. Complimentary access is a separate, explicit decision.

### `EXTENSION_ENDED_BY_PROVIDER` case

Stripe ended a subscription while an operator's extension or exception was
in force.

- **What the system already did:**
  - the business is `CANCELED`;
  - the exception ended;
  - a billing suspension that the exception had lifted is restored;
  - nothing is shown as paid;
  - nothing was changed at Stripe.
- **What to do:** decide with the business whether it restarts (Billing →
  Restart subscription) or needs a separate complimentary decision. Then
  resolve the case.
- The live check before a grant is best effort: Stripe can end the
  subscription in the moment between the check and the grant. This case
  covers that too.

## Billing email delivery

- Notices:
  - payment failed;
  - grace / exception ending (3 days ahead);
  - paused for billing;
  - access restored (temporary when it is an exception);
  - trial ended;
  - trial recovery ending (1 day ahead);
  - restart confirmed;
  - restart under review.
- **Deduplication:** each notice is sent once per actual billing event or
  unpaid episode. An extension that moves a deadline gets a new reminder.
- **Rechecked at delivery:** a notice is skipped, not sent, when it is
  stale (past its expiry) or no longer true (paid meanwhile, deadline moved,
  case closed).
- **Content:** sent from `BILLING_EMAIL_FROM` with the display name
  CENTERIVO, separate from restaurant notifications. No payment links,
  amounts or card details.
- **Attempts:** at most **two** per notice. A timeout can still deliver an
  email twice; such rows are flagged `possibleDuplicate`. Nothing claims
  exactly-once delivery.
- **`BILLING_NOTIFICATION_FAILED` case:** a notice could not be sent after
  its attempts, or an attempt was abandoned mid-send. Check the sender
  configuration (`BILLING_EMAIL_PROVIDER=ses`, `BILLING_EMAIL_FROM`, SES
  identity). Contact the business another way if the notice mattered, then
  resolve the case. Failed notices are not resent automatically.
- **No paging:** there is no external alerting. The console's Billing page
  shows the counts ("Needs attention").

## Related

- `docs/operations/billing-recovery.md` (SC3c-2 restarts and invoice
  recovery).
