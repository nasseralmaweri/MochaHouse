"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import {
  PLATFORM_PERMISSIONS,
  type PlatformOperatorDirectoryResponse,
} from "@mocha-house/contracts";
import { changePermissionAction, type BillingActionState } from "@/lib/platform/billing-actions";
import { PRIMARY, Refusal, SECONDARY, SELECT } from "./SubscriptionPanel";

const INPUT =
  "min-h-10 w-full rounded-lg border border-border-default bg-surface-card px-3 text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const INITIAL: BillingActionState<PlatformOperatorDirectoryResponse> = { outcome: null };
type Operator = PlatformOperatorDirectoryResponse["operators"][number];

// SC3e-3 (owner decision D7) — granting and revoking another operator's
// permissions (platform.permissions.manage; a recent sign-in and a reason;
// never your own — the API and the database refuse it).
export function OperatorPermissions({ operator, self }: { operator: Operator; self: boolean }) {
  const [state, formAction, pending] = useActionState(changePermissionAction, INITIAL);
  const id = useId();
  const result = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.outcome?.kind === "ok") form.current?.reset();
    if (state.outcome) result.current?.focus();
  }, [state]);
  const held = new Set(operator.permissions.map((grant) => grant.permission));
  if (self) {
    return (
      <p className="text-sm text-text-secondary">
        Your own permissions are changed by another operator holding platform.permissions.manage.
      </p>
    );
  }
  if (operator.status !== "ACTIVE") {
    return <p className="text-sm text-text-secondary">Inactive operators can&apos;t be granted permissions.</p>;
  }
  return (
    <form
      ref={form}
      action={formAction}
      onSubmit={(event) => {
        if (pending) {
          event.preventDefault();
          return;
        }
        // Revoking can take away a colleague's access: confirmed first.
        const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        if (submitter?.value === "revoke" && !window.confirm(`Revoke this permission from ${operator.email}?`)) {
          event.preventDefault();
        }
      }}
      className="flex flex-col gap-2"
      aria-label={`Change ${operator.email}'s permissions`}
    >
      <input type="hidden" name="operatorId" value={operator.id} />
      <label htmlFor={`${id}-permission`} className="text-sm font-medium text-text-primary">
        Permission
      </label>
      <select id={`${id}-permission`} name="permission" required defaultValue="" className={SELECT}>
        <option value="" disabled>
          Choose a permission
        </option>
        {PLATFORM_PERMISSIONS.map((permission) => (
          <option key={permission} value={permission}>
            {permission}
            {held.has(permission) ? " (held)" : ""}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-reason`} className="text-sm font-medium text-text-primary">
        Reason (required)
      </label>
      <input id={`${id}-reason`} name="reason" required minLength={10} maxLength={500} autoComplete="off" className={INPUT} />
      <div ref={result} tabIndex={-1} className="focus:outline-none">
        {state.outcome?.kind === "ok" ? (
          <p role="status" className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
            Saved and recorded in the audit trail.
          </p>
        ) : null}
        <Refusal outcome={state.outcome} />
      </div>
      <div className="flex flex-wrap gap-3">
        <button type="submit" name="step" value="grant" aria-disabled={pending} className={PRIMARY}>
          Grant
        </button>
        <button type="submit" name="step" value="revoke" aria-disabled={pending} className={SECONDARY}>
          Revoke
        </button>
      </div>
    </form>
  );
}
