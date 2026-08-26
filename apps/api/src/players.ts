import type {
  OnlinePlayers,
  PlayerAction,
  PlayerActionResult,
  WhitelistAction,
} from "@mineserver/shared";
import type { InstancePaths } from "./compose.js";
import type { ComposeManager } from "./docker.js";

const listOutputPattern =
  /(?:There are|There is)\s+(\d+)\s+of a max of\s+(\d+)\s+players?\s+online\s*:\s*(.*)$/i;
const alternateListOutputPattern =
  /(?:There are|There is)\s+(\d+)\s*\/\s*(\d+)\s+players?\s+online\s*:\s*(.*)$/i;

export function parseOnlinePlayers(
  output: string,
  fetchedAt = new Date().toISOString(),
): OnlinePlayers {
  const normalized = output.replace(/§[0-9A-FK-OR]/gi, "").trim();
  const match =
    listOutputPattern.exec(normalized) ??
    alternateListOutputPattern.exec(normalized);
  if (!match) {
    throw Object.assign(
      new Error("The server returned an unrecognized player list"),
      {
        statusCode: 502,
      },
    );
  }

  const online = Number.parseInt(match[1]!, 10);
  const max = Number.parseInt(match[2]!, 10);
  const names = match[3]!
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  if (
    !Number.isSafeInteger(online) ||
    !Number.isSafeInteger(max) ||
    online < 0 ||
    max < 0 ||
    online > max ||
    names.length !== online ||
    names.some((name) => !/^[A-Za-z0-9_]{1,16}$/.test(name))
  ) {
    throw Object.assign(
      new Error("The server returned an inconsistent player list"),
      {
        statusCode: 502,
      },
    );
  }

  return {
    online,
    max,
    players: names.map((name) => ({ name })),
    fetchedAt,
  };
}

export function playerCommand(action: PlayerAction): string {
  const suffix = "reason" in action && action.reason ? ` ${action.reason}` : "";
  switch (action.action) {
    case "kick":
      return `kick ${action.player}${suffix}`;
    case "ban":
      return `ban ${action.player}${suffix}`;
    case "pardon":
      return `pardon ${action.player}`;
    case "whitelist-add":
      return `whitelist add ${action.player}`;
    case "whitelist-remove":
      return `whitelist remove ${action.player}`;
    case "op":
      return `op ${action.player}`;
    case "deop":
      return `deop ${action.player}`;
  }
}

export function whitelistCommand(action: WhitelistAction): string {
  return `whitelist ${action.action}`;
}

function rconUnavailable(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /container .* is not running|service .* is not running|no such container|connection refused|connection reset|timed out|timeout|rcon|failed to connect|socket closed/i.test(
      message,
    )
  ) {
    return Object.assign(
      new Error(
        "Player controls are unavailable while the server or RCON is not ready",
      ),
      { statusCode: 503 },
    );
  }
  return error instanceof Error ? error : new Error(message);
}

export async function listOnlinePlayers(
  docker: ComposeManager,
  serverId: string,
  paths: InstancePaths,
): Promise<OnlinePlayers> {
  try {
    const result = await docker.console(serverId, paths, "list");
    return parseOnlinePlayers(result.stdout);
  } catch (error) {
    throw rconUnavailable(error);
  }
}

export async function runPlayerAction(
  docker: ComposeManager,
  serverId: string,
  paths: InstancePaths,
  action: PlayerAction,
): Promise<PlayerActionResult> {
  try {
    const result = await docker.console(serverId, paths, playerCommand(action));
    let players: OnlinePlayers | null = null;
    try {
      players = await listOnlinePlayers(docker, serverId, paths);
    } catch {
      // The action succeeded even if the follow-up list races a restart.
    }
    return { ok: true, output: result.stdout.trim(), players };
  } catch (error) {
    throw rconUnavailable(error);
  }
}

export async function runWhitelistAction(
  docker: ComposeManager,
  serverId: string,
  paths: InstancePaths,
  action: WhitelistAction,
): Promise<PlayerActionResult> {
  try {
    const result = await docker.console(
      serverId,
      paths,
      whitelistCommand(action),
    );
    return {
      ok: true,
      output: result.stdout.trim(),
      players: null,
    };
  } catch (error) {
    throw rconUnavailable(error);
  }
}
