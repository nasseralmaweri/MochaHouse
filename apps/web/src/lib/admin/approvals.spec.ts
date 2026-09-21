import { approvalStatusLabel, approvalStatusTone, formatApprovalDate } from "./approvals";

describe("approvalStatusLabel", () => {
  it("labels every status", () => {
    expect(approvalStatusLabel("PENDING")).toBe("Pending");
    expect(approvalStatusLabel("APPROVED")).toBe("Approved");
    expect(approvalStatusLabel("REJECTED")).toBe("Rejected");
  });
});

describe("approvalStatusTone", () => {
  it("maps status to a badge tone", () => {
    expect(approvalStatusTone("PENDING")).toBe("warning");
    expect(approvalStatusTone("APPROVED")).toBe("positive");
    expect(approvalStatusTone("REJECTED")).toBe("neutral");
  });
});

describe("formatApprovalDate", () => {
  it("formats an ISO date with time", () => {
    expect(formatApprovalDate("2026-03-15T09:05:00.000Z")).toContain("2026");
  });
});
