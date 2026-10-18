"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AdminModifierGroupDetail,
  AdminUpdateModifierGroupRequest,
} from "@mocha-house/contracts";
import {
  createModifierGroupFromBrowser,
  updateModifierGroupFromBrowser,
} from "@/lib/api-client";
import {
  parseSelectionInputs,
  selectionRuleLabel,
  sharedGroupNotice,
} from "@/lib/admin/modifiers";
import { Button, ButtonLink } from "./Button";
import { ADMIN_FIELD_CLASS, ActiveStatusField, FormField } from "./form";

// Create a modifier group, or edit one's name, choice limits and status.
// "Required" is not a separate switch: a minimum of 1 or more makes the
// group required, and the summary line says so as the admin types. A
// group can be shared by many products, so editing one says how many it
// affects before saving; deactivating asks for a quick confirmation.
export function ModifierGroupForm(
  props:
    | { mode: "create" }
    | { mode: "edit"; group: AdminModifierGroupDetail },
) {
  const router = useRouter();
  const noLimitId = useId();
  const group = props.mode === "edit" ? props.group : null;

  const [name, setName] = useState(group?.name ?? "");
  const [min, setMin] = useState(String(group?.minSelections ?? 0));
  const [max, setMax] = useState(
    group ? (group.maxSelections === null ? "" : String(group.maxSelections)) : "1",
  );
  const [noLimit, setNoLimit] = useState(
    group ? group.maxSelections === null : false,
  );
  const [isActive, setIsActive] = useState(group?.isActive ?? true);
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const parsed = parseSelectionInputs(min, max, noLimit);
  const willDeactivate = group !== null && group.isActive && !isActive;

  function edited() {
    setError(null);
    setSaved(false);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim() === "") {
      setError("Enter a group name.");
      return;
    }
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (willDeactivate && !confirmingDeactivate) {
      setError(null);
      setConfirmingDeactivate(true);
      return;
    }

    setPending(true);
    setError(null);
    if (group === null) {
      const result = await createModifierGroupFromBrowser({
        name: name.trim(),
        ...parsed.value,
      });
      if (result.outcome === "success") {
        router.push(
          `/admin/menu/modifiers/${encodeURIComponent(result.data.id)}?created=1`,
        );
        router.refresh();
        return;
      }
      setPending(false);
      setError(
        result.outcome === "forbidden"
          ? "You don't have permission to create modifier groups."
          : result.outcome === "not-found"
            ? "Something went wrong. Please try again."
            : result.message,
      );
      return;
    }

    // Only what this admin changed is sent, so a save never overwrites a
    // field someone else edited after this page was opened.
    const changes: AdminUpdateModifierGroupRequest = {};
    if (name.trim() !== group.name) changes.name = name.trim();
    if (parsed.value.minSelections !== group.minSelections) {
      changes.minSelections = parsed.value.minSelections;
    }
    if (parsed.value.maxSelections !== group.maxSelections) {
      changes.maxSelections = parsed.value.maxSelections;
    }
    if (isActive !== group.isActive) changes.isActive = isActive;
    if (Object.keys(changes).length === 0) {
      setPending(false);
      setConfirmingDeactivate(false);
      setSaved(true);
      return;
    }
    const result = await updateModifierGroupFromBrowser(group.id, changes);
    setPending(false);
    setConfirmingDeactivate(false);
    if (result.outcome === "success") {
      setSaved(true);
      router.refresh();
      return;
    }
    setError(
      result.outcome === "forbidden"
        ? "You don't have permission to edit modifier groups."
        : result.outcome === "not-found"
          ? "This modifier group no longer exists."
          : result.message,
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-lg flex-col gap-6">
      <FormField
        label="Group name"
        htmlFor="modifier-group-name"
        hint='What customers see above the choices, e.g. "Size" or "Milk".'
      >
        <input
          id="modifier-group-name"
          value={name}
          maxLength={120}
          onChange={(event) => {
            setName(event.target.value);
            edited();
          }}
          autoComplete="off"
          className={`${ADMIN_FIELD_CLASS} min-h-11`}
        />
      </FormField>

      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-medium text-text-primary">
          How many choices
        </legend>
        <div className="flex flex-wrap gap-4">
          <FormField
            label="Minimum"
            htmlFor="modifier-group-min"
            hint="1 or more makes the group required."
          >
            <input
              id="modifier-group-min"
              inputMode="numeric"
              value={min}
              onChange={(event) => {
                setMin(event.target.value);
                edited();
              }}
              autoComplete="off"
              className={`${ADMIN_FIELD_CLASS} min-h-11 w-28`}
            />
          </FormField>
          <FormField label="Maximum" htmlFor="modifier-group-max">
            <input
              id="modifier-group-max"
              inputMode="numeric"
              value={noLimit ? "" : max}
              disabled={noLimit}
              onChange={(event) => {
                setMax(event.target.value);
                edited();
              }}
              autoComplete="off"
              className={`${ADMIN_FIELD_CLASS} min-h-11 w-28 disabled:bg-surface-subtle`}
            />
          </FormField>
        </div>
        <label
          htmlFor={noLimitId}
          className="flex min-h-11 items-center gap-2 text-sm text-text-primary"
        >
          <input
            id={noLimitId}
            type="checkbox"
            checked={noLimit}
            onChange={(event) => {
              setNoLimit(event.target.checked);
              edited();
            }}
            className="h-4 w-4"
          />
          No limit on the maximum
        </label>
        <p className="text-sm text-text-secondary" aria-live="polite">
          {parsed.ok
            ? selectionRuleLabel(
                parsed.value.minSelections,
                parsed.value.maxSelections,
              )
            : "Enter the minimum and maximum to see how customers choose."}
        </p>
      </fieldset>

      {group !== null ? (
        <ActiveStatusField
          isActive={isActive}
          onChange={(next) => {
            setIsActive(next);
            if (next) setConfirmingDeactivate(false);
            edited();
          }}
          hint="An inactive group isn't offered on any product."
        />
      ) : null}

      {group !== null && group.products.length > 0 ? (
        <p className="text-sm text-status-warning">
          {sharedGroupNotice(group.products.length)}
        </p>
      ) : null}

      {confirmingDeactivate ? (
        <p role="alert" className="text-sm text-status-warning">
          Customers will no longer see this group on{" "}
          {group && group.products.length > 0
            ? `its ${group.products.length === 1 ? "product" : `${group.products.length} products`}`
            : "any product"}
          . Select &ldquo;Deactivate group&rdquo; to confirm.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="text-sm text-status-success">
          Saved.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending}>
          {pending
            ? "Saving…"
            : group === null
              ? "Create group"
              : confirmingDeactivate
                ? "Deactivate group"
                : "Save changes"}
        </Button>
        {group === null ? (
          <ButtonLink href="/admin/menu/modifiers">Cancel</ButtonLink>
        ) : null}
      </div>
    </form>
  );
}
