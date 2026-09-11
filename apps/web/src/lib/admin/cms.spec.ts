import { cmsStatusLabel, cmsStatusTone, formatCmsDate } from "./cms";

describe("cmsStatusLabel / cmsStatusTone", () => {
  it("labels a never-published page as Draft — Never published", () => {
    expect(cmsStatusLabel("DRAFT", true)).toBe("Draft — Never published");
    expect(cmsStatusTone("DRAFT", true)).toBe("warning");
  });

  it("labels a published page with no pending edits as Published", () => {
    expect(cmsStatusLabel("PUBLISHED", false)).toBe("Published");
    expect(cmsStatusTone("PUBLISHED", false)).toBe("positive");
  });

  it("labels a published page with a newer draft as Published — Unpublished changes", () => {
    expect(cmsStatusLabel("PUBLISHED", true)).toBe(
      "Published — Unpublished changes",
    );
    expect(cmsStatusTone("PUBLISHED", true)).toBe("warning");
  });
});

describe("formatCmsDate", () => {
  it("formats an ISO date and handles null", () => {
    expect(formatCmsDate("2026-03-15T09:00:00.000Z")).toBe("Mar 15, 2026");
    expect(formatCmsDate(null)).toBe("—");
  });
});
