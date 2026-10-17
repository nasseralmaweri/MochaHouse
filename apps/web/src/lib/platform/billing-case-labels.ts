// The operator wording of each billing review case kind (console).
export const CASE_LABELS: Record<string, string> = {
  STATE_MISMATCH: "Billing status differs from the payment provider",
  PAYMENT_METHOD_NOT_RECORDED: "Payment provider has a payment method we haven't recorded",
  PAYMENT_METHOD_MISSING: "Payment method removed at the payment provider",
  CANCELLATION_MISMATCH: "Scheduled cancellation differs from the payment provider",
  CUSTOMER_MISMATCH: "Provider subscription belongs to another customer",
  CHECKOUT_CUSTOMER_MISMATCH: "Payment setup completed for another customer",
  CHECKOUT_LINKED_ELSEWHERE: "Payment setup completed after another subscription was linked",
  CHECKOUT_NOT_LINKED: "Payment setup completed but was never linked",
  UNEXPECTED_TRIAL: "Provider started a trial we did not offer, or one already used",
  INVOICE_MISMATCH: "Invoice does not belong to this business",
  INVOICE_NOT_PAID: "Payment reported but the invoice is not paid",
  SUBSCRIPTION_MISMATCH: "Provider subscription does not match our records",
  EVENT_NOT_APPLIED: "A billing event could not be applied",
  EVENT_RETRIES_EXHAUSTED: "A billing event kept failing and was set aside",
  UNLINKED_REPLACEMENT: "A restart was created at the payment provider but not linked (see the recovery runbook)",
  CHECKOUT_NOT_RECORDED: "A payment page was created but could not be recorded",
  PROVIDER_UNREADABLE: "The payment provider could not be read",
  SUSPENSION_EXEMPT: "Billing would have suspended a business that is exempt",
  // SC3c-3
  BILLING_CONTACT_MISSING: "No one eligible to receive billing email",
  BILLING_CONTACT_UNVERIFIED:
    "The designated billing contact's email isn't verified (or the verification expired); they need to sign in again",
  BILLING_NOTIFICATION_FAILED: "A billing email could not be sent",
  // SC3d
  PRICE_MISMATCH: "The payment provider bills a different price than our records",
  PLAN_CHANGE_AMOUNT_MISMATCH:
    "A plan change was paid, but the amount differs from the price the business confirmed",
  UPGRADE_PAID_NOT_APPLIED: "A plan change was paid but not applied",
  PLAN_CHANGE_UNCERTAIN: "A plan change needs checking against the payment provider",
  // SC3d-3
  // SC3e-1
  INVOICE_HISTORY_CONFLICT:
    "The payment provider reported an invoice differently from the recorded billing history (nothing was overwritten)",
  SCHEDULED_CHANGE_DISRUPTED:
    "A scheduled plan change was removed or altered at the payment provider, or didn't take effect (never recreated)",
  EXTENSION_ENDED_BY_PROVIDER:
    "The payment provider ended a subscription during extra time an operator gave",
  // SC3e-2
  // SC3e-3
  EXTERNAL_BILLING_ADJUSTMENT:
    "A refund or credit was made directly at the payment provider, not through CENTERIVO (recorded; never repeated or reversed)",
  BILLING_ADJUSTMENT_UNCERTAIN:
    "A refund or credit wasn't confirmed by the payment provider and wasn't re-sent; check the provider, then resolve it",
  BILLING_ADJUSTMENT_REFUND_FAILED: "An approved refund failed at the payment provider",
  BILLING_ADJUSTMENT_MISMATCH: "A refund or credit at the payment provider differs from what was approved",
  COMPLIMENTARY_CANCELLATION_UNDONE:
    "A scheduled complimentary arrangement was withdrawn: its cancellation was undone at the payment provider (not re-issued)",
};
