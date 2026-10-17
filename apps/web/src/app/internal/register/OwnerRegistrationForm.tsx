"use client";

import Link from "next/link";
import { useActionState } from "react";
import { ownerRegistrationAction } from "@/lib/internal-auth/registration-actions";
import { INITIAL_REGISTRATION_STATE } from "@/lib/internal-auth/registration-state";

const inputClassName =
  "min-h-11 rounded-lg border border-border-default bg-surface-card px-3.5 py-2.5 text-base text-text-primary transition-colors hover:border-text-muted/50 focus-visible:border-focus focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus";
const labelClassName =
  "flex flex-col gap-1.5 text-sm font-medium text-text-primary";
const primaryButtonClassName =
  "flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-base font-semibold text-accent-contrast transition-opacity hover:opacity-90 disabled:bg-surface-subtle disabled:text-text-muted";
const linkButtonClassName =
  "text-sm font-medium text-text-secondary underline underline-offset-4 hover:text-text-primary disabled:text-text-muted";

function DocumentName({ name, url }: { name: string; url: string | null }) {
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-4"
    >
      {name}
    </a>
  ) : (
    <>{name}</>
  );
}

export function OwnerRegistrationForm(props: {
  termsVersion: string;
  privacyVersion: string;
  termsUrl: string | null;
  privacyUrl: string | null;
}) {
  const [state, formAction, pending] = useActionState(
    ownerRegistrationAction,
    INITIAL_REGISTRATION_STATE,
  );

  if (state.step === "done") {
    return (
      <div className="flex flex-col gap-3" role="status">
        <h2 className="text-lg font-semibold text-text-primary">
          Your owner account is ready
        </h2>
        <p className="text-[0.9375rem] text-text-secondary">
          Your email is verified and your password is set. Next, sign in to
          set up your business.
        </p>
        <Link
          href="/internal/sign-in"
          className="flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-base font-semibold text-accent-contrast transition-opacity hover:opacity-90"
        >
          Sign in
        </Link>
      </div>
    );
  }

  const error = state.error ? (
    <p
      role="alert"
      className="rounded-lg bg-status-error/10 px-3 py-2 text-sm text-status-error"
    >
      {state.error}
    </p>
  ) : null;

  if (state.step === "email") {
    return (
      <form action={formAction} className="flex flex-col gap-5">
        <input type="hidden" name="intent" value="start" />
        <label className={labelClassName}>
          Email
          <input
            required
            type="email"
            name="email"
            autoComplete="email"
            defaultValue={state.email}
            className={inputClassName}
          />
        </label>
        {error}
        <button type="submit" disabled={pending} className={primaryButtonClassName}>
          {pending ? "Sending…" : "Send verification code"}
        </button>
        <p className="text-sm text-text-secondary">
          Already have an account?{" "}
          <Link href="/internal/sign-in" className="underline underline-offset-4">
            Sign in
          </Link>
        </p>
      </form>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="termsVersion" value={props.termsVersion} />
      <input type="hidden" name="privacyVersion" value={props.privacyVersion} />
      <p className="text-sm text-text-secondary">
        Code sent to <span className="font-medium text-text-primary">{state.email}</span>
      </p>
      {state.notice ? (
        <p role="status" className="text-sm text-text-secondary">
          {state.notice}
        </p>
      ) : null}
      <label className={labelClassName}>
        Verification code
        <input
          required
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{4,10}"
          className={inputClassName}
        />
      </label>
      <label className={labelClassName}>
        Your name
        <input
          required
          name="displayName"
          autoComplete="name"
          maxLength={120}
          className={inputClassName}
        />
      </label>
      <label className={labelClassName}>
        Password
        <input
          required
          type="password"
          name="password"
          autoComplete="new-password"
          minLength={12}
          className={inputClassName}
        />
        <span className="text-xs font-normal text-text-muted">
          At least 12 characters with an uppercase and a lowercase letter, a
          number and a symbol.
        </span>
      </label>
      <label className={labelClassName}>
        Confirm password
        <input
          required
          type="password"
          name="confirmPassword"
          autoComplete="new-password"
          className={inputClassName}
        />
      </label>
      <label className="flex items-start gap-3 text-sm text-text-primary">
        <input required type="checkbox" name="acceptLegal" className="mt-1 size-4" />
        <span>
          I accept the <DocumentName name="Terms of Service" url={props.termsUrl} />{" "}
          (version {props.termsVersion}) and the{" "}
          <DocumentName name="Privacy Policy" url={props.privacyUrl} /> (version{" "}
          {props.privacyVersion}).
        </span>
      </label>
      {error}
      <button
        type="submit"
        name="intent"
        value="complete"
        disabled={pending}
        className={primaryButtonClassName}
      >
        {pending ? "Creating account…" : "Create account"}
      </button>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        <button
          type="submit"
          name="intent"
          value="resend"
          formNoValidate
          disabled={pending}
          className={linkButtonClassName}
        >
          Send a new code
        </button>
        <button
          type="submit"
          name="intent"
          value="change-email"
          formNoValidate
          disabled={pending}
          className={linkButtonClassName}
        >
          Use a different email
        </button>
      </div>
      <p className="text-xs text-text-muted">
        Already finished this step? Your account is ready —{" "}
        <Link href="/internal/sign-in" className="underline underline-offset-4">
          sign in
        </Link>{" "}
        to set up your business.
      </p>
    </form>
  );
}
