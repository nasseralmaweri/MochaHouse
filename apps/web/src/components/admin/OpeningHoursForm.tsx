"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  WEEKDAY_NAMES,
  validateOpeningHours,
  type AdminOpeningHours,
} from "@mocha-house/contracts";
import { setOpeningHoursFromBrowser } from "@/lib/api-client";
import {
  canAddPeriod,
  editableWeek,
  isOvernight,
  nextPeriod,
  toOpeningHoursRequest,
  type EditableDay,
} from "@/lib/admin/opening-hours";
import { timeZoneLabel } from "@/lib/admin/location-profile";
import { Button, ButtonLink } from "./Button";
import { ADMIN_FIELD_CLASS } from "./form";

// SC4d — a location's weekly opening hours, edited a week at a time. Each
// day is open or closed; an open day has one or more periods (lunch and
// dinner, say), and a period may run past midnight. Overlaps are refused
// here with the same rule the API uses. Saved and shown only — online
// ordering does not follow these hours yet.
export function OpeningHoursForm({
  locationId,
  timeZone,
  hours,
  doneHref,
}: {
  locationId: string;
  timeZone: string;
  hours: AdminOpeningHours;
  doneHref: string;
}) {
  const router = useRouter();
  const [week, setWeek] = useState<EditableDay[]>(() => editableWeek(hours));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  const update = (dayOfWeek: number, change: (day: EditableDay) => EditableDay) => {
    setWeek((current) =>
      current.map((day) => (day.dayOfWeek === dayOfWeek ? change(day) : day)),
    );
    setError(null);
    setCopied(false);
  };

  // Replaces every other day with Monday's periods. Only offered once
  // Monday is open, so it can never close the whole week by accident; the
  // owner reviews the result before saving.
  function copyMondayToAll() {
    const monday = week[0];
    if (!monday.open) return;
    setWeek((current) =>
      current.map((day) => ({
        ...day,
        open: true,
        periods: monday.periods.map((period) => ({ ...period })),
      })),
    );
    setError(null);
    setCopied(true);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = toOpeningHoursRequest(week);
    const checked = validateOpeningHours(request);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setPending(true);
    setError(null);
    const result = await setOpeningHoursFromBrowser(locationId, request);
    if (result.outcome === "success") {
      router.push(doneHref);
      router.refresh();
      return;
    }
    setPending(false);
    if (result.outcome === "invalid" || result.outcome === "error") {
      setError(result.message);
    } else if (result.outcome === "forbidden") {
      setError("You don't have permission to change these hours.");
    } else if (result.outcome === "not-found") {
      setError("This location no longer exists.");
    } else {
      setError(result.message);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-2xl flex-col gap-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-text-secondary">
          Times are in the location&apos;s time zone:{" "}
          <span className="font-medium text-text-primary">
            {timeZoneLabel(timeZone)}
          </span>
          . Closing at 12:00 AM means midnight; a closing time earlier than
          the opening time runs into the next day.
        </p>
        <Button
          type="button"
          variant="secondary"
          onClick={copyMondayToAll}
          disabled={!week[0].open}
          title={week[0].open ? undefined : "Set Monday's hours first."}
          className="shrink-0"
        >
          Copy Monday&apos;s hours to all days
        </Button>
      </div>
      <p
        role="status"
        className={copied ? "text-sm text-text-secondary" : "sr-only"}
      >
        {copied
          ? "Monday's hours were copied to every day. Check each day before saving."
          : ""}
      </p>

      <ul className="flex flex-col gap-3">
        {week.map((day) => {
          const dayName = WEEKDAY_NAMES[day.dayOfWeek - 1];
          return (
            <li
              key={day.dayOfWeek}
              className="flex flex-col gap-3 rounded-xl border border-border-default bg-surface-card px-4 py-4"
            >
              <fieldset className="flex flex-col gap-3">
                <legend className="sr-only">{dayName}</legend>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-text-primary">
                    {dayName}
                  </span>
                  <label className="flex min-h-11 items-center gap-2 text-sm text-text-primary">
                    <input
                      type="checkbox"
                      checked={day.open}
                      onChange={(event) =>
                        update(day.dayOfWeek, (current) => ({
                          ...current,
                          open: event.target.checked,
                        }))
                      }
                      className="h-5 w-5"
                    />
                    Open
                  </label>
                </div>

                {day.open ? (
                  <div className="flex flex-col gap-3">
                    {day.periods.map((period, index) => {
                      const label = `${dayName} period ${index + 1}`;
                      return (
                        <div
                          key={index}
                          className="flex flex-wrap items-end gap-3"
                        >
                          <label className="flex flex-col gap-1 text-xs text-text-secondary">
                            Opens
                            <input
                              type="time"
                              required
                              aria-label={`${label} opens`}
                              value={period.opensAt}
                              onChange={(event) =>
                                update(day.dayOfWeek, (current) => ({
                                  ...current,
                                  periods: current.periods.map((p, i) =>
                                    i === index
                                      ? { ...p, opensAt: event.target.value }
                                      : p,
                                  ),
                                }))
                              }
                              className={`${ADMIN_FIELD_CLASS} min-h-11`}
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-xs text-text-secondary">
                            Closes
                            <input
                              type="time"
                              required
                              aria-label={`${label} closes`}
                              value={period.closesAt}
                              onChange={(event) =>
                                update(day.dayOfWeek, (current) => ({
                                  ...current,
                                  periods: current.periods.map((p, i) =>
                                    i === index
                                      ? { ...p, closesAt: event.target.value }
                                      : p,
                                  ),
                                }))
                              }
                              className={`${ADMIN_FIELD_CLASS} min-h-11`}
                            />
                          </label>
                          {isOvernight(period) ? (
                            <span className="pb-3 text-xs text-text-muted">
                              Closes the next day
                            </span>
                          ) : null}
                          {day.periods.length > 1 ? (
                            <Button
                              type="button"
                              variant="secondary"
                              aria-label={`Remove ${label}`}
                              onClick={() =>
                                update(day.dayOfWeek, (current) => ({
                                  ...current,
                                  periods: current.periods.filter(
                                    (_, i) => i !== index,
                                  ),
                                }))
                              }
                            >
                              Remove
                            </Button>
                          ) : null}
                        </div>
                      );
                    })}
                    {canAddPeriod(day) ? (
                      <div>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() =>
                            update(day.dayOfWeek, (current) => ({
                              ...current,
                              periods: [...current.periods, nextPeriod(current)],
                            }))
                          }
                        >
                          Add another period
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-sm text-text-secondary">Closed</p>
                )}
              </fieldset>
            </li>
          );
        })}
      </ul>

      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save opening hours"}
        </Button>
        <ButtonLink href={doneHref} variant="secondary">
          Cancel
        </ButtonLink>
      </div>
    </form>
  );
}
