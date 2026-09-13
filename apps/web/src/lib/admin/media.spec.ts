import { formatFileSize, formatMediaDate, mediaAssetDisplayTitle } from "./media";

describe("mediaAssetDisplayTitle", () => {
  it("prefers the title when set", () => {
    expect(
      mediaAssetDisplayTitle({ title: "Hero background", fileName: "img-1.jpg" }),
    ).toBe("Hero background");
  });

  it("falls back to the filename when title is null or blank", () => {
    expect(mediaAssetDisplayTitle({ title: null, fileName: "img-1.jpg" })).toBe(
      "img-1.jpg",
    );
    expect(mediaAssetDisplayTitle({ title: "   ", fileName: "img-1.jpg" })).toBe(
      "img-1.jpg",
    );
  });
});

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
