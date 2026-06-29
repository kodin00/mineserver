import path from "node:path";
import { describe, expect, it } from "vitest";
import { ServerConfigSchema } from "@mineserver/shared";
import { environmentFor, instancePaths, renderCompose } from "./compose.js";

const base = ServerConfigSchema.parse({
  name: "Test",
  type: "PAPER",
  port: 25565,
});

describe("compose generation", () => {
  it("keeps reserved environment values controlled by the panel", () => {
    const environment = environmentFor({
      ...base,
      advancedEnv: { EULA: "FALSE", SPAWN_PROTECTION: "0" },
    });
    expect(environment.EULA).toBe("TRUE");
    expect(environment.SPAWN_PROTECTION).toBe("0");
  });

  it("mounts Paper uploads as plugins and does not expose RCON", () => {
    const paths = instancePaths("/opt/mineserver/instances", "abc");
    const output = renderCompose("abc", base, paths, "UTC");
    expect(output).toContain(`${path.join(paths.root, "addons")}:/plugins:ro`);
    expect(output).not.toContain("25575:");
    expect(output).toContain("RCON_PASSWORD_FILE");
    expect(output).toContain("mem_limit: 5120M");
  });
});
