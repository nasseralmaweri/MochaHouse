"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { correctGiftCardBalanceFromBrowser } from "@/lib/api-client";
import {
  canSubmitCorrection,
  correctionStepAfter,
  correctionWouldBeOutOfRange,
  prepareCorrection,
  type CorrectionDirection,
  type CorrectionFormValues,
} from "@/lib/admin/gift-cards";
import { formatPrice } from "@/lib/money";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";

// The HQ authorized manual balance correction (Milestone 7F). Rendered only
// for `giftcards.manage`. The API is the authority — it enforces the
// required reason, the operationKey idempotency and the [0, $2,000.00]
// bounds; this island collects input, warns early, and surfaces the result.
// `operationKey` is minted once per attempt and REUSED across a retry of
// the same submission (a lost response may still have been applied), then
// rotated after a success. SC0.5d — when the API reports the key is already
// spent on a DIFFERENT correction (409 GIFT_CARD_OPERATION_KEY_CONFLICT) the
// key is rotated too, the inputs are kept, the card is refreshed, and the
// operator must confirm they reviewed the refreshed balance and ledger
// before submitting again. Nothing is ever resubmitted automatically (see
// correctionStepAfter).
export function GiftCardCorrectionForm({
  giftCardId,
  currentBalanceMinorUnits,
  currency,
}: {
  giftCardId: string;
  currentBalanceMinorUnits: number;
  currency: string;
}) {
  const router = useRouter();
  const [direction, setDirection] = useState<CorrectionDirection>("add");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [operationKey, setOperationKey] = useState(() =>
    globalThis.crypto.randomUUID(),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  // True until router.refresh() has delivered the refreshed balance and
  // ledger, so a review can never be confirmed against stale figures.
  const [refreshing, startRefresh] = useTransition();
  // One request at a time, even if two clicks land before a re-render.
  const inFlight = useRef(false);
  const reviewCheckbox = useRef<HTMLInputElement>(null);

  const values: CorrectionFormValues = { direction, amount, reason };
  const canSubmit = canSubmitCorrection({
    pending,
    reviewRequired,
    reviewed,
    refreshing,
  });
  // What submitting now would apply, restated in the review box.
  const preview = prepareCorrection(values, operationKey);

  // After a key conflict, take keyboard focus to the review confirmation
  // once the refreshed figures are in (the Apply button the operator was on
  // is disabled, which would otherwise drop focus to the page).
  useEffect(() => {
    if (reviewRequired && !refreshing) {
      reviewCheckbox.current?.focus();
    }
  }, [reviewRequired, refreshing]);

  async function submit() {
    if (!canSubmit || inFlight.current) {
      return;
    }
    setError(null);
    setNotice(null);

    const prepared = prepareCorrection(values, operationKey);
    if (!prepared.ok) {
      setError(prepared.error);
      return;
    }
    if (
      correctionWouldBeOutOfRange(
        currentBalanceMinorUnits,
        prepared.value.deltaMinorUnits,
      )
    ) {
      setError(
        `That correction would take the balance outside $0.00–$2,000.00 (current balance ${formatPrice(
          currentBalanceMinorUnits,
          currency,
        )}).`,
      );
      return;
    }

    inFlight.current = true;
    setPending(true);
    const result = await correctGiftCardBalanceFromBrowser(
      giftCardId,
      prepared.value,
    );
    setPending(false);
    inFlight.current = false;

    const step = correctionStepAfter(result, operationKey, () =>
      globalThis.crypto.randomUUID(),
    );
    setOperationKey(step.operationKey);
    setError(step.error);
    setNotice(step.notice);
    setReviewRequired(step.reviewRequired);
    setReviewed(false);
    if (step.clearInputs) {
      setAmount("");
      setReason("");
    }
    if (step.refresh) {
      startRefresh(() => router.refresh());
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border-default bg-surface-subtle px-4 py-4">
      <p className="text-sm font-semibold text-text-primary">
        Correct the balance
      </p>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-text-primary">
          Direction
        </legend>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="radio"
            name="gc-direction"
            checked={direction === "add"}
            onChange={() => {
              setDirection("add");
              setError(null);
            }}
          />
          Add value
        </label>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="radio"
            name="gc-direction"
            checked={direction === "deduct"}
            onChange={() => {
              setDirection("deduct");
              setError(null);
            }}
          />
          Deduct value
        </label>
      </fieldset>

      <FormField label="Amount" htmlFor="gc-correction-amount">
        <input
          id="gc-correction-amount"
          inputMode="decimal"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
            setError(null);
          }}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>

      <FormField
        label="Reason"
        htmlFor="gc-correction-reason"
        hint="Recorded in the gift-card ledger and the internal audit log."
      >
        <textarea
          id="gc-correction-reason"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setError(null);
          }}
          rows={2}
          className={ADMIN_FIELD_CLASS}
        />
      </FormField>

      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-status-success">
          {notice}
        </p>
      ) : null}

      {reviewRequired ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border-default bg-surface-card px-3 py-3">
          {refreshing ? (
            <p role="status" className="text-sm text-text-muted">
              Refreshing the gift card balance and ledger…
            </p>
          ) : (
            <>
              <p role="status" className="text-sm text-text-primary">
                Current balance:{" "}
                <span className="font-semibold">
                  {formatPrice(currentBalanceMinorUnits, currency)}
                </span>
                . A correction may already have been applied — check the
                ledger below before applying another.
              </p>
              {preview.ok ? (
                <p className="text-sm text-text-primary">
                  Applying now would{" "}
                  {preview.value.deltaMinorUnits < 0 ? "deduct" : "add"}{" "}
                  <span className="font-semibold">
                    {formatPrice(
                      Math.abs(preview.value.deltaMinorUnits),
                      currency,
                    )}
                  </span>
                  , making the balance{" "}
                  <span className="font-semibold">
                    {formatPrice(
                      currentBalanceMinorUnits + preview.value.deltaMinorUnits,
                      currency,
                    )}
                  </span>
                  .
                </p>
              ) : null}
            </>
          )}
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input
              ref={reviewCheckbox}
              type="checkbox"
              checked={reviewed}
              disabled={refreshing}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            I checked the ledger: this correction is not already there, and I
            still want to apply it
          </label>
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <div>
          <Button
            onClick={() => void submit()}
            disabled={!canSubmit}
            aria-describedby={
              reviewRequired && !reviewed ? "gc-correction-blocked" : undefined
            }
          >
            {pending ? "Working…" : "Apply correction"}
          </Button>
        </div>
        {reviewRequired && !reviewed ? (
          <p id="gc-correction-blocked" className="text-sm text-text-muted">
            Confirm the ledger check above to enable Apply correction.
          </p>
        ) : null}
      </div>
    </div>
  );
}
