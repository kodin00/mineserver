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

  it("accepts http URLs for server icon overrides", () => {
    const result = ServerConfigSchema.parse({
      name: "Test",
      serverIconUrl: "https://example.com/server-icon.png",
    });
    expect(result.serverIconUrl).toBe("https://example.com/server-icon.png");
  });

  it("adds migration-safe auto-sleep defaults and validates the idle timeout", () => {
    const existing = ServerConfigSchema.parse({ name: "Existing server" });
    expect(existing.autoSleep).toEqual({ enabled: false, idleMinutes: 10 });
    expect(
      ServerConfigSchema.safeParse({
        name: "Test",
        autoSleep: { enabled: true, idleMinutes: 0 },
      }).success,
    ).toBe(false);
  });

  it("rejects non-URL server icon values", () => {
    const result = ServerConfigSchema.safeParse({
      name: "Test",
      serverIconUrl: "/icon.png",
    });
    expect(result.success).toBe(false);
  });

  it("selects type-aware addon directories", () => {
    expect(addonKind("PAPER")).toBe("plugins");
    expect(addonKind("FORGE")).toBe("mods");
    expect(addonKind("VANILLA")).toBeNull();
  });
});
