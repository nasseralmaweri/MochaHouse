# SaaS revenue reporting (SC3f)

**Billing → Revenue reporting** in the Platform Console reports what
businesses pay CENTERIVO. It never reads a restaurant's sales, orders,
customer payments or gift cards. The report is read-only. It needs the
`billing.reports.view` operator permission, and every read is audited
(`platform.billing.revenue_report_viewed`).

Until live billing is approved, every figure comes from **Stripe Test Mode**,
and the page shows the environment at the top.

## Access

`billing.reports.view` is granted through the provisioning CLI, like the
other non-financial permissions. Nobody gets it automatically, and business
staff can never reach the report.

```bash
DATABASE_URL=... pnpm --filter @mocha-house/database platform:operator grant --confirm-database <db> --email <operator email> --permission billing.reports.view --reason "Monthly revenue review"
```

## Periods and currencies

- A period is a set of calendar months in UTC: at most 24, never in the
  future. The default is the last 12 months, including the current one.
- Every amount is reported per currency and is never converted or added
  across currencies. Combining currencies needs an approved exchange-rate
  policy first.
- The report returns totals only, never anything about an individual
  business.

## Definitions

| Metric | Definition |
|---|---|
| MRR / ARR | Contracted recurring revenue of **paying** subscriptions, at the price version each one subscribed to, never a newer catalog price. ARR adds monthly × 12 and annual exactly; MRR = ARR ÷ 12, rounded once per total so rounding never accumulates. A scheduled plan change counts only from when it takes effect. |
| Paying | Billed, ACTIVE or PAST_DUE, with a provider subscription and a paid period. Trials, unfinished payment setup, UNPAID, ended, Founding and complimentary businesses are excluded. |
| At-risk MRR | The PAST_DUE part of MRR (it is included in MRR). |
| Customer churn | Paid subscriptions that **ended** (canceled) in the month ÷ subscriptions paying at the start of the month. A cancellation that is only scheduled is not churn. |
| Revenue churn | The MRR of those ended subscriptions ÷ MRR at the start of the month, per currency. |
| Other ends | Paid subscriptions that ended after going unpaid, or that started paying within the month. These are not in the churn rate. |
| Moved to complimentary | A paid subscription that became complimentary. It is not churn. |
| Trial conversion | Grouped by the month the trial started. A trial converts at its first verified payment. A cohort stays **incomplete** while any of its trials can still convert, including an expired trial still inside its recovery window. |
| Cash collected | What paid invoices collected, by payment date, including tax. It is **not** recognized revenue: an annual invoice is collected in a single month. |
| Tax on paid invoices | The tax on those invoices as invoiced (not pro rata to cash paid after a credit balance). It is shown only when every invoice in the month has verified amounts, and otherwise reads "not yet known". It is never assumed to be zero. |
| Failed invoices | Invoices with at least one failed payment attempt (paid only on a later attempt, or attempted and never paid). Each counts **once**, by issue month, however many retries it had. |
| Recovered | A failed invoice later paid in full, as confirmed by the payment provider: its status is paid and it has a payment date. A status change alone doesn't count. |
| Refunds | Completed cash refunds, through CENTERIVO or made directly at the provider and recorded by reconciliation, by completion date. |
| Refunded outside the provider | Credit notes recording money returned outside Stripe (out of band), shown apart from Stripe cash refunds. |
| Credits issued | Completed account credits (credit notes to the customer balance). |
| Credit applied | Customer balance used by invoices issued that month. This includes proration credits. It is already reflected in cash collected, so it is never subtracted again. |
| Complimentary | Businesses with an active arrangement, and those without one (for example Founding). The list-price equivalent is what the arrangements' previous prices would bill. It is **not** lost revenue. |

Net revenue is **not** reported. Tax-exclusive and discount figures exist
only for invoices whose amounts were captured.

## Historical accuracy

History is rebuilt from the append-only subscription history, together with
two immutable sources:
- **completed checkouts**: each one sets the price from the moment it
  completes (start, restart or replacement);
- **complimentary grants**.

Each rebuilt history must end exactly at the subscription's current record:
paying or not, at the same price, status and billing mode. If it doesn't,
that subscription is counted as **incomplete**, and every month it touches is
marked incomplete.

A price is never assumed from the current record. A payment with no recorded price source, or a price that can't be found, makes the month **incomplete** and is reported (`PRICE_NOT_FOUND`) rather than counted as zero.

Nothing is estimated. History events are dated when they were recorded, and
a late provider event is dated when it arrived.

## Rounding and partial months

- MRR is ARR ÷ 12, rounded once per figure shown. Each plan's MRR is rounded on its own, so plan MRRs can differ from the total by a minor unit. ARR always adds up exactly.
- The current month is shown "so far": it ends now, not at the month end.

## Invoice amounts (subtotal, discounts, tax, attempts)

New invoice reads capture the following from verified Stripe records:
- subtotal;
- discounts;
- tax;
- total excluding tax;
- the payment attempt count.

Invoices recorded before SC3f show them as unknown. The reconciliation run
(**Billing → Run reconciliation**) re-reads each billed subscription's
invoices from the provider and fills them in. A captured amount is never
cleared back to unknown; the database refuses it.

## Accounting checks

The report flags any violation of these rules under **Data quality**:
- every invoice's total equals its total excluding tax plus its tax;
- no invoice is paid for more than its total;
- no invoice is refunded or credited for more than was paid;
- the plan breakdown adds up to the totals;
- every subscribed price exists.

## Limits

- Each report is computed on request: from subscriptions in batches of 500
  (at most 50,000) and from invoices in the period (at most 200,000).
  Monthly snapshots can be added later if performance requires them.
- CSV export, scheduled delivery, forecasting and accounting integrations are
  out of scope.
