import { describe, expect, it } from "vitest";
import {
  PlayerActionSchema,
  ServerConfigSchema,
  ServerFileCreateSchema,
  ServerFileMoveSchema,
  WorldImportSchema,
  addonKind,
  automaticJavaTag,
} from "./index.js";

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

describe("administration contracts", () => {
  it("accepts supported player actions and rejects command injection", () => {
    expect(
      PlayerActionSchema.parse({
        action: "ban",
        player: "Example_1",
        reason: "Repeated griefing",
      }),
    ).toMatchObject({ action: "ban", player: "Example_1" });
    expect(
      PlayerActionSchema.safeParse({
        action: "kick",
        player: "Example_1",
        reason: "first line\nstop",
      }).success,
    ).toBe(false);
    expect(
      PlayerActionSchema.safeParse({ action: "op", player: "name with spaces" })
        .success,
    ).toBe(false);
  });

  it("validates file mutations without allowing root or traversal targets", () => {
    expect(
      ServerFileCreateSchema.parse({
        parentPath: "config",
        name: "settings.toml",
        type: "file",
      }),
    ).toMatchObject({ parentPath: "config", name: "settings.toml" });
    expect(
      ServerFileCreateSchema.safeParse({
        parentPath: "config/../outside",
        name: "bad.txt",
        type: "file",
      }).success,
    ).toBe(false);
    expect(
      ServerFileMoveSchema.safeParse({ path: "", destinationPath: "target" })
        .success,
    ).toBe(false);
    expect(
      ServerFileMoveSchema.safeParse({
        path: "config/a",
        destinationPath: "config/a",
      }).success,
    ).toBe(false);
  });

  it("requires an explicit active-world acknowledgement for import", () => {
    expect(
      WorldImportSchema.parse({
        acknowledgeLevelName: "survival world",
        overwrite: true,
      }),
    ).toEqual({ acknowledgeLevelName: "survival world", overwrite: true });
    expect(
      WorldImportSchema.safeParse({
        acknowledgeLevelName: "world",
        overwrite: false,
      }).success,
    ).toBe(false);
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
