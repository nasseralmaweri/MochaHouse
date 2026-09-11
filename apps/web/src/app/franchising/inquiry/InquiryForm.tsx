"use client";

import { useState } from "react";
import Link from "next/link";
import {
  FRANCHISE_INQUIRY_MESSAGE_MAX_LENGTH,
  FRANCHISE_INQUIRY_NAME_MAX_LENGTH,
  FRANCHISE_INQUIRY_SHORT_MAX_LENGTH,
} from "@mocha-house/contracts";
import { submitFranchiseInquiryFromBrowser } from "@/lib/api-client";
import { Card } from "@/components/Card";

const inputClass =
  "rounded-xl border border-border-default bg-surface-card px-4 py-3 text-base text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const primaryButtonClass =
  "flex min-h-11 items-center justify-center rounded-xl bg-status-success/10 px-4 py-3 text-base font-semibold text-status-success disabled:bg-surface-subtle disabled:text-text-muted";

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-text-primary">
        {label}
      </label>
      {hint ? <p className="text-xs text-text-muted">{hint}</p> : null}
      {children}
    </div>
  );
}

// Milestone 8D — the public franchise inquiry form. Anonymous; posts
// through the same-origin proxy (which forwards to the API, the sole
// authority). investmentRange / timeframe are plain free text — no invented
// dropdown buckets. Consent wording is fixed and not editable here.
export function InquiryForm() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [country, setCountry] = useState("");
  const [preferredMarket, setPreferredMarket] = useState("");
  const [investmentRange, setInvestmentRange] = useState("");
  const [timeframe, setTimeframe] = useState("");
  const [businessExperience, setBusinessExperience] = useState("");
  const [message, setMessage] = useState("");
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!consent) {
      setError(
        "Please agree that Mocha House may contact you regarding this inquiry.",
      );
      return;
    }

    setPending(true);
    const result = await submitFranchiseInquiryFromBrowser({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      phone: phone.trim(),
      city: city.trim(),
      state: state.trim(),
      country: country.trim(),
      preferredMarket: preferredMarket.trim(),
      investmentRange: investmentRange.trim() === "" ? null : investmentRange.trim(),
      timeframe: timeframe.trim() === "" ? null : timeframe.trim(),
      businessExperience:
        businessExperience.trim() === "" ? null : businessExperience.trim(),
      message: message.trim() === "" ? null : message.trim(),
      consentAcknowledged: consent,
    });
    setPending(false);

    if (result.outcome === "success") {
      setSubmitted(true);
      return;
    }
    if (result.outcome === "throttled") {
      setError(result.message);
      return;
    }
    setError(
      "message" in result
        ? result.message
        : "Something went wrong. Please try again.",
    );
  }

  if (submitted) {
    return (
      <Card className="flex flex-col gap-2">
        <p className="text-base font-semibold text-text-primary">
          Thanks — we&apos;ve received your inquiry.
        </p>
        <p className="text-sm text-text-secondary">
          Our team reviews every franchise inquiry. If it looks like a fit,
          we&apos;ll reach out using the contact details you provided.
        </p>
        <Link
          href="/franchising"
          className="text-sm text-text-muted underline underline-offset-2"
        >
          Back to Franchising
        </Link>
      </Card>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" htmlFor="inquiry-first">
          <input
            id="inquiry-first"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            required
            maxLength={FRANCHISE_INQUIRY_NAME_MAX_LENGTH}
            className={inputClass}
          />
        </Field>
        <Field label="Last name" htmlFor="inquiry-last">
          <input
            id="inquiry-last"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            required
            maxLength={FRANCHISE_INQUIRY_NAME_MAX_LENGTH}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email" htmlFor="inquiry-email">
          <input
            id="inquiry-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            maxLength={FRANCHISE_INQUIRY_SHORT_MAX_LENGTH}
            className={inputClass}
          />
        </Field>
        <Field label="Phone" htmlFor="inquiry-phone">
          <input
            id="inquiry-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
            maxLength={FRANCHISE_INQUIRY_SHORT_MAX_LENGTH}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="City" htmlFor="inquiry-city">
          <input
            id="inquiry-city"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            required
            maxLength={FRANCHISE_INQUIRY_SHORT_MAX_LENGTH}
            className={inputClass}
          />
        </Field>
        <Field label="State / Region" htmlFor="inquiry-state">
          <input
            id="inquiry-state"
            value={state}
            onChange={(e) => setState(e.target.value)}
            required
            maxLength={FRANCHISE_INQUIRY_SHORT_MAX_LENGTH}
            className={inputClass}
          />
        </Field>
        <Field label="Country" htmlFor="inquiry-country">
          <input
            id="inquiry-country"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            required
            maxLength={FRANCHISE_INQUIRY_SHORT_MAX_LENGTH}
            className={inputClass}
          />
        </Field>
      </div>

      <Field
        label="Preferred market / area of interest"
        htmlFor="inquiry-market"
        hint="Where would you like to open a Mocha House? A city, region, or general area is fine."
      >
        <input
          id="inquiry-market"
          value={preferredMarket}
          onChange={(e) => setPreferredMarket(e.target.value)}
          required
          maxLength={FRANCHISE_INQUIRY_SHORT_MAX_LENGTH}
          className={inputClass}
        />
      </Field>

      <Field
        label="Investment range (optional)"
        htmlFor="inquiry-investment"
        hint="In your own words — no specific figures required."
      >
        <input
          id="inquiry-investment"
          value={investmentRange}
          onChange={(e) => setInvestmentRange(e.target.value)}
          maxLength={FRANCHISE_INQUIRY_SHORT_MAX_LENGTH}
          className={inputClass}
        />
      </Field>

      <Field
        label="Timeframe (optional)"
        htmlFor="inquiry-timeframe"
        hint="When are you hoping to open a location?"
      >
        <input
          id="inquiry-timeframe"
          value={timeframe}
          onChange={(e) => setTimeframe(e.target.value)}
          maxLength={FRANCHISE_INQUIRY_SHORT_MAX_LENGTH}
          className={inputClass}
        />
      </Field>

      <Field
        label="Business experience (optional)"
        htmlFor="inquiry-experience"
      >
        <textarea
          id="inquiry-experience"
          value={businessExperience}
          onChange={(e) => setBusinessExperience(e.target.value)}
          rows={3}
          maxLength={FRANCHISE_INQUIRY_MESSAGE_MAX_LENGTH}
          className={`${inputClass} resize-y`}
        />
      </Field>

      <Field label="Additional information (optional)" htmlFor="inquiry-message">
        <textarea
          id="inquiry-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          maxLength={FRANCHISE_INQUIRY_MESSAGE_MAX_LENGTH}
          className={`${inputClass} resize-y`}
        />
      </Field>

      <label className="flex items-start gap-2 text-sm text-text-primary">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5"
          required
        />
        <span>
          I agree that Mocha House may contact me regarding this franchise
          inquiry.
        </span>
      </label>

      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}

      <button type="submit" disabled={pending} className={primaryButtonClass}>
        {pending ? "Submitting…" : "Submit inquiry"}
      </button>
    </form>
  );
}
