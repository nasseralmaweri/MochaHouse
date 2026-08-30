"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminLocationDetail } from "@mocha-house/contracts";
import { updateLocationFromBrowser } from "@/lib/api-client";
import { Button, ButtonLink } from "./Button";
import { ADMIN_FIELD_CLASS, ActiveStatusField, FormField } from "./form";

// The minimal Edit Location form (Milestone 5D-2). Only a location's name
// and whether it's active can be changed here; the web address (slug) is
// fixed and online ordering has its own control on the detail page.
//
// Deactivating a location removes it from what customers see, so that one
// change asks for a quick confirmation before saving. Everything else saves
// straight away. The API enforces that only corporate staff can do this.
export function LocationEditForm({
  location,
}: {
  location: AdminLocationDetail;
}) {
  const router = useRouter();
  const detailHref = `/admin/locations/${location.id}`;

  const [name, setName] = useState(location.name);
  const [isActive, setIsActive] = useState(location.isActive);
  const [pending, setPending] = useState(false);
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const willDeactivate = location.isActive && !isActive;

  async function save() {
    setPending(true);
    setError(null);
    const result = await updateLocationFromBrowser(location.id, {
      name: trimmedName,
      isActive,
    });

    if (result.outcome === "success") {
      // Back to the detail page; refresh so the server data is current.
      router.push(detailHref);
      router.refresh();
      return;
    }

    setPending(false);
    setConfirmingDeactivate(false);
    if (result.outcome === "invalid") {
      setError(result.message);
    } else if (result.outcome === "forbidden") {
      setError("You don't have permission to change this location.");
    } else if (result.outcome === "not-found") {
      setError("This location no longer exists.");
    } else {
      setError(result.message);
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmedName.length === 0) {
      setError("Enter a location name.");
      return;
    }
    if (willDeactivate && !confirmingDeactivate) {
      setError(null);
      setConfirmingDeactivate(true);
      return;
    }
    void save();
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-lg flex-col gap-6">
      <FormField label="Location name" htmlFor="location-name">
        <input
          id="location-name"
          name="name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          autoComplete="off"
          className={`${ADMIN_FIELD_CLASS} min-h-11`}
        />
      </FormField>

      <ActiveStatusField
        isActive={isActive}
        onChange={(next) => {
          setIsActive(next);
          if (next) {
            setConfirmingDeactivate(false);
          }
          setError(null);
        }}
        hint="Whether this location appears in the Mocha House app for customers."
      />

      <p className="text-xs text-text-muted">
        Web address: {location.slug} — this can&apos;t be changed.
      </p>

      {confirmingDeactivate ? (
        <div
          role="alert"
          className="rounded-xl border border-border-default bg-surface-subtle px-3 py-3 text-sm text-text-primary"
        >
          Deactivate this location? Customers will no longer see this location
          for online ordering.
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending
            ? "Saving…"
            : confirmingDeactivate
              ? "Deactivate and save"
              : "Save changes"}
        </Button>
        <ButtonLink href={detailHref} variant="secondary">
          Cancel
        </ButtonLink>
      </div>
    </form>
  );
}
