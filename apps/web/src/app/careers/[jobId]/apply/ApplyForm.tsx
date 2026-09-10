"use client";

import { useState } from "react";
import Link from "next/link";
import {
  JOB_APPLICATION_MESSAGE_MAX_LENGTH,
  JOB_APPLICATION_NAME_MAX_LENGTH,
  JOB_APPLICATION_SHORT_MAX_LENGTH,
  JOB_APPLICATION_URL_MAX_LENGTH,
} from "@mocha-house/contracts";
import { submitJobApplicationFromBrowser } from "@/lib/api-client";
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

// Milestone 8C — the public application form. Anonymous; posts through the
// same-origin proxy (which forwards to the API, the sole authority). No file
// upload — "Resume / LinkedIn / Portfolio Link" is one optional http(s) URL.
// On success the form is replaced by a plain confirmation; no application id
// is ever shown.
export function ApplyForm({
  jobId,
  jobTitle,
}: {
  jobId: string;
  jobTitle: string;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [location, setLocation] = useState("");
  const [workAuthorized, setWorkAuthorized] = useState<"" | "yes" | "no">("");
  const [availability, setAvailability] = useState("");
  const [message, setMessage] = useState("");
  const [resumeUrl, setResumeUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (workAuthorized === "") {
      setError(
        "Please answer whether you are legally authorized to work in the U.S.",
      );
      return;
    }

    setPending(true);
    const result = await submitJobApplicationFromBrowser(jobId, {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      phone: phone.trim(),
      location: location.trim(),
      workAuthorized: workAuthorized === "yes",
      availability: availability.trim(),
      message: message.trim(),
      resumeUrl: resumeUrl.trim() === "" ? null : resumeUrl.trim(),
    });
    setPending(false);

    if (result.outcome === "success") {
      setSubmitted(true);
      return;
    }
    if (result.outcome === "not-found") {
      setError(
        "This position is no longer accepting applications. Please check our other open positions.",
      );
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
          Thanks — we&apos;ve received your application.
        </p>
        <p className="text-sm text-text-secondary">
          Our team reviews every application. If your experience is a match,
          we&apos;ll reach out using the contact details you provided.
        </p>
        <Link
          href="/careers"
          className="text-sm text-text-muted underline underline-offset-2"
        >
          Back to all open positions
        </Link>
      </Card>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-sm text-text-secondary">
        Applying for <span className="font-medium text-text-primary">{jobTitle}</span>.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" htmlFor="apply-first">
          <input
            id="apply-first"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            required
            maxLength={JOB_APPLICATION_NAME_MAX_LENGTH}
            className={inputClass}
          />
        </Field>
        <Field label="Last name" htmlFor="apply-last">
          <input
            id="apply-last"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            required
            maxLength={JOB_APPLICATION_NAME_MAX_LENGTH}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email" htmlFor="apply-email">
          <input
            id="apply-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            maxLength={JOB_APPLICATION_SHORT_MAX_LENGTH}
            className={inputClass}
          />
        </Field>
        <Field label="Phone" htmlFor="apply-phone">
          <input
            id="apply-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
            maxLength={JOB_APPLICATION_SHORT_MAX_LENGTH}
            className={inputClass}
          />
        </Field>
      </div>

      <Field
        label="City, State"
        htmlFor="apply-location"
        hint="Where are you based? For example, “Dearborn, MI”."
      >
        <input
          id="apply-location"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          required
          maxLength={JOB_APPLICATION_SHORT_MAX_LENGTH}
          className={inputClass}
        />
      </Field>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-text-primary">
          Are you legally authorized to work in the U.S.?
        </legend>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="radio"
            name="apply-work-auth"
            checked={workAuthorized === "yes"}
            onChange={() => setWorkAuthorized("yes")}
          />
          Yes
        </label>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="radio"
            name="apply-work-auth"
            checked={workAuthorized === "no"}
            onChange={() => setWorkAuthorized("no")}
          />
          No
        </label>
      </fieldset>

      <Field
        label="Availability"
        htmlFor="apply-availability"
        hint="When can you start, and what hours or shifts work for you?"
      >
        <input
          id="apply-availability"
          value={availability}
          onChange={(e) => setAvailability(e.target.value)}
          required
          maxLength={JOB_APPLICATION_SHORT_MAX_LENGTH}
          className={inputClass}
        />
      </Field>

      <Field
        label="Why are you interested in this position?"
        htmlFor="apply-message"
      >
        <textarea
          id="apply-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          required
          rows={5}
          maxLength={JOB_APPLICATION_MESSAGE_MAX_LENGTH}
          className={`${inputClass} resize-y`}
        />
      </Field>

      <Field
        label="Resume / LinkedIn / Portfolio Link (optional)"
        htmlFor="apply-resume"
        hint="A single link starting with http:// or https://. We can’t accept file uploads here."
      >
        <input
          id="apply-resume"
          type="url"
          inputMode="url"
          value={resumeUrl}
          onChange={(e) => setResumeUrl(e.target.value)}
          maxLength={JOB_APPLICATION_URL_MAX_LENGTH}
          placeholder="https://"
          className={inputClass}
        />
      </Field>

      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}

      <button type="submit" disabled={pending} className={primaryButtonClass}>
        {pending ? "Submitting…" : "Submit application"}
      </button>
    </form>
  );
}
