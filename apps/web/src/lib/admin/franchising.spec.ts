import {
  INQUIRY_STATUS_OPTIONS,
  formatInquiryDate,
  inquiryActivityLine,
  inquiryStatusLabel,
  inquiryStatusTone,
  prospectName,
} from "./franchising";

describe("inquiry status", () => {
  it("labels and tones each status", () => {
    expect(inquiryStatusLabel("NEW")).toBe("New");
    expect(inquiryStatusLabel("REVIEWING")).toBe("Reviewing");
    expect(inquiryStatusLabel("CONTACTED")).toBe("Contacted");
    expect(inquiryStatusLabel("QUALIFIED")).toBe("Qualified");
    expect(inquiryStatusLabel("CLOSED")).toBe("Closed");
    expect(inquiryStatusTone("QUALIFIED")).toBe("positive");
    expect(inquiryStatusTone("CLOSED")).toBe("neutral");
    expect(inquiryStatusTone("NEW")).toBe("warning");
  });

  it("offers every status as a target (no transition graph)", () => {
    expect(INQUIRY_STATUS_OPTIONS.map((o) => o.value)).toEqual([
      "NEW",
      "REVIEWING",
      "CONTACTED",
      "QUALIFIED",
      "CLOSED",
    ]);
  });
});

describe("prospectName", () => {
  it("joins the name and falls back when blank", () => {
    expect(prospectName("Jordan", "Lee")).toBe("Jordan Lee");
    expect(prospectName("  ", "  ")).toBe("Prospect");
  });
});

describe("formatInquiryDate", () => {
  it("formats an ISO date", () => {
    expect(formatInquiryDate("2026-03-15T09:00:00.000Z")).toBe("Mar 15, 2026");
  });
});

describe("inquiryActivityLine", () => {
  it("renders the summary, actor and date", () => {
    expect(
      inquiryActivityLine({
        id: "a1",
        summary: "Status changed from NEW to REVIEWING",
        actorLabel: "Sam HQ",
        createdAt: "2026-03-15T09:00:00.000Z",
      }),
    ).toBe("Status changed from NEW to REVIEWING by Sam HQ · Mar 15, 2026");
    expect(
      inquiryActivityLine({
        id: "a2",
        summary: "Internal note added",
        actorLabel: null,
        createdAt: "2026-03-15T09:00:00.000Z",
      }),
    ).toBe("Internal note added · Mar 15, 2026");
  });
});
