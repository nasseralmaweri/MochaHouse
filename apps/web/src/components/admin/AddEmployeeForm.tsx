"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AdminAccessAssignmentOptions } from "@mocha-house/contracts";
import {
  EMPTY_EMPLOYEE,
  addEmployeeFromBrowser,
  buildEmployeeRequest,
  invitationMessage,
  locationChoice,
  type EmployeeDraft,
  type EmployeeErrors,
} from "@/lib/admin/staff-invitation";
import { Card } from "@/components/Card";
import { Button } from "./Button";
import { ADMIN_FIELD_CLASS, FormField } from "./form";

// V1 launch fix 2 — "Add employee" in Administration → Users. Name, email,
// one of the business's existing access levels and, for a location-level
// access, the locations it applies to. The person is added as INVITED and
// can do nothing until they themselves sign in for the first time.
export function AddEmployeeForm({
  options,
}: {
  options: AdminAccessAssignmentOptions;
}) {
  const id = useId();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<EmployeeDraft>(EMPTY_EMPLOYEE);
  const [errors, setErrors] = useState<EmployeeErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [added, setAdded] = useState<{ id: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // A second click in the same tick is refused before React re-renders.
  const sending = useRef(false);

  const level = options.accessLevels.find((l) => l.id === draft.accessLevelId);
  const where = locationChoice(options);
  const update = (next: Partial<EmployeeDraft>) => {
    setDraft({ ...draft, ...next });
    setErrors({});
    setFailure(null);
  };

  async function submit() {
    if (sending.current) return;
    const built = buildEmployeeRequest(draft, options);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    sending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const result = await addEmployeeFromBrowser(built.request);
      if (result.outcome === "success") {
        setAdded({
          id: result.data.user.id,
          message: invitationMessage(result.data.invitation, result.data.user.email),
        });
        setDraft(EMPTY_EMPLOYEE);
        setOpen(false);
        router.refresh();
      } else if (result.outcome === "not-found") {
        setFailure("That access level is no longer available. Reload the page and choose again.");
      } else {
        setFailure(result.message);
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div role="status" aria-live="polite">
        {added ? (
          <Card tone="subtle" className="flex flex-col gap-1 text-sm text-text-primary">
            <span className="font-medium">Employee added.</span>
            <span>{added.message}</span>
            <Link
              href={`/admin/administration/users/${encodeURIComponent(added.id)}`}
              className="self-start font-medium underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              View their access
            </Link>
          </Card>
        ) : null}
      </div>

      {!open ? (
        <Button
          className="sm:self-start"
          onClick={() => {
            setOpen(true);
            setAdded(null);
          }}
        >
          Add employee
        </Button>
      ) : (
        <Card className="flex flex-col gap-4">
          <h2 className="text-base font-semibold text-text-primary">Add employee</h2>
          <p className="text-sm text-text-secondary">
            They&apos;ll get an email invitation to sign in. Their access starts
            only after they sign in and set their own password.
          </p>
          <FormField label="Name" htmlFor={`${id}-name`} error={errors.displayName}>
            <input
              id={`${id}-name`}
              autoComplete="off"
              maxLength={120}
              className={`${ADMIN_FIELD_CLASS} min-h-11`}
              value={draft.displayName}
              onChange={(e) => update({ displayName: e.target.value })}
            />
          </FormField>
          <FormField
            label="Email"
            htmlFor={`${id}-email`}
            hint="The invitation goes here. It must be an address only this person reads."
            error={errors.email}
          >
            <input
              id={`${id}-email`}
              type="email"
              autoComplete="off"
              inputMode="email"
              className={`${ADMIN_FIELD_CLASS} min-h-11`}
              value={draft.email}
              onChange={(e) => update({ email: e.target.value })}
            />
          </FormField>
          <FormField
            label="Phone (optional)"
            htmlFor={`${id}-phone`}
            error={errors.phone}
          >
            <input
              id={`${id}-phone`}
              type="tel"
              autoComplete="off"
              inputMode="tel"
              maxLength={32}
              className={`${ADMIN_FIELD_CLASS} min-h-11`}
              value={draft.phone}
              onChange={(e) => update({ phone: e.target.value })}
            />
          </FormField>
          <FormField
            label="Job title (optional)"
            htmlFor={`${id}-title`}
            hint="For your team's reference only. It doesn't change what they can do — the access level does."
            error={errors.jobTitle}
          >
            <input
              id={`${id}-title`}
              autoComplete="off"
              maxLength={80}
              className={`${ADMIN_FIELD_CLASS} min-h-11`}
              value={draft.jobTitle}
              onChange={(e) => update({ jobTitle: e.target.value })}
            />
          </FormField>
          <FormField label="Access level" htmlFor={`${id}-level`} error={errors.accessLevel}>
            <select
              id={`${id}-level`}
              className={`${ADMIN_FIELD_CLASS} min-h-11`}
              value={draft.accessLevelId}
              onChange={(e) => update({ accessLevelId: e.target.value, locationIds: [] })}
            >
              <option value="">Choose an access level</option>
              {options.accessLevels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.displayName}
                </option>
              ))}
            </select>
          </FormField>
          {level?.description ? (
            <p className="text-xs text-text-muted">{level.description}</p>
          ) : null}

          {level?.assignmentShape === "corporate-only" ? (
            <p className="text-sm text-text-secondary">
              This access level applies to <strong>every location</strong>.
            </p>
          ) : level?.assignmentShape === "location-only" && where.kind === "none" ? (
            <p role="alert" className="text-sm text-status-warning">
              {errors.locations ??
                "This access level applies to specific locations, and there are no active locations yet. Set up a location first."}
            </p>
          ) : level?.assignmentShape === "location-only" && where.kind === "single" ? (
            <p className="text-sm text-text-secondary">
              Applies to <strong>{where.location.name}</strong>, your only active
              location. Locations you add later aren&apos;t included automatically.
            </p>
          ) : level?.assignmentShape === "location-only" ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium text-text-primary">
                Locations they can work at
              </legend>
              <p className="text-xs text-text-muted">
                Choose one or more. Locations you add later aren&apos;t included
                automatically.
              </p>
              {(
                options.locations.map((location) => (
                  <label
                    key={location.id}
                    className="flex min-h-11 items-center gap-2 text-sm text-text-primary"
                  >
                    <input
                      type="checkbox"
                      checked={draft.locationIds.includes(location.id)}
                      onChange={(e) =>
                        update({
                          locationIds: e.target.checked
                            ? [...draft.locationIds, location.id]
                            : draft.locationIds.filter((x) => x !== location.id),
                        })
                      }
                    />
                    {location.name}
                  </label>
                ))
              )}
              {errors.locations ? (
                <p role="alert" className="text-sm text-status-warning">
                  {errors.locations}
                </p>
              ) : null}
            </fieldset>
          ) : null}

          {failure ? (
            <p role="alert" className="text-sm text-status-warning">
              {failure}
            </p>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button disabled={busy} onClick={() => void submit()}>
              {busy ? "Adding…" : "Add and send invitation"}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setDraft(EMPTY_EMPLOYEE);
                setErrors({});
                setFailure(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
