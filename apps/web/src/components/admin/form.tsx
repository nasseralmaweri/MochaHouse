"use client";

import { useId } from "react";

// Small, plain Admin form primitives (Milestone 5D-3). Deliberately not a
// form engine — just the label / hint / error scaffolding that the Admin
// edit forms were each hand-rolling, plus the shared input styling and the
// Active/Inactive choice that both the location and product edit forms use.

// The shared text-input / textarea / select class. Exported so callers
// style their own control while `FormField` owns the label and messages.
export const ADMIN_FIELD_CLASS =
  "rounded-xl border border-border-default bg-surface-card px-3 py-2 text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function FormField({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={htmlFor}
        className="text-sm font-medium text-text-primary"
      >
        {label}
      </label>
      {hint ? <p className="text-xs text-text-muted">{hint}</p> : null}
      {children}
      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// Active / Inactive as a labelled radio group. `hint` explains, in plain
// language, what "active" means for this kind of record.
export function ActiveStatusField({
  isActive,
  onChange,
  hint,
}: {
  isActive: boolean;
  onChange: (next: boolean) => void;
  hint?: string;
}) {
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium text-text-primary">Status</legend>
      {hint ? <p className="text-sm text-text-secondary">{hint}</p> : null}
      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input
          type="radio"
          name={name}
          checked={isActive}
          onChange={() => onChange(true)}
        />
        Active
      </label>
      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input
          type="radio"
          name={name}
          checked={!isActive}
          onChange={() => onChange(false)}
        />
        Inactive
      </label>
    </fieldset>
  );
}
