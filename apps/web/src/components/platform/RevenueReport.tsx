import type { ReactNode } from "react";
import type { PlatformRevenueReport, RevenueCash, RevenueMonth } from "@mocha-house/contracts";
import {
  ENVIRONMENT_LABELS,
  STATUS_LABELS,
  VIOLATION_LABELS,
  barWidth,
  currenciesOf,
  money,
  monthLabel,
  periodLabel,
  rate,
} from "@/lib/platform/revenue";

// SC3f — the CENTERIVO SaaS revenue report (read-only). Every amount names
// its currency; currencies are never combined. Contracted recurring revenue
// (MRR/ARR) is shown apart from cash collected, which is not recognized
// revenue. Nothing here is a business's own data.

const CARD = "flex flex-col gap-1 rounded-2xl border border-border-default bg-surface-card p-5";
const TABLE = "w-full min-w-[36rem] border-collapse text-left text-sm";
const TH = "border-b border-border-default px-2 py-2 font-medium text-text-secondary";
const TD = "border-b border-border-default px-2 py-2 text-text-primary tabular-nums";

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-lg font-semibold text-text-primary">
        {title}
      </h2>
      {note ? <p className="text-sm text-text-secondary">{note}</p> : null}
      {children}
    </section>
  );
}

function Scroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
      {children}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-2xl border border-border-default bg-surface-card p-5 text-sm text-text-secondary">{children}</p>;
}

export function RevenueReport({ report }: { report: PlatformRevenueReport }) {
  const currencies = currenciesOf(report);
  const asOf = new Date(report.current.asOf).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
  const incompleteMonths = report.months.filter((m) => m.status !== "COMPLETE").length;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <p className="inline-flex w-fit rounded-full bg-status-warning/15 px-3 py-1 text-sm font-semibold text-text-primary">
          {ENVIRONMENT_LABELS[report.environment]}
        </p>
        <p className="text-sm text-text-secondary">
          Period: {periodLabel(report)} (calendar months, UTC). Current figures as of {asOf} UTC. Amounts are shown
          separately for each currency and never converted.
        </p>
        {report.dataQuality.incompleteSubscriptions > 0 || incompleteMonths > 0 ? (
          <p role="note" className="rounded-lg bg-status-warning/10 px-3 py-2 text-sm text-text-primary">
            {report.dataQuality.incompleteSubscriptions} subscription
            {report.dataQuality.incompleteSubscriptions === 1 ? "'s" : "s'"} billing history is incomplete, so{" "}
            {incompleteMonths} month{incompleteMonths === 1 ? " is" : "s are"} marked incomplete. Their figures count
            only what is known; nothing is estimated.
          </p>
        ) : null}
      </div>

      <Section id="rev-summary" title="Recurring revenue now" note="Contracted recurring revenue from paying subscriptions (active and past due) at the price each subscribed to. Annual plans count as one twelfth per month. Trials, unfinished setups, unpaid, ended and complimentary businesses are excluded. This is not cash or accounting revenue.">
        {report.current.recurring.length === 0 ? (
          <Empty>No paying subscriptions.</Empty>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {report.current.recurring.map((r) => (
              <li key={r.currency} className={CARD}>
                <p className="text-sm text-text-secondary">MRR ({r.currency})</p>
                <p className="text-2xl font-semibold text-text-primary tabular-nums">{money(r.mrrMinorUnits, r.currency)}</p>
                <p className="text-sm text-text-primary">ARR {money(r.arrMinorUnits, r.currency)}</p>
                <p className="text-sm text-text-primary">
                  {r.activePaidSubscriptions} paying ({r.monthlySubscriptions} monthly, {r.annualSubscriptions} annual)
                </p>
                <p className={r.atRiskSubscriptions > 0 ? "text-sm font-medium text-status-error" : "text-sm text-text-secondary"}>
                  At risk (payment failed): {r.atRiskSubscriptions} · {money(r.atRiskMrrMinorUnits, r.currency)} MRR
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="rev-trend" title={`Trend, ${periodLabel(report)}`} note="Recurring revenue at the end of each month (the current month: now). “—” means no paying subscriptions in that currency.">
        {currencies.length === 0 ? <Empty>No billing activity in this period.</Empty> : null}
        {currencies.map((currency) => {
          const values = report.months.map(
            (m) => m.recurring.find((r) => r.currency === currency)?.mrrMinorUnits ?? null,
          );
          const max = Math.max(0, ...values.map((v) => v ?? 0));
          return (
            <Scroll key={currency} label={`MRR trend in ${currency}`}>
              <table className={TABLE}>
                <caption className="mb-2 text-left text-sm font-medium text-text-primary">
                  MRR by month in {currency}, {periodLabel(report)}
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className={TH}>Month</th>
                    <th scope="col" className={TH}>MRR</th>
                    <th scope="col" className={`${TH} w-1/2`}>
                      <span className="sr-only">Bar</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.months.map((m, i) => (
                    <tr key={m.month}>
                      <th scope="row" className={`${TD} font-normal`}>
                        {monthLabel(m.month)}
                        {m.partial ? <span className="block text-xs text-text-secondary">So far this month</span> : null}
                        {m.status !== "COMPLETE" ? (
                          <span className="block text-xs font-medium text-status-error">
                            Incomplete: counts only known history
                          </span>
                        ) : null}
                      </th>
                      <td className={TD}>{values[i] === null ? "—" : money(values[i]!, currency)}</td>
                      <td className={TD} aria-hidden="true">
                        <div className="h-3 rounded bg-accent" style={{ width: barWidth(values[i] ?? 0, max) }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
          );
        })}
      </Section>

      <Section id="rev-plans" title="By plan and billing interval" note="Paying subscriptions now.">
        {report.current.byPlan.length === 0 ? (
          <Empty>No paying subscriptions.</Empty>
        ) : (
          <Scroll label="Recurring revenue by plan">
            <table className={TABLE}>
              <caption className="sr-only">Paying subscriptions by plan and billing interval now</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH}>Plan</th>
                  <th scope="col" className={TH}>Billed</th>
                  <th scope="col" className={TH}>Currency</th>
                  <th scope="col" className={TH}>Subscriptions</th>
                  <th scope="col" className={TH}>MRR</th>
                  <th scope="col" className={TH}>ARR</th>
                </tr>
              </thead>
              <tbody>
                {report.current.byPlan.map((p) => (
                  <tr key={`${p.planName}-${p.interval}-${p.currency}`}>
                    <th scope="row" className={`${TD} font-normal`}>{p.planName}</th>
                    <td className={TD}>{p.interval === "YEAR" ? "Annually" : "Monthly"}</td>
                    <td className={TD}>{p.currency}</td>
                    <td className={TD}>{p.subscriptions}</td>
                    <td className={TD}>{money(p.mrrMinorUnits, p.currency)}</td>
                    <td className={TD}>{money(p.arrMinorUnits, p.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        )}
      </Section>

      <Section
        id="rev-churn"
        title="Churn"
        note="Counted only when a paid subscription actually ends (not when cancellation is scheduled). Customer churn = paid subscriptions that ended ÷ those paying at the start of the month. Revenue churn = their MRR ÷ MRR at the start of the month, per currency. Moves to complimentary aren't churn."
      >
        <Scroll label="Monthly churn">
          <table className={TABLE}>
            <caption className="sr-only">Churn by month, {periodLabel(report)}</caption>
            <thead>
              <tr>
                <th scope="col" className={TH}>Month</th>
                <th scope="col" className={TH}>Paying at start</th>
                <th scope="col" className={TH}>Ended</th>
                <th scope="col" className={TH}>Customer churn</th>
                <th scope="col" className={TH}>Revenue churn</th>
                <th scope="col" className={TH}>Other cancellations</th>
                <th scope="col" className={TH}>To complimentary</th>
              </tr>
            </thead>
            <tbody>
              {report.months.map((m) => (
                <tr key={m.month}>
                  <th scope="row" className={`${TD} font-normal`}>{monthLabel(m.month)}</th>
                  <td className={TD}>{m.activePaidAtStart}</td>
                  <td className={TD}>{m.churn.ended}</td>
                  <td className={TD}>{rate(m.churn.ended, m.activePaidAtStart)}</td>
                  <td className={TD}>
                    {m.churn.revenue.length === 0
                      ? "—"
                      : m.churn.revenue
                          .map((r) => `${r.currency} ${rate(r.churnedMrrMinorUnits, r.startMrrMinorUnits)} (${money(r.churnedMrrMinorUnits, r.currency)})`)
                          .join(" · ")}
                  </td>
                  <td className={TD}>{m.churn.endedOther}</td>
                  <td className={TD}>{m.churn.movedToComplimentary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
        <p className="text-xs text-text-secondary">
          Other cancellations: paid subscriptions that ended after going unpaid, or that started paying within the month
          (not in the churn rate).
        </p>
      </Section>

      <Section id="rev-trials" title="Trial conversion" note="Trials are grouped by the month they started. A month stays incomplete while any of its trials can still convert.">
        <Scroll label="Trial conversion by start month">
          <table className={TABLE}>
            <caption className="sr-only">Trial conversion by the month trials started, {periodLabel(report)}</caption>
            <thead>
              <tr>
                <th scope="col" className={TH}>Started in</th>
                <th scope="col" className={TH}>Trials</th>
                <th scope="col" className={TH}>Converted to paid</th>
                <th scope="col" className={TH}>Conversion</th>
                <th scope="col" className={TH}>Expired</th>
                <th scope="col" className={TH}>In progress</th>
              </tr>
            </thead>
            <tbody>
              {report.trialCohorts.map((c) => (
                <tr key={c.month}>
                  <th scope="row" className={`${TD} font-normal`}>
                    {monthLabel(c.month)}
                    {c.started > 0 && !c.complete ? <span className="text-text-secondary"> (incomplete)</span> : null}
                  </th>
                  <td className={TD}>{c.started}</td>
                  <td className={TD}>{c.converted}</td>
                  <td className={TD}>{rate(c.converted, c.started)}</td>
                  <td className={TD}>{c.expired}</td>
                  <td className={TD}>{c.inProgress}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      </Section>

      <Section
        id="rev-cash"
        title="Cash, failed payments and recovery"
        note="Cash collected is what invoices were paid, by payment date, including tax — not recognized revenue (an annual invoice is collected once). Failed invoices are counted once each by issue month, however many retries; recovered means later paid in full, confirmed by the payment provider."
      >
        <MonthlyCash months={report.months} period={periodLabel(report)} />
      </Section>

      <Section id="rev-adjustments" title="Refunds and credits" note="Completed in the period, including those made directly at the payment provider and recorded by reconciliation. Refunds return cash; credits reduce future invoices. Neither is subtracted twice.">
        {report.adjustments.length === 0 ? (
          <Empty>No refunds or credits in this period.</Empty>
        ) : (
          <Scroll label="Refunds and credits">
            <table className={TABLE}>
              <caption className="sr-only">Refunds and credits completed, {periodLabel(report)}</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH}>Kind</th>
                  <th scope="col" className={TH}>Made</th>
                  <th scope="col" className={TH}>Currency</th>
                  <th scope="col" className={TH}>Count</th>
                  <th scope="col" className={TH}>Total</th>
                </tr>
              </thead>
              <tbody>
                {report.adjustments.map((a) => (
                  <tr key={`${a.currency}-${a.kind}-${a.origin}`}>
                    <th scope="row" className={`${TD} font-normal`}>
                      {a.kind === "CREDIT" ? "Account credit" : a.kind === "REFUND" ? "Cash refund" : "Refunded outside the provider"}
                    </th>
                    <td className={TD}>{a.origin === "CENTERIVO" ? "Through CENTERIVO" : "Directly at the provider"}</td>
                    <td className={TD}>{a.currency}</td>
                    <td className={TD}>{a.count}</td>
                    <td className={TD}>{money(a.totalMinorUnits, a.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        )}
      </Section>

      <Section id="rev-complimentary" title="Complimentary businesses" note="The list-price equivalent is what the arrangements' previous prices would bill. It is not lost revenue.">
        <ul className="grid gap-3 sm:grid-cols-3">
          <li className={CARD}>
            <p className="text-sm text-text-secondary">With an arrangement</p>
            <p className="text-2xl font-semibold text-text-primary tabular-nums">{report.current.complimentary.withArrangement}</p>
          </li>
          <li className={CARD}>
            <p className="text-sm text-text-secondary">Without one (e.g. Founding)</p>
            <p className="text-2xl font-semibold text-text-primary tabular-nums">{report.current.complimentary.withoutArrangement}</p>
          </li>
          <li className={CARD}>
            <p className="text-sm text-text-secondary">List-price equivalent (monthly)</p>
            {report.current.complimentary.listPriceEquivalent.length === 0 ? (
              <p className="text-text-primary">—</p>
            ) : (
              report.current.complimentary.listPriceEquivalent.map((e) => (
                <p key={e.currency} className="text-lg font-semibold text-text-primary tabular-nums">
                  {money(e.mrrMinorUnits, e.currency)} {e.currency}
                </p>
              ))
            )}
          </li>
        </ul>
      </Section>

      <Section id="rev-quality" title="Data quality">
        <ul className="flex flex-col gap-1 text-sm text-text-primary">
          <li>Subscriptions with incomplete billing history: {report.dataQuality.incompleteSubscriptions}</li>
          <li>
            Invoices without verified subtotal, discount and tax (recorded before these were captured; filled in when
            reconciliation reads them again): {report.dataQuality.invoicesWithoutAmounts}
          </li>
          {report.dataQuality.violations.length === 0 ? (
            <li>Accounting checks: all passed.</li>
          ) : (
            report.dataQuality.violations.map((v) => (
              <li key={v.code} className="font-medium text-status-error">
                {VIOLATION_LABELS[v.code] ?? v.code}: {v.count}
              </li>
            ))
          )}
        </ul>
        <p className="text-xs text-text-secondary">Status of each month: {report.months.map((m) => `${monthLabel(m.month)} ${STATUS_LABELS[m.status].split(" —")[0].toLowerCase()}`).join(", ")}.</p>
      </Section>
    </div>
  );
}

function MonthlyCash({ months, period }: { months: RevenueMonth[]; period: string }) {
  const rows = months.flatMap((m): { m: RevenueMonth; cash: RevenueCash | null }[] =>
    m.cash.length === 0 ? [{ m, cash: null }] : m.cash.map((cash) => ({ m, cash })),
  );
  return (
    <Scroll label="Cash and failed payments by month">
      <table className={TABLE}>
        <caption className="sr-only">Cash, failed payments and recovery by month, {period}</caption>
        <thead>
          <tr>
            <th scope="col" className={TH}>Month</th>
            <th scope="col" className={TH}>Currency</th>
            <th scope="col" className={TH}>Cash collected</th>
            <th scope="col" className={TH}>Tax on paid invoices</th>
            <th scope="col" className={TH}>Refunds</th>
            <th scope="col" className={TH}>Refunded outside the provider</th>
            <th scope="col" className={TH}>Credits issued</th>
            <th scope="col" className={TH}>Credit applied</th>
            <th scope="col" className={TH}>Recovered</th>
            <th scope="col" className={TH}>Failed invoices</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ m, cash }, i) => (
            <tr key={`${m.month}-${cash?.currency ?? "none"}-${i}`}>
              <th scope="row" className={`${TD} font-normal`}>{monthLabel(m.month)}</th>
              <td className={TD}>{cash?.currency ?? "—"}</td>
              <td className={TD}>{cash ? money(cash.collectedMinorUnits, cash.currency) : "—"}</td>
              <td className={TD}>
                {cash ? (cash.taxMinorUnits === null ? "Not yet known" : money(cash.taxMinorUnits, cash.currency)) : "—"}
              </td>
              <td className={TD}>{cash ? money(cash.refundsMinorUnits, cash.currency) : "—"}</td>
              <td className={TD}>{cash ? money(cash.refundsOutsideProviderMinorUnits, cash.currency) : "—"}</td>
              <td className={TD}>{cash ? money(cash.creditsIssuedMinorUnits, cash.currency) : "—"}</td>
              <td className={TD}>{cash ? money(cash.balanceAppliedMinorUnits, cash.currency) : "—"}</td>
              <td className={TD}>{cash ? money(cash.recoveredMinorUnits, cash.currency) : "—"}</td>
              <td className={TD}>
                {i === 0 || rows[i - 1].m.month !== m.month
                  ? `${m.failedInvoices.count}${m.failedInvoices.amountDue.length > 0 ? ` (${m.failedInvoices.amountDue.map((a) => money(a.minorUnits, a.currency)).join(", ")} due)` : ""}${m.failedInvoices.unverified > 0 ? `; ${m.failedInvoices.unverified} not yet known` : ""}; ${m.recoveredInvoices} recovered`
                  : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}
