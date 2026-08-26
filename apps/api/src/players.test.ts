import { describe, expect, it } from "vitest";
import { ServerConfigSchema, PlayerActionSchema } from "@mineserver/shared";
import { instancePaths } from "./compose.js";
import { ComposeManager } from "./docker.js";
import {
  listOnlinePlayers,
  parseOnlinePlayers,
  playerCommand,
  runPlayerAction,
  runWhitelistAction,
  whitelistCommand,
} from "./players.js";

const paths = instancePaths("/tmp/mineserver", "server-id");

class RecordingDocker extends ComposeManager {
  commands: string[] = [];

  constructor(private readonly responses: Array<string | Error>) {
    super();
  }

  override console(_id: string, _paths: typeof paths, command: string) {
    this.commands.push(command);
    const response = this.responses.shift() ?? "";
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve({ stdout: response, stderr: "", code: 0 });
  }
}

describe("Minecraft player list parsing", () => {
  it.each([
    ["There are 0 of a max of 20 players online: ", 0, 20, []],
    ["There are 1 of a max of 20 players online: Steve", 1, 20, ["Steve"]],
    [
      "There are 3 of a max of 100 players online: Steve, Alex_2, player3",
      3,
      100,
      ["Steve", "Alex_2", "player3"],
    ],
    ["There are 2/20 players online: Steve, Alex", 2, 20, ["Steve", "Alex"]],
  ])("parses %s", (output, online, max, names) => {
    expect(parseOnlinePlayers(output, "2026-08-26T12:00:00.000Z")).toEqual({
      online,
      max,
      players: names.map((name) => ({ name })),
      fetchedAt: "2026-08-26T12:00:00.000Z",
    });
  });

  it("ignores Minecraft formatting codes", () => {
    expect(
      parseOnlinePlayers(
        "§aThere are 1 of a max of 20 players online: §fSteve",
        "now",
      ),
    ).toMatchObject({ online: 1, players: [{ name: "Steve" }] });
  });

  it.each([
    "",
    "There are players online",
    "There are 2 of a max of 20 players online: Steve",
    "There are 21 of a max of 20 players online: Steve",
    "There are 1 of a max of 20 players online: Steve has spaces",
  ])("rejects malformed or inconsistent output: %s", (output) => {
    expect(() => parseOnlinePlayers(output)).toThrow(/player list/i);
  });
});

describe("typed player commands", () => {
  it.each([
    [{ action: "kick", player: "Steve" }, "kick Steve"],
    [
      { action: "kick", player: "Steve", reason: "Please reconnect" },
      "kick Steve Please reconnect",
    ],
    [
      { action: "ban", player: "Alex", reason: "Griefing" },
      "ban Alex Griefing",
    ],
    [{ action: "pardon", player: "Alex" }, "pardon Alex"],
    [{ action: "whitelist-add", player: "Alex" }, "whitelist add Alex"],
    [{ action: "whitelist-remove", player: "Alex" }, "whitelist remove Alex"],
    [{ action: "op", player: "Alex" }, "op Alex"],
    [{ action: "deop", player: "Alex" }, "deop Alex"],
  ] as const)("builds the exact command for %o", (input, expected) => {
    expect(playerCommand(PlayerActionSchema.parse(input))).toBe(expected);
  });

  it.each([
    ["on", "whitelist on"],
    ["off", "whitelist off"],
    ["reload", "whitelist reload"],
  ] as const)("builds whitelist %s", (action, expected) => {
    expect(whitelistCommand({ action })).toBe(expected);
  });

  it.each([
    { action: "kick", player: "Steve\nban Alex" },
    { action: "ban", player: "Steve", reason: "bad\nwhitelist off" },
    { action: "ban", player: "Steve", reason: "bad\0op Steve" },
  ])("rejects command injection before construction", (input) => {
    expect(PlayerActionSchema.safeParse(input).success).toBe(false);
  });
});

describe("player service", () => {
  it("lists players through one structured RCON command", async () => {
    const docker = new RecordingDocker([
      "There are 1 of a max of 20 players online: Steve",
    ]);
    await expect(
      listOnlinePlayers(docker, "server-id", paths),
    ).resolves.toMatchObject({
      online: 1,
      players: [{ name: "Steve" }],
    });
    expect(docker.commands).toEqual(["list"]);
  });

  it("runs a player action and refreshes the online list", async () => {
    const docker = new RecordingDocker([
      "Kicked Steve: Please reconnect",
      "There are 0 of a max of 20 players online: ",
    ]);
    await expect(
      runPlayerAction(docker, "server-id", paths, {
        action: "kick",
        player: "Steve",
        reason: "Please reconnect",
      }),
    ).resolves.toMatchObject({
      ok: true,
      output: "Kicked Steve: Please reconnect",
      players: { online: 0 },
    });
    expect(docker.commands).toEqual(["kick Steve Please reconnect", "list"]);
  });

  it("returns action success when only the follow-up list is unavailable", async () => {
    const docker = new RecordingDocker([
      "Made Alex a server operator",
      new Error("RCON connection reset"),
    ]);
    await expect(
      runPlayerAction(docker, "server-id", paths, {
        action: "op",
        player: "Alex",
      }),
    ).resolves.toEqual({
      ok: true,
      output: "Made Alex a server operator",
      players: null,
    });
  });

  it("runs whitelist controls without an unrelated list command", async () => {
    const docker = new RecordingDocker(["Whitelist is now turned on"]);
    await expect(
      runWhitelistAction(docker, "server-id", paths, { action: "on" }),
    ).resolves.toMatchObject({
      ok: true,
      output: "Whitelist is now turned on",
    });
    expect(docker.commands).toEqual(["whitelist on"]);
  });

  it.each([
    "service mc is not running",
    "RCON connection refused",
    "command timed out",
  ])("normalizes unavailable runtime errors: %s", async (message) => {
    const docker = new RecordingDocker([new Error(message)]);
    await expect(
      listOnlinePlayers(docker, "server-id", paths),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/unavailable.*not ready/i),
      statusCode: 503,
    });
  });
});

// Keep the compatibility fields exercised while player membership is no longer
// emitted as Compose desired state.
describe("legacy server player fields", () => {
  it("still reads stored whitelist and operator arrays", () => {
    expect(
      ServerConfigSchema.parse({
        name: "Existing",
        whitelist: ["Steve"],
        operators: ["Alex"],
      }),
    ).toMatchObject({ whitelist: ["Steve"], operators: ["Alex"] });
  });
});
