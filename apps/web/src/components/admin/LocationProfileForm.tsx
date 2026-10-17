"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  LOCATION_LIMIT_REACHED,
  validateLocationProfile,
  type AdminLocationDetail,
  type AdminLocationProfileRequest,
} from "@mocha-house/contracts";
import {
  createLocationFromBrowser,
  updateLocationProfileFromBrowser,
} from "@/lib/api-client";
import type { ChoiceOption } from "@/lib/admin/location-profile";
import { Button, ButtonLink } from "./Button";
import { ADMIN_FIELD_CLASS, FormField } from "./form";

type Field = keyof AdminLocationProfileRequest;
type Values = Record<Field, string>;

// SC4d — a location's name, address, time zone and phone. Creates the
// business's first location (mode "create") or edits a location's details
// (mode "edit"). The checks are the shared ones the API runs; the API stays
// the authority and its message wins. A new location starts with online
// ordering off — that is said up front, so nobody expects it to go live.
export function LocationProfileForm({
  mode,
  location,
  countries,
  timeZones,
}: {
  mode: "create" | "edit";
  location?: AdminLocationDetail;
  countries: ChoiceOption[];
  timeZones: ChoiceOption[];
}) {
  const router = useRouter();
  const profile = location?.profile;
  const [values, setValues] = useState<Values>({
    name: location?.name ?? "",
    addressLine1: profile?.addressLine1 ?? "",
    addressLine2: profile?.addressLine2 ?? "",
    city: profile?.city ?? "",
    region: profile?.region ?? "",
    postalCode: profile?.postalCode ?? "",
    countryCode: profile?.countryCode ?? "",
    timeZone: profile?.timeZone ?? "",
    phone: profile?.phone ?? "",
  });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [existingLocationId, setExistingLocationId] = useState<string | null>(
    null,
  );
  const [pending, setPending] = useState(false);

  // Suggest the browser's own time zone for a new location (only when it is
  // one the API accepts, and only until the owner picks one).
  useEffect(() => {
    if (mode !== "create") return;
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected && timeZones.some((zone) => zone.value === detected)) {
      setValues((current) =>
        current.timeZone ? current : { ...current, timeZone: detected },
      );
    }
  }, [mode, timeZones]);

  const set = (field: Field) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setFormError(null);
  };

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const allowed = new Set(timeZones.map((zone) => zone.value));
    const checked = validateLocationProfile(values, (zone) =>
      allowed.has(zone),
    );
    if (!checked.ok) {
      setErrors({ [checked.field]: checked.message });
      document.getElementById(`location-${checked.field}`)?.focus();
      return;
    }

    setPending(true);
    setFormError(null);
    setExistingLocationId(null);
    const body: AdminLocationProfileRequest = checked.value;
    const result =
      mode === "create"
        ? await createLocationFromBrowser(body)
        : await updateLocationProfileFromBrowser(location!.id, body);

    if (result.outcome === "success") {
      router.push(
        mode === "create"
          ? "/admin/getting-started"
          : `/admin/locations/${result.data.id}`,
      );
      router.refresh();
      return;
    }
    setPending(false);
    if (result.outcome === "invalid") {
      const field = result.field as Field | null;
      if (field && field in values) {
        setErrors({ [field]: result.message });
      } else {
        setFormError(result.message);
      }
    } else if (result.outcome === "conflict") {
      setFormError(result.message);
      if (result.code === LOCATION_LIMIT_REACHED) {
        setExistingLocationId(result.locationId);
      }
    } else if (result.outcome === "forbidden") {
      setFormError("You don't have permission to do this.");
    } else if (result.outcome === "not-found") {
      setFormError("This location no longer exists.");
    } else {
      setFormError(result.message);
    }
  }

  const text = (
    field: Field,
    label: string,
    options: {
      hint?: string;
      autoComplete?: string;
      type?: string;
      inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
      optional?: boolean;
    } = {},
  ) => (
    <FormField
      label={options.optional ? `${label} (optional)` : label}
      htmlFor={`location-${field}`}
      hint={options.hint}
      error={errors[field]}
    >
      <input
        id={`location-${field}`}
        name={field}
        type={options.type ?? "text"}
        inputMode={options.inputMode}
        value={values[field]}
        onChange={(event) => set(field)(event.target.value)}
        autoComplete={options.autoComplete ?? "off"}
        aria-invalid={errors[field] ? true : undefined}
        required={!options.optional}
        className={`${ADMIN_FIELD_CLASS} min-h-11`}
      />
    </FormField>
  );

  const select = (
    field: Field,
    label: string,
    choices: ChoiceOption[],
    placeholder: string,
    hint?: string,
  ) => (
    <FormField
      label={label}
      htmlFor={`location-${field}`}
      hint={hint}
      error={errors[field]}
    >
      <select
        id={`location-${field}`}
        name={field}
        value={values[field]}
        onChange={(event) => set(field)(event.target.value)}
        aria-invalid={errors[field] ? true : undefined}
        required
        className={`${ADMIN_FIELD_CLASS} min-h-11`}
      >
        <option value="">{placeholder}</option>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    </FormField>
  );

  const cancelHref =
    mode === "create"
      ? "/admin/getting-started"
      : `/admin/locations/${location!.id}`;

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="flex max-w-lg flex-col gap-5"
    >
      {text("name", "Location name", {
        hint: "What customers know this location as, e.g. “Harbor Street Café”.",
      })}

      <fieldset className="flex flex-col gap-5">
        <legend className="mb-3 text-sm font-semibold text-text-primary">
          Address
        </legend>
        {text("addressLine1", "Street address", {
          autoComplete: "address-line1",
        })}
        {text("addressLine2", "Apartment, suite or unit", {
          autoComplete: "address-line2",
          optional: true,
        })}
        {text("city", "City", { autoComplete: "address-level2" })}
        <div className="grid gap-5 sm:grid-cols-2">
          {text("region", "State or region", {
            autoComplete: "address-level1",
            optional: true,
          })}
          {text("postalCode", "Postal code", {
            autoComplete: "postal-code",
            optional: true,
          })}
        </div>
        {select("countryCode", "Country", countries, "Choose a country")}
      </fieldset>

      {select(
        "timeZone",
        "Time zone",
        timeZones,
        "Choose a time zone",
        "Opening hours are in this time zone.",
      )}

      {text("phone", "Phone number", {
        type: "tel",
        inputMode: "tel",
        autoComplete: "tel",
        hint: "Include the country code if customers may call from abroad, e.g. +1 555 123 4567.",
      })}

      {mode === "create" ? (
        <p className="rounded-xl border border-border-default bg-surface-subtle px-3 py-3 text-sm text-text-secondary">
          Online ordering starts turned off. You can turn it on once your
          opening hours, menu and payment setup are done.
        </p>
      ) : null}

      {formError ? (
        <div role="alert" className="flex flex-col gap-1 text-sm text-status-warning">
          <p>{formError}</p>
          {existingLocationId ? (
            <Link
              href={`/admin/locations/${existingLocationId}`}
              className="font-medium underline underline-offset-2"
            >
              Open your location
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending
            ? "Saving…"
            : mode === "create"
              ? "Add location"
              : "Save details"}
        </Button>
        <ButtonLink href={cancelHref} variant="secondary">
          Cancel
        </ButtonLink>
      </div>
    </form>
  );
}
