import {
  OPENING_PERIODS_PER_DAY_MAX,
  WEEKDAY_NAMES,
  type AdminOpeningHours,
  type AdminSetOpeningHoursRequest,
} from "@mocha-house/contracts";

// SC4d — the opening-hours form's working state and its conversion to and
// from the API. A time input can't show 24:00, so "closes at 00:00" in the
// form means midnight (end of the day) and is sent as 24:00; a closing time
// earlier than the opening time runs into the next day.

export interface EditablePeriod {
  opensAt: string;
  closesAt: string;
}

export interface EditableDay {
  dayOfWeek: number;
  open: boolean;
  periods: EditablePeriod[];
}

export const DEFAULT_PERIOD: EditablePeriod = {
  opensAt: "09:00",
  closesAt: "17:00",
};

export function editableWeek(hours: AdminOpeningHours): EditableDay[] {
  return WEEKDAY_NAMES.map((_, index) => {
    const day = hours.days.find((d) => d.dayOfWeek === index + 1);
    const periods = (day?.periods ?? []).map((period) => ({
      opensAt: period.opensAt,
      closesAt: period.closesAt === "24:00" ? "00:00" : period.closesAt,
    }));
    return {
      dayOfWeek: index + 1,
      open: periods.length > 0,
      periods: periods.length > 0 ? periods : [{ ...DEFAULT_PERIOD }],
    };
  });
}

export function toOpeningHoursRequest(
  week: readonly EditableDay[],
): AdminSetOpeningHoursRequest {
  return {
    days: week
      .filter((day) => day.open)
      .map((day) => ({
        dayOfWeek: day.dayOfWeek,
        periods: day.periods.map((period) => ({
          opensAt: period.opensAt,
          closesAt: period.closesAt === "00:00" ? "24:00" : period.closesAt,
        })),
      })),
  };
}

// True when the period runs past midnight into the next day.
export function isOvernight(period: EditablePeriod): boolean {
  return (
    period.closesAt !== "00:00" &&
    period.opensAt !== "" &&
    period.closesAt !== "" &&
    period.closesAt < period.opensAt
  );
}

const toMinutes = (value: string) => {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
};
const toClock = (minutes: number) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(
    minutes % 60,
  ).padStart(2, "0")}`;

// The period "Add another period" starts with: an hour after the day's last
// period closes, for up to four hours (ending by midnight), so a new period
// never starts out overlapping. Falls back to 9:00–17:00 when there is no
// room left that day.
export function nextPeriod(day: EditableDay): EditablePeriod {
  const last = day.periods[day.periods.length - 1];
  if (!last || !/^\d{2}:\d{2}$/.test(last.closesAt) || isOvernight(last)) {
    return { ...DEFAULT_PERIOD };
  }
  const closes = last.closesAt === "00:00" ? 1440 : toMinutes(last.closesAt);
  const opens = closes + 60;
  if (opens >= 1440 - 30) {
    return { ...DEFAULT_PERIOD };
  }
  return {
    opensAt: toClock(opens),
    closesAt: toClock(Math.min(opens + 240, 1440)),
  };
}

export function canAddPeriod(day: EditableDay): boolean {
  return day.periods.length < OPENING_PERIODS_PER_DAY_MAX;
}

// "09:00" -> "9:00 AM"; "24:00" -> "12:00 AM (midnight)".
export function formatClock(value: string): string {
  const [hoursText, minutes] = value.split(":");
  const hours = Number(hoursText);
  if (hours === 24 || (hours === 0 && minutes === "00")) {
    return "midnight";
  }
  const suffix = hours < 12 ? "AM" : "PM";
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${minutes} ${suffix}`;
}

// One line per day for the location page, e.g.
// "Monday: 11:00 AM – 2:00 PM, 5:00 PM – 10:00 PM" or "Tuesday: Closed".
export function openingHoursSummary(hours: AdminOpeningHours): string[] {
  return WEEKDAY_NAMES.map((name, index) => {
    const periods =
      hours.days.find((day) => day.dayOfWeek === index + 1)?.periods ?? [];
    if (periods.length === 0) {
      return `${name}: Closed`;
    }
    return `${name}: ${periods
      .map((period) => {
        const overnight =
          period.closesAt !== "24:00" && period.closesAt < period.opensAt;
        return `${formatClock(period.opensAt)} – ${formatClock(period.closesAt)}${
          overnight ? " (next day)" : ""
        }`;
      })
      .join(", ")}`;
  });
}
