import {
  campaignApprovalStatusLabel,
  campaignApprovalStatusTone,
  campaignStatusLabel,
  campaignStatusTone,
  formatCampaignDate,
} from "./marketing";

describe("campaignStatusLabel / campaignStatusTone", () => {
  it("labels and tones every status", () => {
    expect(campaignStatusLabel("DRAFT")).toBe("Draft");
    expect(campaignStatusLabel("ACTIVE")).toBe("Active");
    expect(campaignStatusLabel("ENDED")).toBe("Ended");
    expect(campaignStatusTone("DRAFT")).toBe("warning");
    expect(campaignStatusTone("ACTIVE")).toBe("positive");
    expect(campaignStatusTone("ENDED")).toBe("neutral");
  });
});

describe("campaignApprovalStatusLabel / campaignApprovalStatusTone", () => {
  it("labels and tones every approval state", () => {
    expect(campaignApprovalStatusLabel("NONE")).toBe("Not submitted");
    expect(campaignApprovalStatusLabel("PENDING")).toBe("Pending approval");
    expect(campaignApprovalStatusLabel("APPROVED")).toBe("Approved");
    expect(campaignApprovalStatusLabel("REJECTED")).toBe("Rejected");

    expect(campaignApprovalStatusTone("NONE")).toBe("neutral");
    expect(campaignApprovalStatusTone("PENDING")).toBe("warning");
    expect(campaignApprovalStatusTone("APPROVED")).toBe("positive");
    expect(campaignApprovalStatusTone("REJECTED")).toBe("neutral");
  });
});

describe("formatCampaignDate", () => {
  it("formats an ISO date in UTC, and dashes a null", () => {
    expect(formatCampaignDate("2026-10-01T00:00:00.000Z")).toBe("Oct 1, 2026");
    expect(formatCampaignDate(null)).toBe("—");
  });
});
