import { describe, expect, it } from "vitest";
import { formatBytes } from "./api";

describe("formatBytes", () => {
  it("formats file and backup sizes for the panel", () => {
    expect(formatBytes(800)).toBe("800 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
