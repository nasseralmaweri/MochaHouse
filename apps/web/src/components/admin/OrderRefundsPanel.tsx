"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  CreateOrderRefundRequest,
  OrderRefundsResponse,
  OrderRefundView,
} from "@mocha-house/contracts";
import {
  ORDER_REFUND_NOTE_MAX_LENGTH,
  ORDER_REFUND_REASON_CODES,
  ORDER_REFUND_REASON_LABELS,
} from "@mocha-house/contracts";
import { formatPrice } from "@/lib/money";
import {
  EMPTY_DRAFT,
  browserSessionStore,
  buildRefundRequest,
  canRecheck,
  expectedReservedOf,
  clearPendingRefund,
  flowAfter,
  getOrderRefundsFromBrowser,
  loadPendingRefund,
  minorUnitDigits,
  needsLateFailureReview,
  recheckOrderRefundFromBrowser,
  refundAccess,
  refundOutcomeMessage,
  refundStatusView,
  requestOrderRefundFromBrowser,
  reviewOrderRefundFromBrowser,
  savePendingRefund,
  validateDraft,
  validateReviewNote,
  type DraftErrors,
  type RefundDraft,
  type RefundFlow,
} from "@/lib/admin/order-refunds";
import { Card } from "@/components/Card";
import { Button } from "@/components/admin/Button";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { ADMIN_FIELD_CLASS, FormField } from "@/components/admin/form";

// ESP-04 M5d — card refunds inside Order Details. Every figure is the
// server's (M5b refund balances); the server checks every refund again.
// Staff without `orders.refund` here see the history only (internal notes
// are already removed by the API for them) and no actions.
export function OrderRefundsPanel({
  orderId,
  locationId,
  orderTotalMinorUnits,
  canRefund,
  userId,
}: {
  orderId: string;
  locationId: string;
  orderTotalMinorUnits: number;
  canRefund: boolean;
  // The signed-in staff member (a pending refund is theirs only).
  userId: string;
}) {
  const [data, setData] = useState<OrderRefundsResponse | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ok" | "hidden" | "error">(
    "loading",
  );
  const [flow, setFlow] = useState<RefundFlow>({ step: "closed", notice: null });
  const [draft, setDraft] = useState<RefundDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<DraftErrors>({});
  // A second click in the same tick is refused before React re-renders.
  const sending = useRef(false);

  // Only the newest load's answer is applied (an older one landing late
  // never replaces newer figures).
  const loadSeq = useRef(0);

  // A refund of THIS staff member left unanswered (page closed or reloaded)
  // is restored so its result is checked, never a new one started. It is
  // kept even where they can no longer act on it (shown without a button).
  const restorePending = useCallback(
    () => {
      const pending = loadPendingRefund(browserSessionStore(), userId, orderId, locationId);
      if (!pending) return;
      setFlow((current) =>
        current.step === "closed"
          ? {
              step: "uncertain",
              request: pending,
              message:
                "A refund you submitted from this page wasn't confirmed before the page closed.",
            }
          : current,
      );
    },
    [userId, orderId, locationId],
  );

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const result = await getOrderRefundsFromBrowser(orderId, locationId);
    if (seq !== loadSeq.current) return;
    if (result.outcome === "success") {
      setData(result.data);
      setLoadState("ok");
    } else if (result.outcome === "forbidden" || result.outcome === "not-found") {
      setLoadState("hidden");
    } else {
      // A failed refresh keeps the figures already shown (and any outcome
      // message); only a first load shows the error.
      setLoadState((current) => (current === "ok" ? current : "error"));
    }
  }, [orderId, locationId]);

  useEffect(() => {
    let cancelled = false;
    const seq = ++loadSeq.current;
    void getOrderRefundsFromBrowser(orderId, locationId).then((result) => {
      if (cancelled || seq !== loadSeq.current) return;
      if (result.outcome === "success") {
        setData(result.data);
        setLoadState("ok");
        restorePending();
      } else if (result.outcome === "forbidden" || result.outcome === "not-found") {
        setLoadState("hidden");
      } else {
        setLoadState("error");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [orderId, locationId, restorePending]);

  // A review prepared on figures that have since changed is never sent:
  // back to the form, and a new review (a new request) is needed.
  const reviewIsStale =
    flow.step === "review" &&
    data?.balances != null &&
    expectedReservedOf(data.balances) !== flow.request.expectedReservedMinorUnits;
  const shownFlow: RefundFlow = reviewIsStale
    ? {
        step: "editing",
        notice:
          "The refunds on this order changed while you were reviewing. Check the latest figures and review again.",
      }
    : flow;

  async function submit(request: CreateOrderRefundRequest, retryOfUnknown: boolean) {
    if (sending.current) return;
    sending.current = true;
    const store = browserSessionStore();
    savePendingRefund(store, userId, orderId, request);
    setFlow({ step: "submitting", request });
    try {
      const result = await requestOrderRefundFromBrowser(orderId, request);
      const next = flowAfter(request, result, retryOfUnknown);
      if (next.settled) clearPendingRefund(store, userId, orderId);
      if (next.flow.step === "done" || next.flow.step === "closed") {
        setDraft(EMPTY_DRAFT);
        setErrors({});
      }
      setFlow(next.flow);
      if (next.reload) await load();
    } finally {
      sending.current = false;
    }
  }

  if (loadState === "hidden") return null;
  if (loadState === "loading") {
    return (
      <Card className="text-sm text-text-muted">
        <p aria-busy="true">Loading card refunds…</p>
      </Card>
    );
  }
  if (loadState === "error" || !data) {
    return (
      <Card className="flex flex-col items-start gap-2 text-sm">
        <p className="text-text-secondary">Couldn&apos;t load this order&apos;s card refunds.</p>
        <Button variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      </Card>
    );
  }

  const currency = data.currency;
  const access = refundAccess(data, canRefund);
  const balances = data.balances;
  const attention = new Set(data.attentionRefundIds ?? []);
  // Actions on existing refunds need refunds switched on, and `orders.refund`.
  const manage = canRefund && data.refundsEnabled;

  return (
    <section aria-labelledby="refunds-heading" className="flex flex-col gap-3">
      <h2
        id="refunds-heading"
        className="text-sm font-semibold uppercase tracking-wide text-text-secondary"
      >
        Card refunds
      </h2>

      {data.paymentNeedsAttention ? (
        <Card tone="subtle" className="text-sm text-status-warning">
          <p role="note">
            <strong>Needs attention.</strong> Support is reviewing this order&apos;s card
            payment. Refund figures may change once that&apos;s resolved.
          </p>
        </Card>
      ) : null}

      {balances ? (
        <Card className="flex flex-col gap-2">
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
            <Figure label="Paid by card" value={formatPrice(balances.chargedMinorUnits, currency)} />
            <Figure label="Refunded" value={formatPrice(balances.refundedMinorUnits, currency)} />
            {balances.inProgressMinorUnits > 0 ? (
              <Figure
                label="In progress"
                value={formatPrice(balances.inProgressMinorUnits, currency)}
              />
            ) : null}
            <Figure
              label="Can still be refunded"
              value={formatPrice(balances.refundableMinorUnits, currency)}
              strong
            />
            {data.obligation && data.obligation.outstandingMinorUnits > 0 ? (
              <Figure
                label="Still owed to the customer"
                value={formatPrice(data.obligation.outstandingMinorUnits, currency)}
                strong
                warning
              />
            ) : null}
          </dl>
          {balances.chargedMinorUnits !== orderTotalMinorUnits ? (
            <p className="text-xs text-text-muted">
              Part of this order was paid another way (for example a gift card). Only the
              card payment can be refunded here.
            </p>
          ) : null}
          {data.obligation?.needsAttention ? (
            <p className="text-xs font-medium text-status-warning">
              Needs attention: a refund toward what&apos;s owed came back or no longer
              covers it.
            </p>
          ) : null}
        </Card>
      ) : (
        <Card tone="subtle" className="text-sm text-text-secondary">
          This order wasn&apos;t paid by card, so there&apos;s no card payment to refund.
        </Card>
      )}

      <RefundAction
        data={data}
        access={access}
        flow={shownFlow}
        draft={draft}
        errors={errors}
        onDraft={(next) => {
          setDraft(next);
          setErrors({});
        }}
        onOpen={() => setFlow({ step: "editing", notice: null })}
        onCancel={() => {
          setDraft(EMPTY_DRAFT);
          setErrors({});
          setFlow({ step: "closed", notice: null });
        }}
        onReview={() => {
          if (!balances) return;
          const checked = validateDraft(draft, access.maxMinorUnits, currency);
          if (!checked.ok) {
            setErrors(checked.errors);
            return;
          }
          // One request id per submission, made here and kept for retries.
          let requestId: string;
          try {
            requestId = crypto.randomUUID();
          } catch {
            setFlow({
              step: "editing",
              notice: "This browser can't start a refund safely here. Use a current browser over a secure connection.",
            });
            return;
          }
          setFlow({
            step: "review",
            request: buildRefundRequest(checked.value, {
              locationId,
              currency,
              balances,
              requestId,
            }),
          });
        }}
        onBack={() => setFlow({ step: "editing", notice: null })}
        manage={manage}
        onSubmit={(request, retryOfUnknown) => void submit(request, retryOfUnknown)}
      />

      {data.refunds.length > 0 ? (
        <Card className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-text-primary">Refund history</h3>
          <ul className="flex flex-col divide-y divide-border-default">
            {[...data.refunds].reverse().map((refund) => (
              <RefundRow
                key={refund.id}
                refund={refund}
                orderId={orderId}
                locationId={locationId}
                flagged={attention.has(refund.id)}
                manage={manage}
                onChanged={load}
              />
            ))}
          </ul>
        </Card>
      ) : null}
    </section>
  );
}

function Figure({
  label,
  value,
  strong = false,
  warning = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
  warning?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 sm:flex-col sm:items-start sm:gap-0">
      <dt className="text-text-secondary">{label}</dt>
      <dd
        className={`${strong ? "font-semibold" : ""} ${
          warning ? "text-status-warning" : "text-text-primary"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function RefundAction({
  data,
  access,
  flow,
  draft,
  errors,
  onDraft,
  onOpen,
  onCancel,
  onReview,
  onBack,
  onSubmit,
  manage,
}: {
  data: OrderRefundsResponse;
  access: ReturnType<typeof refundAccess>;
  flow: RefundFlow;
  draft: RefundDraft;
  errors: DraftErrors;
  onDraft: (next: RefundDraft) => void;
  onOpen: () => void;
  onCancel: () => void;
  onReview: () => void;
  onBack: () => void;
  onSubmit: (request: CreateOrderRefundRequest, retryOfUnknown: boolean) => void;
  // May act on refunds here (orders.refund, refunds on).
  manage: boolean;
}) {
  const id = useId();
  const currency = data.currency;

  // A submission with no definite answer: only its result may be checked.
  if (flow.step === "uncertain" || flow.step === "submitting") {
    const busy = flow.step === "submitting";
    return (
      <Card className="flex flex-col gap-3">
        <div role="status" aria-live="polite" className="flex flex-col gap-1 text-sm">
          {busy ? (
            <p className="text-text-primary">
              Refunding {formatPrice(flow.request.amountMinorUnits, currency)}…
            </p>
          ) : (
            <>
              <p className="font-medium text-status-warning">We couldn&apos;t confirm this refund.</p>
              <p className="text-text-secondary">{flow.message}</p>
              {manage ? (
                <p className="text-text-secondary">
                  Don&apos;t start a new refund. Check this one first: it is made at most
                  once, so checking never refunds twice (if it never reached Stripe, it is
                  made now).
                </p>
              ) : (
                <p className="text-text-secondary">
                  You can&apos;t act on refunds here right now. Check the refund history
                  below, or ask someone who can refund to open this order.
                </p>
              )}
            </>
          )}
        </div>
        {manage ? (
          <Button
            onClick={() => onSubmit(flow.request, true)}
            disabled={busy}
            className="sm:self-start"
          >
            {busy
              ? "Checking…"
              : `Check the ${formatPrice(flow.request.amountMinorUnits, currency)} refund`}
          </Button>
        ) : null}
      </Card>
    );
  }

  if (flow.step === "done" || flow.step === "closed") {
    const notice =
      flow.step === "done"
        ? refundOutcomeMessage(flow.refund, flow.replayed)
        : flow.notice;
    return (
      <div className="flex flex-col gap-2">
        <div role="status" aria-live="polite">
          {notice ? (
            <Card tone="subtle" className="text-sm text-text-primary">
              {notice}
            </Card>
          ) : null}
        </div>
        {access.canIssue ? (
          <Button onClick={onOpen} className="sm:self-start">
            Refund to card
          </Button>
        ) : access.reason ? (
          <p className="text-sm text-text-muted">{access.reason}</p>
        ) : null}
      </div>
    );
  }

  // editing / review need the action to still be allowed on fresh figures.
  if (!access.canIssue) {
    return (
      <div className="flex flex-col gap-2">
        {flow.step === "editing" && flow.notice ? (
          <Card tone="subtle" className="text-sm text-status-warning">
            <p role="alert">{flow.notice}</p>
          </Card>
        ) : null}
        {access.reason ? <p className="text-sm text-text-muted">{access.reason}</p> : null}
      </div>
    );
  }

  const max = formatPrice(access.maxMinorUnits, currency);

  if (flow.step === "review") {
    const r = flow.request;
    return (
      <Card className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-text-primary">Review refund</h3>
        <p className="text-2xl font-semibold text-text-primary">
          {formatPrice(r.amountMinorUnits, currency)}
        </p>
        <p className="text-sm text-text-secondary">
          This goes back to the card the customer paid with for this order. It can&apos;t be
          sent anywhere else, and it can take a few business days to appear on their statement.
        </p>
        <dl className="flex flex-col gap-1 text-sm">
          <div className="flex gap-2">
            <dt className="text-text-secondary">Reason:</dt>
            <dd className="text-text-primary">{ORDER_REFUND_REASON_LABELS[r.reasonCode]}</dd>
          </div>
          {r.note ? (
            <div className="flex gap-2">
              <dt className="text-text-secondary">Internal note:</dt>
              <dd className="break-words text-text-primary">{r.note}</dd>
            </div>
          ) : null}
        </dl>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={() => onSubmit(r, false)}>
            Confirm refund of {formatPrice(r.amountMinorUnits, currency)}
          </Button>
          <Button variant="secondary" onClick={onBack}>
            Back
          </Button>
        </div>
      </Card>
    );
  }

  // editing
  // Partial amounts are typed in a two-decimal currency only (the display
  // helpers assume cents); otherwise only the full remaining amount.
  const partialAllowed = minorUnitDigits(currency) === 2;
  return (
    <Card className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-text-primary">Refund to card</h3>
      {flow.notice ? (
        <p role="alert" className="text-sm text-status-warning">
          {flow.notice}
        </p>
      ) : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-text-primary">Amount</legend>
        <label className="flex min-h-11 items-center gap-2 text-sm text-text-primary">
          <input
            type="radio"
            name={`${id}-mode`}
            checked={draft.mode === "full"}
            onChange={() => onDraft({ ...draft, mode: "full" })}
          />
          Everything that&apos;s left ({max})
        </label>
        {partialAllowed ? (
          <label className="flex min-h-11 items-center gap-2 text-sm text-text-primary">
            <input
              type="radio"
              name={`${id}-mode`}
              checked={draft.mode === "partial"}
              onChange={() => onDraft({ ...draft, mode: "partial" })}
            />
            Part of it
          </label>
        ) : null}
        {draft.mode === "partial" ? (
          <FormField
            label="Amount to refund"
            htmlFor={`${id}-amount`}
            hint={`Up to ${max}`}
            error={errors.amount}
          >
            <input
              id={`${id}-amount`}
              inputMode="decimal"
              autoComplete="off"
              className={`${ADMIN_FIELD_CLASS} sm:max-w-40`}
              value={draft.amountInput}
              onChange={(e) => onDraft({ ...draft, amountInput: e.target.value })}
            />
          </FormField>
        ) : null}
      </fieldset>
      <FormField label="Reason" htmlFor={`${id}-reason`} error={errors.reason}>
        <select
          id={`${id}-reason`}
          className={ADMIN_FIELD_CLASS}
          value={draft.reasonCode}
          onChange={(e) =>
            onDraft({ ...draft, reasonCode: e.target.value as RefundDraft["reasonCode"] })
          }
        >
          <option value="">Choose a reason</option>
          {ORDER_REFUND_REASON_CODES.map((code) => (
            <option key={code} value={code}>
              {ORDER_REFUND_REASON_LABELS[code]}
            </option>
          ))}
        </select>
      </FormField>
      <FormField
        label={draft.reasonCode === "OTHER" ? "Internal note" : "Internal note (optional)"}
        htmlFor={`${id}-note`}
        hint="Only staff who can refund see this. Never shown to the customer."
        error={errors.note}
      >
        <textarea
          id={`${id}-note`}
          rows={2}
          maxLength={ORDER_REFUND_NOTE_MAX_LENGTH}
          className={ADMIN_FIELD_CLASS}
          value={draft.note}
          onChange={(e) => onDraft({ ...draft, note: e.target.value })}
        />
      </FormField>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button onClick={onReview}>Review refund</Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function RefundRow({
  refund,
  orderId,
  locationId,
  flagged,
  manage,
  onChanged,
}: {
  refund: OrderRefundView;
  orderId: string;
  locationId: string;
  flagged: boolean;
  manage: boolean;
  onChanged: () => Promise<void>;
}) {
  const id = useId();
  const status = refundStatusView(refund);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function run(action: () => ReturnType<typeof recheckOrderRefundFromBrowser>, done: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await action();
      if (result.outcome === "success") {
        setReviewing(false);
        setNote("");
        setMessage(done);
        await onChanged();
      } else if (result.outcome === "conflict" || result.outcome === "invalid") {
        setMessage(result.message);
        await onChanged();
      } else if (result.outcome === "forbidden") {
        setMessage("You don't have permission to do this at this location.");
      } else if (result.outcome === "unavailable") {
        setMessage("Refunds aren't available for this order right now.");
      } else {
        // Recheck and review are safe to repeat.
        setMessage(`${result.message} You can try again.`);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-base font-semibold text-text-primary">
            {formatPrice(refund.amountMinorUnits, refund.currency)}
          </span>
          <span className="text-xs text-text-muted">
            {new Date(refund.createdAt).toLocaleString([], {
              dateStyle: "medium",
              timeStyle: "short",
            })}
            {refund.origin === "EXTERNAL"
              ? " · Stripe Dashboard"
              : refund.requestedBy?.displayName
                ? ` · ${refund.requestedBy.displayName}`
                : ""}
            {refund.reasonLabel ? ` · ${refund.reasonLabel}` : ""}
          </span>
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          <StatusBadge tone={status.tone} label={status.label} />
          {flagged ? <StatusBadge tone="warning" label="Needs attention" /> : null}
        </div>
      </div>
      {status.detail ? <p className="text-xs text-text-secondary">{status.detail}</p> : null}
      {flagged ? (
        <p className="text-xs text-status-warning">
          Stripe&apos;s records for this refund don&apos;t match ours. Support has been
          notified; don&apos;t refund again until it&apos;s resolved.
        </p>
      ) : null}
      {refund.note ? (
        <p className="break-words text-xs text-text-secondary">
          <span className="font-medium">Internal note:</span> {refund.note}
        </p>
      ) : null}
      {refund.lateFailureReviewNote ? (
        <p className="break-words text-xs text-text-secondary">
          <span className="font-medium">Review note:</span> {refund.lateFailureReviewNote}
        </p>
      ) : null}

      {manage && canRecheck(refund) ? (
        <Button
          variant="secondary"
          disabled={busy}
          className="sm:self-start"
          onClick={() =>
            void run(
              () => recheckOrderRefundFromBrowser(orderId, refund.id, locationId),
              "Checked with Stripe. The status above is current.",
            )
          }
        >
          {busy ? "Checking…" : "Check status with Stripe"}
        </Button>
      ) : null}

      {manage && needsLateFailureReview(refund) ? (
        reviewing ? (
          <div className="flex flex-col gap-2">
            <FormField
              label="Review note"
              htmlFor={`${id}-review`}
              hint="Required. What you checked about the returned refund. Only staff who can refund see this."
              error={noteError}
            >
              <textarea
                id={`${id}-review`}
                rows={2}
                maxLength={ORDER_REFUND_NOTE_MAX_LENGTH}
                className={ADMIN_FIELD_CLASS}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  setNoteError(null);
                }}
              />
            </FormField>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                disabled={busy}
                onClick={() => {
                  const problem = validateReviewNote(note);
                  if (problem) {
                    setNoteError(problem);
                    return;
                  }
                  void run(
                    () =>
                      reviewOrderRefundFromBrowser(orderId, refund.id, locationId, note.trim()),
                    "Review saved. A new refund can now be made if one is still owed.",
                  );
                }}
              >
                {busy ? "Saving…" : "Save review"}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => setReviewing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" className="sm:self-start" onClick={() => setReviewing(true)}>
            Review returned refund
          </Button>
        )
      ) : null}

      <div role="status" aria-live="polite">
        {message ? <p className="text-xs text-text-primary">{message}</p> : null}
      </div>
    </li>
  );
}
