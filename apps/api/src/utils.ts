import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return slug || "server";
}

export function safeFilename(input: string): string {
  if (
    !input ||
    input.includes("\0") ||
    input.includes("/") ||
    input.includes("\\")
  ) {
    throw new Error("Invalid file name");
  }
  if (input === "." || input === "..") throw new Error("Invalid file name");
  return input;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`Command timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const result = { stdout, stderr, code: code ?? 1 };
      if (result.code !== 0) {
        reject(
          new Error(
            stderr.trim() ||
              stdout.trim() ||
              `Command exited with ${result.code}`,
          ),
        );
      } else {
        resolve(result);
      }
    });
  });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await import("node:fs/promises").then((fs) => fs.access(path));
    return true;
  } catch {
    return false;
  }
}

/**
 * Joins untrusted segments onto a root and refuses anything that escapes it.
 * Used where a path component comes from a file the operator can edit, such as
 * level-name in server.properties.
 */
export function resolveWithin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  for (const segment of segments) {
    if (
      !segment ||
      segment.includes("\0") ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment === "." ||
      segment === ".."
    ) {
      throw new Error("Invalid path segment");
    }
  }
  const target = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Invalid path segment");
  }
  return target;
}
