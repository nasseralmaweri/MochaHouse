import {
  APPLICATION_STATUS_OPTIONS,
  applicantName,
  applicationActivityLine,
  applicationStatusLabel,
  applicationStatusTone,
  formatApplicantDate,
  workAuthorizedLabel,
} from "./applicants";

describe("application status", () => {
  it("labels and tones each status", () => {
    expect(applicationStatusLabel("NEW")).toBe("New");
    expect(applicationStatusLabel("REVIEWING")).toBe("Reviewing");
    expect(applicationStatusLabel("CONTACTED")).toBe("Contacted");
    expect(applicationStatusLabel("HIRED")).toBe("Hired");
    expect(applicationStatusLabel("REJECTED")).toBe("Rejected");
    expect(applicationStatusTone("HIRED")).toBe("positive");
    expect(applicationStatusTone("REJECTED")).toBe("neutral");
    expect(applicationStatusTone("NEW")).toBe("warning");
  });

  it("offers every status as a target (no transition graph)", () => {
    expect(APPLICATION_STATUS_OPTIONS.map((o) => o.value)).toEqual([
      "NEW",
      "REVIEWING",
      "CONTACTED",
      "HIRED",
      "REJECTED",
    ]);
  });
});

describe("applicantName", () => {
  it("joins the name and falls back when blank", () => {
    expect(applicantName("Dana", "Rivera")).toBe("Dana Rivera");
    expect(applicantName("  ", "  ")).toBe("Applicant");
  });
});

describe("workAuthorizedLabel", () => {
  it("states the work-authorization answer plainly", () => {
    expect(workAuthorizedLabel(true)).toBe(
      "Legally authorized to work in the U.S.",
    );
    expect(workAuthorizedLabel(false)).toBe(
      "Not legally authorized to work in the U.S.",
    );
  });
});

describe("formatApplicantDate", () => {
  it("formats an ISO date", () => {
    expect(formatApplicantDate("2026-03-15T09:00:00.000Z")).toBe("Mar 15, 2026");
  });
});

describe("applicationActivityLine", () => {
  it("renders the summary, actor and date", () => {
    expect(
      applicationActivityLine({
        id: "a1",
        summary: "Status changed from NEW to REVIEWING",
        actorLabel: "Sam HQ",
        createdAt: "2026-03-15T09:00:00.000Z",
      }),
    ).toBe("Status changed from NEW to REVIEWING by Sam HQ · Mar 15, 2026");
    expect(
      applicationActivityLine({
        id: "a2",
        summary: "Internal note added",
        actorLabel: null,
        createdAt: "2026-03-15T09:00:00.000Z",
      }),
    ).toBe("Internal note added · Mar 15, 2026");
  });
});
