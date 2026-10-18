# Restaurant payment hardening (ESP-03 PR 3)

This covers restaurant customer payments: food-order checkout and gift-card
purchases. CENTERIVO's own SaaS subscription billing is separate and
unchanged. This slice is processor-neutral: no real processor is connected,
and nothing here moves money.

It builds on the payment state machine from ESP-03 PR 2
(`apps/api/src/payment/payment-charge.ts`):
- a payment is claimed (`CHARGING`) before the processor is called;
- an uncertain outcome is held (`UNKNOWN` or `AWAITING_CONFIRMATION`) and is
  never charged again.

## What changed

### 1. Gift-card payment keys can't be reused across purchases

A gift-card purchase may only attach to a payment attempt that has not been
charged and is itself a gift-card attempt:
- it has no location;
- it is `PENDING`, with payment state `NOT_SENT` (or legacy empty);
- it is for the same amount.

These are refused with one generic conflict, and nothing is created or
changed:
- a food-order checkout's payment;
- a payment for a different amount;
- a payment already charging, held or charged;
- another business's payment.

Checkout already refuses a key whose payment belongs to a different location,
which includes every gift-card payment.

### 2. Authorization before any payment status

**Step 2 (complete the purchase)** answers only the buyer: the signed-in
owning customer, or a guest with the recovery credential from step 1. Anyone
else gets exactly the answer an unknown key gets:
- 409 `GIFT_CARD_PURCHASE_NOT_FOUND`, the same in every state (pending,
  declined, failed, held, under reconciliation, or issued);
- so nothing about the payment, its card or its reference is revealed.

The storefront restarts the purchase on that answer.

**Step 1 (start the purchase)** replays only while the purchase still waits
for its first payment. Once payment has started, been taken or needs review,
a replay of step 1 is the generic conflict.

### 3. Uncertain outcomes are visible to people

These open a `PaymentReconciliationCase`, at most one per payment, with a
SYSTEM `OPENED` event:

| Situation | Reason code |
| --- | --- |
| The processor's answer is unknown (it threw, timed out, or returned something unrecognised) | `PROVIDER_OUTCOME_UNKNOWN` |
| The processor reports the payment pending | `PROVIDER_AWAITING_CONFIRMATION` |
| The processor said "succeeded", but the result could not be recorded | `PROVIDER_SUCCEEDED_UNRECORDED` |
| Another definitive result could not be recorded | `PROVIDER_OUTCOME_UNRECORDED` |
| A gift-card purchase claimed over five minutes ago whose payment was never sent (nothing was charged) | `CHARGE_CLAIM_STRANDED` |

- **Event details** hold only fixed codes: never processor text, personal
  data, keys or tokens.
- **Best effort:** opening a case never fails the customer's request, because
  money may already have moved. A failure is logged, and the payment stays
  held.
- **Not yet:** nothing resolves cases (ESP-03 PR 5).

### 4. Processor references are kept

- A reference the processor returns is stored, including on a pending result.
- If the result itself could not be recorded, the reference fills an empty
  reference field and is never overwritten.
- If even that write fails (the database is unavailable), the server error log
  records the payment id and the reference, so the payment is always
  traceable. References are processor ids, not personal data.

### 5. Fixed customer messages

Declined and failed payments answer customers with fixed wording:
- "Your payment was declined. Nothing was charged. Please try another payment
  method."
- "Your payment could not be completed. Nothing was charged. Please try
  again."

The processor's own text stays in the payment's internal `failureReason` and
is never returned.

## Unchanged

- One charge per payment, with the payment's own key.
- Tenant ownership of every attempt.
- Held payments are never charged again.
- Legacy rows keep their legacy meaning.
- No migration: this slice uses the reconciliation tables from ESP-03 PR 1.

## Next (not in this slice)

| Slice | Scope |
| --- | --- |
| PR 4 | Resumable fulfilment |
| PR 5 | Reconciliation resolver, admin screen, case sweeper and duplicate-charge guard |
| PR 6 | Server-generated processor keys and request fingerprint |
| PR 7 | Business-scoped key uniqueness and frozen prices |

A real processor, refunds and webhooks come after those.

## Tests

`apps/api/src/payment/payment-hardening.spec.ts` covers:
- key reuse across purchase types, amounts, payment states and businesses;
- stranger answers equal to an unknown key's in every state, issued included;
- unknown and pending outcomes opening exactly one case under concurrent
  retries;
- lost and failed writes after a processor success;
- a stranded charge claim;
- fixed customer messages.
