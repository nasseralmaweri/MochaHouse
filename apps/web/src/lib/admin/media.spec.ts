import { formatFileSize, formatMediaDate } from "./media";

describe("formatFileSize", () => {
  it("formats bytes, kilobytes, and megabytes", () => {
    expect(formatFileSize(500)).toBe("500 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("formatMediaDate", () => {
  it("formats an ISO date", () => {
    expect(formatMediaDate("2026-03-15T09:00:00.000Z")).toBe("Mar 15, 2026");
  });
});
