"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import {
  provisionTenantAction,
  type ProvisionFormState,
} from "@/lib/platform/tenant-provisioning-actions";
import {
  suggestSlug,
  type ProvisionField,
} from "@/lib/platform/tenant-provisioning";
import {
  PlatformLiveError,
  platformInputClassName,
  platformPrimaryButtonClassName,
} from "./PlatformAuthFrame";

// SC1d — "Add a business". The page mints the operation key on the server
// (one per visit); a double submit or a retry is the same operation. After
// success the form is replaced by what was created and the owner's next
// steps; "Add another business" opens the page again, which renders a new
// key, and the form (keyed by it) starts afresh.

const EMPTY: ProvisionFormState = {
  values: {
    name: "",
    slug: "",
    ownerEmail: "",
    ownerEmailConfirm: "",
    ownerDisplayName: "",
    planVersionId: "",
  },
  errors: {},
  message: null,
  created: null,
};

const FIELD_ORDER: ProvisionField[] = [
  "name",
  "slug",
  "ownerEmail",
  "ownerEmailConfirm",
  "ownerDisplayName",
  "planVersionId",
];

export function ProvisionTenantForm({
  operationKey,
  plans,
}: {
  operationKey: string;
  // SC2a — published plan versions only.
  plans: ReadonlyArray<{ id: string; label: string }>;
}) {
  const [state, formAction, pending] = useActionState(
    provisionTenantAction,
    EMPTY,
  );
  const id = useId();
  const fieldId = (name: ProvisionField) => `${id}-${name}`;
  const errorId = (name: ProvisionField) => `${id}-${name}-error`;
  const [name, setName] = useState(state.values.name);
  const [slug, setSlug] = useState(state.values.slug);
  const [slugEdited, setSlugEdited] = useState(false);
  // Controlled, so a failed attempt never resets what was typed (and the
  // form, with its live alert region, stays mounted).
  const [ownerEmail, setOwnerEmail] = useState(state.values.ownerEmail);
  const [ownerEmailConfirm, setOwnerEmailConfirm] = useState(
    state.values.ownerEmailConfirm,
  );
  const [ownerDisplayName, setOwnerDisplayName] = useState(
    state.values.ownerDisplayName,
  );
  const [planVersionId, setPlanVersionId] = useState(state.values.planVersionId);
  const successHeading = useRef<HTMLHeadingElement>(null);

  // After a failed attempt: focus the first field in error (or the message).
  useEffect(() => {
    if (state.created) {
      successHeading.current?.focus();
      return;
    }
    const first = FIELD_ORDER.find((field) => state.errors[field]);
    if (first) {
      document.getElementById(`${id}-${first}`)?.focus();
    } else if (state.message) {
      document.getElementById(`${id}-message`)?.focus();
    }
  }, [state, id]);

  if (state.created) {
    const { tenant, owner, replayed } = state.created;
    return (
      <section
        aria-labelledby={`${id}-done`}
        className="flex flex-col gap-4 rounded-2xl border border-border-default bg-surface-card p-6"
      >
        <h2
          id={`${id}-done`}
          ref={successHeading}
          tabIndex={-1}
          className="text-lg font-semibold text-text-primary focus:outline-none"
        >
          {replayed ? "This business was already added" : "Business added"}
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-text-secondary">Business</dt>
          <dd className="break-words text-text-primary">{tenant.name}</dd>
          <dt className="text-text-secondary">Slug</dt>
          <dd className="break-all font-mono text-text-primary">{tenant.slug}</dd>
          <dt className="text-text-secondary">First owner</dt>
          <dd className="break-all text-text-primary">{owner.email}</dd>
        </dl>
        <div className="rounded-lg bg-surface-subtle px-4 py-3 text-sm text-text-primary">
          <p className="font-medium">Next steps for the owner</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-text-secondary">
            <li>
              Their staff sign-in account must use exactly{" "}
              <span className="font-mono text-text-primary">{owner.email}</span>
              , with the email verified.
            </li>
            <li>
              They sign in at the business sign-in page and choose{" "}
              {tenant.name}.
            </li>
            <li>
              The business is Active, but its storefront, online ordering,
              payments and subscription are all off, and it has no locations
              or menu yet. Each is set up separately.
            </li>
          </ol>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link
            href={`/platform/tenants/${tenant.id}`}
            className={platformPrimaryButtonClassName}
          >
            Open business
          </Link>
          {/* The page renders per request (never cached): a new visit gets a
              new operation key, and the form — keyed by it — starts afresh. */}
          <Link
            href="/platform/tenants/new"
            className="inline-flex min-h-11 items-center rounded-lg border border-border-default px-4 text-sm font-medium text-text-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          >
            Add another business
          </Link>
        </div>
      </section>
    );
  }

  const describe = (field: ProvisionField, hint?: string) =>
    [state.errors[field] ? errorId(field) : null, hint ?? null]
      .filter(Boolean)
      .join(" ") || undefined;

  const fieldError = (field: ProvisionField) =>
    state.errors[field] ? (
      <p id={errorId(field)} className="text-sm text-status-error">
        {state.errors[field]}
      </p>
    ) : null;

  return (
    <form
      action={formAction}
      noValidate
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="flex flex-col gap-6 rounded-2xl border border-border-default bg-surface-card p-6"
    >
      <input type="hidden" name="operationKey" value={operationKey} />

      <div
        id={`${id}-message`}
        tabIndex={-1}
        className="focus:outline-none"
      >
        <PlatformLiveError id={`${id}-alert`} message={state.message} />
      </div>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-base font-semibold text-text-primary">
          Business
        </legend>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={fieldId("name")} className="text-sm font-medium text-text-primary">
            Business name
          </label>
          <input
            id={fieldId("name")}
            name="name"
            required
            maxLength={120}
            autoComplete="organization"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (!slugEdited) setSlug(suggestSlug(event.target.value));
            }}
            aria-invalid={state.errors.name ? true : undefined}
            aria-describedby={describe("name")}
            className={platformInputClassName}
          />
          {fieldError("name")}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={fieldId("slug")} className="text-sm font-medium text-text-primary">
            Slug
          </label>
          <input
            id={fieldId("slug")}
            name="slug"
            required
            maxLength={50}
            autoComplete="off"
            spellCheck={false}
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value);
              setSlugEdited(true);
            }}
            aria-invalid={state.errors.slug ? true : undefined}
            aria-describedby={describe("slug", `${id}-slug-hint`)}
            className={`${platformInputClassName} font-mono`}
          />
          <p id={`${id}-slug-hint`} className="text-xs text-text-secondary">
            A permanent identifier: lowercase letters and numbers joined by
            hyphens, e.g. blue-bean-coffee.
          </p>
          {fieldError("slug")}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-base font-semibold text-text-primary">
          First owner
        </legend>
        <p id={`${id}-owner-hint`} className="-mt-2 text-sm text-text-secondary">
          The owner gets full administration of this business only. They sign
          in with this email once it is verified by the staff sign-in system.
        </p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={fieldId("ownerEmail")} className="text-sm font-medium text-text-primary">
            Owner email
          </label>
          <input
            id={fieldId("ownerEmail")}
            name="ownerEmail"
            type="email"
            required
            maxLength={254}
            autoComplete="off"
            spellCheck={false}
            value={ownerEmail}
            onChange={(event) => setOwnerEmail(event.target.value)}
            aria-invalid={state.errors.ownerEmail ? true : undefined}
            aria-describedby={describe("ownerEmail", `${id}-owner-hint`)}
            className={platformInputClassName}
          />
          {fieldError("ownerEmail")}
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={fieldId("ownerEmailConfirm")}
            className="text-sm font-medium text-text-primary"
          >
            Confirm owner email
          </label>
          <input
            id={fieldId("ownerEmailConfirm")}
            name="ownerEmailConfirm"
            type="email"
            required
            maxLength={254}
            autoComplete="off"
            spellCheck={false}
            value={ownerEmailConfirm}
            onChange={(event) => setOwnerEmailConfirm(event.target.value)}
            aria-invalid={state.errors.ownerEmailConfirm ? true : undefined}
            aria-describedby={describe("ownerEmailConfirm")}
            className={platformInputClassName}
          />
          {fieldError("ownerEmailConfirm")}
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={fieldId("ownerDisplayName")}
            className="text-sm font-medium text-text-primary"
          >
            Owner name <span className="font-normal text-text-secondary">(optional)</span>
          </label>
          <input
            id={fieldId("ownerDisplayName")}
            name="ownerDisplayName"
            maxLength={120}
            autoComplete="off"
            value={ownerDisplayName}
            onChange={(event) => setOwnerDisplayName(event.target.value)}
            aria-invalid={state.errors.ownerDisplayName ? true : undefined}
            aria-describedby={describe("ownerDisplayName")}
            className={platformInputClassName}
          />
          {fieldError("ownerDisplayName")}
        </div>
      </fieldset>

      {/* SC2a — every new business starts on a published plan. */}
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-base font-semibold text-text-primary">Plan</legend>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={fieldId("planVersionId")} className="text-sm font-medium text-text-primary">
            Starting plan
          </label>
          <select
            id={fieldId("planVersionId")}
            name="planVersionId"
            required
            value={planVersionId}
            onChange={(event) => setPlanVersionId(event.target.value)}
            aria-invalid={state.errors.planVersionId ? true : undefined}
            aria-describedby={describe("planVersionId", `${id}-plan-hint`)}
            className={platformInputClassName}
          >
            <option value="">Choose a published plan…</option>
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.label}
              </option>
            ))}
          </select>
          <p id={`${id}-plan-hint`} className="text-xs text-text-secondary">
            Decides which modules the business can use. Core is always included. No billing yet.
          </p>
          {fieldError("planVersionId")}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          aria-disabled={pending}
          aria-busy={pending}
          className={platformPrimaryButtonClassName}
        >
          {pending ? "Adding business…" : "Add business"}
        </button>
        <Link
          href="/platform/tenants"
          className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-text-secondary underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
