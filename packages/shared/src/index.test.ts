import { describe, expect, it } from "vitest";
import { ServerConfigSchema, addonKind, automaticJavaTag } from "./index.js";

describe("automaticJavaTag", () => {
  it.each([
    ["1.16.5", "java8"],
    ["1.17.1", "java16"],
    ["1.20.4", "java17"],
    ["1.20.5", "java21"],
    ["1.21.5", "java21"],
    ["26.1", "java25"],
    ["LATEST", "stable"],
  ])("maps %s to %s", (version, expected) => {
    expect(automaticJavaTag(version)).toBe(expected);
  });
});

describe("server config", () => {
  it("rejects initial memory larger than maximum memory", () => {
    const result = ServerConfigSchema.safeParse({
      name: "Test",
      initMemory: "8G",
      maxMemory: "4G",
    });
    expect(result.success).toBe(false);
  });

  it("selects type-aware addon directories", () => {
    expect(addonKind("PAPER")).toBe("plugins");
    expect(addonKind("FORGE")).toBe("mods");
    expect(addonKind("VANILLA")).toBeNull();
  });
});
