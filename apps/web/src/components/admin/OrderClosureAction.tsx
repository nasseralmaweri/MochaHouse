"use client";

import { useId, useRef, useState } from "react";
import type { OrderStatus } from "@mocha-house/contracts";
import {
  ORDER_CLOSURE_NOTE_MAX_LENGTH,
  ORDER_CLOSURE_REASON_LABELS,
} from "@mocha-house/contracts";
import {
  EMPTY_CLOSURE_DRAFT,
  buildClosureRequest,
  closeStoreOrderFromBrowser,
  closureActionFor,
  closureExplanation,
  closureFlowAfter,
  closureOutcomeMessage,
  type ClosureDraft,
  type ClosureDraftErrors,
  type ClosureFlow,
  type ClosureRequest,
} from "@/lib/admin/order-closure";
import { Card } from "@/components/Card";
import { Button } from "@/components/admin/Button";
import { ADMIN_FIELD_CLASS, FormField } from "@/components/admin/form";

// V1 launch fix 1 — "Reject order" (RECEIVED) / "Cancel order" (ACCEPTED,
// PREPARING, READY) inside Order Details, on the existing R1/S5b API. Shown
// only to staff with `orders.cancel` at this location (the API checks it
// again). Closing never refunds a card: the card amount becomes a refund
// owed, processed separately in Card refunds.
export function OrderClosureAction({
  orderId,
  locationId,
  status,
  onChanged,
}: {
  orderId: string;
  locationId: string;
  status: OrderStatus;
  // Reload the order (status, closure summary, refunds).
  onChanged: () => Promise<void>;
}) {
  const id = useId();
  const action = closureActionFor(status);
  const [flow, setFlow] = useState<ClosureFlow>({ step: "closed-form", notice: null });
  const [draft, setDraft] = useState<ClosureDraft>(EMPTY_CLOSURE_DRAFT);
  const [errors, setErrors] = useState<ClosureDraftErrors>({});
  // The kind of the last confirmed request (for the outcome wording).
  const [doneKind, setDoneKind] = useState<ClosureRequest["kind"] | null>(null);
  // A second click in the same tick is refused before React re-renders.
  const sending = useRef(false);

  async function send(request: ClosureRequest) {
    if (sending.current) return;
    sending.current = true;
    setFlow({ step: "submitting", request });
    try {
      const result = await closeStoreOrderFromBrowser(orderId, request);
      const next = closureFlowAfter(request, result);
      if (next.flow.step === "done") {
        setDoneKind(request.kind);
        setDraft(EMPTY_CLOSURE_DRAFT);
      }
      setFlow(next.flow);
      if (next.reload) await onChanged();
    } finally {
      sending.current = false;
    }
  }

  // After closing, the order is terminal: only the outcome remains.
  if (flow.step === "done") {
    return (
      <div role="status" aria-live="polite">
        <Card tone="subtle" className="text-sm text-text-primary">
          {closureOutcomeMessage(doneKind ?? "CANCELLED", flow.replayed)}
        </Card>
      </div>
    );
  }

  // A request with no definite answer (or a busy order): only the SAME
  // request may be sent again — the API never closes an order twice.
  if (flow.step === "submitting" || flow.step === "retry") {
    const busy = flow.step === "submitting";
    const verb = flow.request.kind === "REJECTED" ? "Rejecting" : "Cancelling";
    return (
      <Card className="flex flex-col gap-3">
        <div role="status" aria-live="polite" className="flex flex-col gap-1 text-sm">
          {busy ? (
            <p className="text-text-primary">{verb} the order…</p>
          ) : (
            <>
              <p className="font-medium text-status-warning">
                We couldn&apos;t confirm that the order was closed.
              </p>
              <p className="text-text-secondary">{flow.message}</p>
            </>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button disabled={busy} onClick={() => void send(flow.request)}>
            {busy ? "Working…" : "Try again"}
          </Button>
          {busy ? null : (
            <Button
              variant="secondary"
              onClick={() => {
                setFlow({ step: "closed-form", notice: null });
                void onChanged();
              }}
            >
              Check the order instead
            </Button>
          )}
        </div>
      </Card>
    );
  }

  if (!action) {
    // A terminal order (or one that just moved on): any notice only.
    return flow.notice ? (
      <div role="status" aria-live="polite">
        <Card tone="subtle" className="text-sm text-status-warning">
          {flow.notice}
        </Card>
      </div>
    ) : null;
  }

  // The order moved on while the form was open: withdraw it rather than
  // switching silently to another action.
  const shown: ClosureFlow =
    flow.step === "form" && flow.openedFor !== undefined && flow.openedFor !== status
      ? {
          step: "closed-form",
          notice: "This order changed while the form was open. Check its current status.",
        }
      : flow;

  if (shown.step === "closed-form") {
    return (
      <div className="flex flex-col gap-2">
        <div role="status" aria-live="polite">
          {shown.notice ? (
            <Card tone="subtle" className="text-sm text-status-warning">
              {shown.notice}
            </Card>
          ) : null}
        </div>
        <Button
          variant="secondary"
          className="sm:self-start"
          onClick={() => {
            setErrors({});
            setFlow({ step: "form", notice: null, openedFor: status });
          }}
        >
          {action.label}
        </Button>
      </div>
    );
  }

  // The confirmation form.
  const heading = action.kind === "REJECTED" ? "Reject this order?" : "Cancel this order?";
  return (
    <Card className="flex flex-col gap-4">
      <h2 id={`${id}-heading`} className="text-base font-semibold text-text-primary">
        {heading}
      </h2>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-text-secondary">
        {closureExplanation(action.kind).map((line, index) => (
          <li key={index} className={index === 2 ? "font-medium text-text-primary" : undefined}>
            {line}
          </li>
        ))}
      </ul>
      {shown.step === "form" && shown.notice ? (
        <p role="alert" className="text-sm text-status-warning">
          {shown.notice}
        </p>
      ) : null}
      <FormField label="Reason" htmlFor={`${id}-reason`} error={errors.reason}>
        <select
          id={`${id}-reason`}
          className={`${ADMIN_FIELD_CLASS} min-h-11`}
          value={draft.reasonCode}
          onChange={(e) => {
            setDraft({ ...draft, reasonCode: e.target.value as ClosureDraft["reasonCode"] });
            setErrors({});
          }}
        >
          <option value="">Choose a reason</option>
          {action.reasons.map((code) => (
            <option key={code} value={code}>
              {ORDER_CLOSURE_REASON_LABELS[code]}
            </option>
          ))}
        </select>
      </FormField>
      <FormField
        label={draft.reasonCode === "OTHER" ? "Internal note" : "Internal note (optional)"}
        htmlFor={`${id}-note`}
        hint="Only staff see this. Never shown to the customer."
        error={errors.note}
      >
        <textarea
          id={`${id}-note`}
          rows={2}
          maxLength={ORDER_CLOSURE_NOTE_MAX_LENGTH}
          className={ADMIN_FIELD_CLASS}
          value={draft.note}
          onChange={(e) => {
            setDraft({ ...draft, note: e.target.value });
            setErrors({});
          }}
        />
      </FormField>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          onClick={() => {
            const built = buildClosureRequest(action, draft, { locationId, status });
            if (!built.ok) {
              setErrors(built.errors);
              return;
            }
            void send(built.request);
          }}
        >
          {action.kind === "REJECTED" ? "Confirm rejection" : "Confirm cancellation"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setDraft(EMPTY_CLOSURE_DRAFT);
            setErrors({});
            setFlow({ step: "closed-form", notice: null });
          }}
        >
          Back
        </Button>
      </div>
    </Card>
  );
}
