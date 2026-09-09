"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GiftCardBalanceResponse,
  GiftCardPublicStatus,
  GiftCardPurchaseOptions,
  PurchaseGiftCardResponse,
} from "@mocha-house/contracts";
import { Card } from "@/components/Card";
import {
  CODE_RETRIEVAL_NOTICE,
  formatMinorUnits,
  groupGiftCardCode,
  isPurchasableAmount,
  maskedGiftCardLabel,
  normalizeBalanceCode,
  parseCustomAmount,
} from "@/lib/gift-cards/purchase";

const inputClass =
  "rounded-xl border border-border-default bg-surface-card px-4 py-3 text-base text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const primaryButtonClass =
  "flex min-h-11 items-center justify-center rounded-xl bg-status-success/10 px-4 py-3 text-base font-semibold text-status-success disabled:bg-surface-subtle disabled:text-text-muted";

const BALANCE_STATUS_LABEL: Record<GiftCardPublicStatus, string> = {
  active: "Active",
  depleted: "No balance remaining",
  inactive: "Not currently usable",
};

export function GiftCardsClient() {
  const [options, setOptions] = useState<GiftCardPurchaseOptions | null>(null);
  const [optionsError, setOptionsError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/gift-cards/options", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error())))
      .then((data: GiftCardPurchaseOptions) => {
        if (!cancelled) setOptions(data);
      })
      .catch(() => {
        if (!cancelled) setOptionsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-text-primary">
          Buy a gift card
        </h2>
        {optionsError ? (
          <Card tone="subtle" className="text-sm text-status-warning">
            We couldn&apos;t load gift-card options. Please refresh and try again.
          </Card>
        ) : options ? (
          <PurchasePanel options={options} />
        ) : (
          <p className="text-sm text-text-muted">Loading…</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-text-primary">
          Check a balance
        </h2>
        <BalancePanel />
      </section>
    </div>
  );
}

// --- Buy -------------------------------------------------------------

function PurchasePanel({ options }: { options: GiftCardPurchaseOptions }) {
  const [selectedPreset, setSelectedPreset] = useState<number | null>(
    options.presetAmountsMinorUnits[0] ?? null,
  );
  const [customEntry, setCustomEntry] = useState("");
  const [useCustom, setUseCustom] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<PurchaseGiftCardResponse | null>(null);

  // Held across retries so a lost success response can be recovered by
  // replaying the SAME idempotency key (never stored anywhere but memory).
  const idempotencyKeyRef = useRef<string | null>(null);

  const resolveAmount = useCallback((): number | null => {
    if (useCustom) {
      const parsed = parseCustomAmount(customEntry, options);
      if (!parsed.ok) {
        setError(parsed.error);
        return null;
      }
      return parsed.minorUnits;
    }
    return selectedPreset;
  }, [useCustom, customEntry, options, selectedPreset]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const amountMinorUnits = resolveAmount();
    if (amountMinorUnits === null) {
      return;
    }
    if (!isPurchasableAmount(amountMinorUnits, options)) {
      setError("Choose one of the amounts shown.");
      return;
    }
    if (!email.includes("@")) {
      setError("Enter the email address for your receipt.");
      return;
    }

    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }

    setPending(true);
    try {
      const res = await fetch("/api/gift-cards/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: idempotencyKeyRef.current,
          amountMinorUnits,
          purchaserEmail: email.trim(),
          purchaserName: name.trim() === "" ? null : name.trim(),
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | (PurchaseGiftCardResponse & { message?: string })
        | { message?: string; outcome?: string }
        | null;

      if (res.ok && data && "purchaseId" in data) {
        setResult(data);
        return;
      }
      if (res.status === 402) {
        setError(
          "Your payment couldn't be completed. No charge was made — please try a different card.",
        );
        // A declined payment is terminal for this key; start fresh next time.
        idempotencyKeyRef.current = null;
        return;
      }
      if (res.status === 409) {
        setError(
          data && "message" in data && data.message
            ? data.message
            : "Something went wrong finishing your purchase. Please contact support before trying again.",
        );
        return;
      }
      setError(
        (data && "message" in data && data.message) ||
          "We couldn't complete your purchase. Please try again.",
      );
    } catch {
      setError(
        "We couldn't reach the server. If you were charged, reload this page to retrieve your code.",
      );
    } finally {
      setPending(false);
    }
  }

  if (result) {
    return <PurchaseSuccess result={result} />;
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm text-text-secondary">Amount</legend>
        <div className="flex flex-wrap gap-2">
          {options.presetAmountsMinorUnits.map((amount) => (
            <button
              type="button"
              key={amount}
              onClick={() => {
                setSelectedPreset(amount);
                setUseCustom(false);
                setError(null);
              }}
              aria-pressed={!useCustom && selectedPreset === amount}
              className={`rounded-xl border px-4 py-2 text-base ${
                !useCustom && selectedPreset === amount
                  ? "border-status-success bg-status-success/10 font-semibold text-status-success"
                  : "border-border-default text-text-primary"
              }`}
            >
              {formatMinorUnits(amount)}
            </button>
          ))}
        </div>

        {options.customAmountEnabled ? (
          <label className="mt-1 flex flex-col gap-1 text-sm text-text-secondary">
            <span className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={useCustom}
                onChange={(e) => {
                  setUseCustom(e.target.checked);
                  setError(null);
                }}
              />
              Enter a custom amount ({formatMinorUnits(
                options.customAmountMinMinorUnits,
              )}
              {" – "}
              {formatMinorUnits(options.customAmountMaxMinorUnits)})
            </span>
            {useCustom ? (
              <input
                inputMode="decimal"
                value={customEntry}
                onChange={(e) => setCustomEntry(e.target.value)}
                placeholder="25.00"
                aria-label="Custom gift-card amount in dollars"
                className={inputClass}
              />
            ) : null}
          </label>
        ) : null}
      </fieldset>

      <label className="flex flex-col gap-1 text-sm text-text-secondary">
        Email for your receipt
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          className={inputClass}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm text-text-secondary">
        Your name (optional)
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          className={inputClass}
        />
      </label>

      {error ? (
        <Card tone="subtle" className="text-sm text-status-warning">
          {error}
        </Card>
      ) : null}

      <button type="submit" disabled={pending} className={primaryButtonClass}>
        {pending ? "Processing…" : "Pay and get my code"}
      </button>
      <p className="text-xs text-text-muted">
        The gift card is issued to you on the next screen. This is a
        self-purchase — we don&apos;t send it to anyone else.
      </p>
    </form>
  );
}

function PurchaseSuccess({ result }: { result: PurchaseGiftCardResponse }) {
  const [copied, setCopied] = useState(false);

  return (
    <Card className="flex flex-col gap-3">
      <p className="text-base font-semibold text-status-success">
        Gift card issued — {formatMinorUnits(result.amountMinorUnits)}
      </p>

      {result.code ? (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-sm text-text-secondary">Your gift-card code</span>
            <code className="select-all rounded-lg bg-surface-subtle px-3 py-2 text-lg tracking-widest text-text-primary">
              {groupGiftCardCode(result.code)}
            </code>
          </div>
          <button
            type="button"
            className="self-start rounded-lg border border-border-default px-3 py-2 text-sm text-text-primary"
            onClick={() => {
              navigator.clipboard
                ?.writeText(groupGiftCardCode(result.code!))
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? "Copied" : "Copy code"}
          </button>
          <Card tone="subtle" className="text-sm text-text-secondary">
            {CODE_RETRIEVAL_NOTICE}
          </Card>
        </>
      ) : (
        <Card tone="subtle" className="text-sm text-text-secondary">
          This confirmation is for gift card {maskedGiftCardLabel(result.last4)}.
          The full code is no longer retrievable. If you never saved it, contact
          support with reference {result.purchaseId}.
        </Card>
      )}

      <div className="flex items-center justify-between text-sm text-text-secondary">
        <span>Card</span>
        <span className="text-text-primary">
          {maskedGiftCardLabel(result.last4)}
        </span>
      </div>
    </Card>
  );
}

// --- Check a balance ----------------------------------------------

function BalancePanel() {
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<GiftCardBalanceResponse | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setOutcome(null);

    const normalized = normalizeBalanceCode(code);
    if (normalized === null) {
      setError("Enter your gift-card code.");
      return;
    }

    setPending(true);
    try {
      const res = await fetch("/api/gift-cards/balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: normalized }),
      });
      if (!res.ok) {
        setError("We couldn't check that balance right now. Please try again.");
        return;
      }
      setOutcome((await res.json()) as GiftCardBalanceResponse);
    } catch {
      setError("We couldn't reach the server. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm text-text-secondary">
        Gift-card code
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="XXXX XXXX XXXX XXXX"
          autoComplete="off"
          className={inputClass}
        />
      </label>

      {error ? (
        <Card tone="subtle" className="text-sm text-status-warning">
          {error}
        </Card>
      ) : null}

      <button type="submit" disabled={pending} className={primaryButtonClass}>
        {pending ? "Checking…" : "Check balance"}
      </button>

      {outcome && !outcome.found ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          We couldn&apos;t find a gift card with that code. Check the code and try
          again.
        </Card>
      ) : null}

      {outcome && outcome.found ? (
        <Card className="flex flex-col gap-2 text-sm">
          <div className="flex items-center justify-between text-text-secondary">
            <span>Card</span>
            <span className="text-text-primary">
              {outcome.maskedCode ?? maskedGiftCardLabel(outcome.last4 ?? "")}
            </span>
          </div>
          <div className="flex items-center justify-between text-text-secondary">
            <span>Balance</span>
            <span className="text-lg font-semibold text-text-primary">
              {formatMinorUnits(outcome.balanceMinorUnits ?? 0)}
            </span>
          </div>
          <div className="flex items-center justify-between text-text-secondary">
            <span>Status</span>
            <span className="text-text-primary">
              {outcome.status
                ? BALANCE_STATUS_LABEL[outcome.status]
                : "Unknown"}
            </span>
          </div>
        </Card>
      ) : null}
    </form>
  );
}
