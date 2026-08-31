"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AdminAccessAssignmentOptions,
  AdminInternalUserAccessAssignment,
} from "@mocha-house/contracts";
import {
  assignInternalUserRoleFromBrowser,
  removeInternalUserRoleAssignmentFromBrowser,
} from "@/lib/api-client";
import {
  assignmentWhereLabel,
  checkAccessChangeReason,
} from "@/lib/admin/user-access";
import {
  accessLevelNeedsLocations,
  buildAssignRoleRequest,
} from "@/lib/admin/access-assignment";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";

// The "Manage access" controls on a user's detail page (Milestone 5E-4).
// Rendered only when the viewer holds `users.manage_roles` and the target
// is not themselves. Shows each concrete grant with a Remove action and an
// "Add access" form. The API is the authority — this island collects the
// reason / choices and surfaces the result.
export function UserAccessControl({
  internalUserId,
  assignments,
  options,
}: {
  internalUserId: string;
  assignments: AdminInternalUserAccessAssignment[];
  options: AdminAccessAssignmentOptions;
}) {
  const router = useRouter();

  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Remove flow.
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState("");
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Add flow.
  const [adding, setAdding] = useState(false);
  const [roleId, setRoleId] = useState<string>("");
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [addReason, setAddReason] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const selectedLevel = useMemo(
    () => options.accessLevels.find((level) => level.id === roleId) ?? null,
    [options.accessLevels, roleId],
  );
  const needsLocations = accessLevelNeedsLocations(
    selectedLevel?.assignmentShape ?? null,
  );

  function resetAdd() {
    setAdding(false);
    setRoleId("");
    setLocationIds([]);
    setAddReason("");
    setAddError(null);
  }

  function resetRemove() {
    setRemovingId(null);
    setRemoveReason("");
    setRemoveError(null);
  }

  function toggleLocation(id: string) {
    setAddError(null);
    setLocationIds((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id],
    );
  }

  async function submitAdd() {
    const checked = buildAssignRoleRequest({
      roleId: roleId || null,
      shape: selectedLevel?.assignmentShape ?? null,
      locationIds,
      reason: addReason,
    });
    if (!checked.ok) {
      setAddError(checked.error);
      return;
    }

    setPending(true);
    setNotice(null);
    const result = await assignInternalUserRoleFromBrowser(
      internalUserId,
      checked.request,
    );
    setPending(false);

    if (result.outcome === "success") {
      resetAdd();
      setNotice("Access granted.");
      router.refresh();
      return;
    }
    if (result.outcome === "forbidden") {
      setAddError("You don’t have permission to grant this access.");
      return;
    }
    if (result.outcome === "not-found") {
      setAddError("This person or access level no longer exists.");
      return;
    }
    setAddError(result.message);
  }

  async function submitRemove(assignmentId: string) {
    const checked = checkAccessChangeReason(removeReason);
    if (!checked.ok) {
      setRemoveError(checked.error);
      return;
    }

    setPending(true);
    setNotice(null);
    const result = await removeInternalUserRoleAssignmentFromBrowser(
      internalUserId,
      assignmentId,
      checked.reason,
    );
    setPending(false);

    if (result.outcome === "success") {
      resetRemove();
      setNotice("Access removed.");
      router.refresh();
      return;
    }
    if (result.outcome === "forbidden") {
      setRemoveError("You don’t have permission to remove this access.");
      return;
    }
    if (result.outcome === "not-found") {
      setRemoveError("This access has already been removed.");
      return;
    }
    setRemoveError(result.message);
  }

  return (
    <div className="flex flex-col gap-4">
      {assignments.length === 0 ? (
        <p className="text-sm text-text-secondary">
          This person has no access assigned yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {assignments.map((assignment) => (
            <li
              key={assignment.id}
              className="flex flex-col gap-2 rounded-xl border border-border-default bg-surface-card px-3 py-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-text-primary">
                  <span className="font-medium">
                    {assignment.accessLevel.displayName}
                  </span>{" "}
                  · {assignmentWhereLabel(assignment)}
                </span>
                {removingId === assignment.id ? null : (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      resetAdd();
                      setRemovingId(assignment.id);
                      setRemoveReason("");
                      setRemoveError(null);
                      setNotice(null);
                    }}
                  >
                    Remove access
                  </Button>
                )}
              </div>

              {removingId === assignment.id ? (
                <div className="flex flex-col gap-3 rounded-xl border border-border-default bg-surface-subtle px-3 py-3">
                  <p className="text-sm text-text-primary">
                    {assignment.isCorporate
                      ? "Remove Platform Administrator access? This removes this person’s corporate administrative access."
                      : `Remove ${assignment.accessLevel.displayName} access for ${assignmentWhereLabel(
                          assignment,
                        )}? This person will no longer be able to manage this location with this access level.`}
                  </p>
                  <FormField label="Reason" htmlFor={`remove-reason-${assignment.id}`}>
                    <textarea
                      id={`remove-reason-${assignment.id}`}
                      value={removeReason}
                      onChange={(event) => {
                        setRemoveReason(event.target.value);
                        setRemoveError(null);
                      }}
                      rows={2}
                      className={ADMIN_FIELD_CLASS}
                    />
                  </FormField>
                  {removeError ? (
                    <p role="alert" className="text-sm text-status-warning">
                      {removeError}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => void submitRemove(assignment.id)}
                      disabled={pending}
                    >
                      {pending ? "Working…" : "Remove access"}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={resetRemove}
                      disabled={pending}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border-default bg-surface-subtle px-3 py-3">
          <FormField label="Access level" htmlFor="add-access-level">
            <select
              id="add-access-level"
              value={roleId}
              onChange={(event) => {
                setRoleId(event.target.value);
                setLocationIds([]);
                setAddError(null);
              }}
              className={ADMIN_FIELD_CLASS}
            >
              <option value="">Choose an access level…</option>
              {options.accessLevels.map((level) => (
                <option key={level.id} value={level.id}>
                  {level.displayName}
                </option>
              ))}
            </select>
          </FormField>

          {selectedLevel && !needsLocations ? (
            <p className="text-sm text-text-secondary">
              Applies to: <span className="font-medium">All locations</span>
            </p>
          ) : null}

          {selectedLevel && needsLocations ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium text-text-primary">
                Where?
              </legend>
              {options.locations.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  There are no active locations to assign.
                </p>
              ) : (
                options.locations.map((location) => (
                  <label
                    key={location.id}
                    className="flex items-center gap-2 text-sm text-text-primary"
                  >
                    <input
                      type="checkbox"
                      checked={locationIds.includes(location.id)}
                      onChange={() => toggleLocation(location.id)}
                    />
                    {location.name}
                  </label>
                ))
              )}
            </fieldset>
          ) : null}

          {selectedLevel ? (
            <FormField label="Reason" htmlFor="add-access-reason">
              <textarea
                id="add-access-reason"
                value={addReason}
                onChange={(event) => {
                  setAddReason(event.target.value);
                  setAddError(null);
                }}
                rows={2}
                className={ADMIN_FIELD_CLASS}
              />
            </FormField>
          ) : null}

          {addError ? (
            <p role="alert" className="text-sm text-status-warning">
              {addError}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void submitAdd()} disabled={pending}>
              {pending ? "Working…" : "Grant access"}
            </Button>
            <Button variant="secondary" onClick={resetAdd} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            variant="secondary"
            onClick={() => {
              resetRemove();
              setAdding(true);
              setNotice(null);
            }}
          >
            Add access
          </Button>
        </div>
      )}

      {notice ? (
        <p role="status" className="text-sm text-status-success">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
