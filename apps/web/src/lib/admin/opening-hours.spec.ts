import {
  openingHoursView,
  validateOpeningHours,
  type AdminOpeningHours,
} from "@mocha-house/contracts";
import {
  canAddPeriod,
  editableWeek,
  formatClock,
  isOvernight,
  nextPeriod,
  openingHoursSummary,
  toOpeningHoursRequest,
} from "./opening-hours";

const saved: AdminOpeningHours = openingHoursView(true, [
  { dayOfWeek: 1, opensAtMinute: 660, closesAtMinute: 840 },
  { dayOfWeek: 1, opensAtMinute: 1020, closesAtMinute: 1320 },
  { dayOfWeek: 2, opensAtMinute: 420, closesAtMinute: 1440 },
  { dayOfWeek: 5, opensAtMinute: 1080, closesAtMinute: 120 },
]);

describe("opening-hours form state (SC4d)", () => {
  it("round-trips saved hours through the form, midnight included", () => {
    const week = editableWeek(saved);
    expect(week).toHaveLength(7);
    expect(week[0]).toMatchObject({
      open: true,
      periods: [
        { opensAt: "11:00", closesAt: "14:00" },
        { opensAt: "17:00", closesAt: "22:00" },
      ],
    });
    // 24:00 shows as 00:00 in a time input …
    expect(week[1].periods).toEqual([{ opensAt: "07:00", closesAt: "00:00" }]);
    // … and a closed day is closed, with a starting period ready to use.
    expect(week[2].open).toBe(false);

    const request = toOpeningHoursRequest(week);
    expect(request.days.map((day) => day.dayOfWeek)).toEqual([1, 2, 5]);
    expect(request.days[1].periods).toEqual([
      { opensAt: "07:00", closesAt: "24:00" },
    ]);
    const checked = validateOpeningHours(request);
    expect(checked.ok).toBe(true);
  });

  it("marks periods that run into the next day", () => {
    expect(isOvernight({ opensAt: "18:00", closesAt: "02:00" })).toBe(true);
    expect(isOvernight({ opensAt: "07:00", closesAt: "00:00" })).toBe(false);
    expect(isOvernight({ opensAt: "09:00", closesAt: "17:00" })).toBe(false);
  });

  it("starts an added period after the day's last one, never overlapping", () => {
    const day = (periods: Array<[string, string]>) => ({
      dayOfWeek: 1,
      open: true,
      periods: periods.map(([opensAt, closesAt]) => ({ opensAt, closesAt })),
    });
    expect(nextPeriod(day([["09:00", "17:00"]]))).toEqual({
      opensAt: "18:00",
      closesAt: "22:00",
    });
    expect(nextPeriod(day([["11:00", "21:30"]]))).toEqual({
      opensAt: "22:30",
      closesAt: "00:00",
    });
    // No room left that day, or an overnight period: the plain default.
    expect(nextPeriod(day([["09:00", "00:00"]]))).toEqual({
      opensAt: "09:00",
      closesAt: "17:00",
    });
    expect(nextPeriod(day([["18:00", "02:00"]]))).toEqual({
      opensAt: "09:00",
      closesAt: "17:00",
    });
  });

  it("allows at most four periods a day", () => {
    const day = editableWeek(saved)[0];
    expect(canAddPeriod(day)).toBe(true);
    expect(
      canAddPeriod({ ...day, periods: [...day.periods, ...day.periods] }),
    ).toBe(false);
  });

  it("summarizes the week for the location page", () => {
    expect(formatClock("00:30")).toBe("12:30 AM");
    expect(formatClock("13:05")).toBe("1:05 PM");
    expect(formatClock("24:00")).toBe("midnight");
    expect(openingHoursSummary(saved)).toEqual([
      "Monday: 11:00 AM – 2:00 PM, 5:00 PM – 10:00 PM",
      "Tuesday: 7:00 AM – midnight",
      "Wednesday: Closed",
      "Thursday: Closed",
      "Friday: 6:00 PM – 2:00 AM (next day)",
      "Saturday: Closed",
      "Sunday: Closed",
    ]);
  });
});

describe("shared opening-hours rule", () => {
  const day = (dayOfWeek: number, ...periods: Array<[string, string]>) => ({
    dayOfWeek,
    periods: periods.map(([opensAt, closesAt]) => ({ opensAt, closesAt })),
  });

  it("accepts split, overnight, touching and Sunday-into-Monday periods", () => {
    expect(
      validateOpeningHours({
        days: [
          day(1, ["06:00", "12:00"], ["12:00", "15:00"]),
          day(5, ["18:00", "02:00"]),
          day(6, ["02:00", "10:00"]),
          day(7, ["20:00", "05:59"]),
        ],
      }).ok,
    ).toBe(true);
  });

  it("refuses overlaps, including across midnight and the end of the week", () => {
    const cases = [
      { days: [day(3, ["09:00", "13:00"], ["12:59", "15:00"])] },
      { days: [day(5, ["20:00", "03:00"]), day(6, ["02:59", "10:00"])] },
      { days: [day(7, ["22:00", "06:00"]), day(1, ["05:00", "09:00"])] },
      { days: [day(2, ["00:00", "24:00"]), day(1, ["23:00", "01:00"])] },
    ];
    for (const input of cases) {
      const result = validateOpeningHours(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/overlap/);
    }
  });

  it("refuses malformed times, days and too many periods", () => {
    for (const input of [
      { days: [day(1, ["9:00", "17:00"])] },
      { days: [day(1, ["24:00", "02:00"])] },
      { days: [day(1, ["10:00", "00:00"])] },
      { days: [day(1, ["10:00", "10:00"])] },
      { days: [day(0)] },
      { days: [day(1), day(1)] },
      {
        days: [
          day(
            1,
            ["01:00", "02:00"],
            ["03:00", "04:00"],
            ["05:00", "06:00"],
            ["07:00", "08:00"],
            ["09:00", "10:00"],
          ),
        ],
      },
      { days: "always" },
      null,
    ]) {
      expect(validateOpeningHours(input).ok).toBe(false);
    }
  });
});
