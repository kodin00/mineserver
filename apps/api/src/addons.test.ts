import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { installJar } from "./addons.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("installJar", () => {
  it("rejects case-insensitive enabled and disabled collisions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mineserver-addons-"));
    roots.push(root);
    const directory = path.join(root, "addons");
    await mkdir(directory);

    for (const existing of ["Example.JAR", "Disabled.JAR.disabled"]) {
      await writeFile(path.join(directory, existing), "manual");
      const staged = path.join(root, `staged-${existing}`);
      await writeFile(staged, "marketplace");
      const requested = existing.replace(/\.disabled$/i, "").toLowerCase();

      await expect(installJar(staged, requested, directory)).rejects.toThrow(
        /already exists/i,
      );
      expect(await readFile(path.join(directory, existing), "utf8")).toBe(
        "manual",
      );
      expect(await readFile(staged, "utf8")).toBe("marketplace");
    }
  });
});
