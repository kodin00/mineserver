import { ServerConfigSchema, type Operation } from "@mineserver/shared";

// Demo data lives only in this page's memory. No request falls through to fetch.
type Role = "admin" | "player";
type DemoRequest = {
  id: string;
  serverId: string;
  items: Array<{ projectId: string; versionId: string; projectType: string }>;
  status: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
const now = "2026-11-01T12:00:00.000Z";
const servers = [
  {
    id: "survival",
    slug: "survival",
    name: "Survival Grove",
    type: "FABRIC" as const,
    state: "running" as const,
    port: 25565,
    address: "play.example.net",
  },
  {
    id: "creative",
    slug: "creative",
    name: "Creative Workshop",
    type: "PAPER" as const,
    state: "stopped" as const,
    port: 25566,
    address: "creative.example.net:25566",
  },
].map(({ name, type, address, ...server }) => ({
  ...server,
  config: ServerConfigSchema.parse({
    name,
    type,
    publicAddress: address,
    port: server.port,
    version: "1.21.4",
  }),
  revision: 1,
  appliedRevision: 1,
  restartRequired: false,
  containerExists: true,
  createdAt: now,
  updatedAt: now,
}));
let role: Role = "admin";
let loggedIn = true;
let nextId = 1;
let playerAccess = { enabled: true, hasPassword: true };
let marketplace = {
  enabled: true,
  contact: "",
  hasToken: false,
  userAgent: "mineserver-demo/1.0",
  tokenUpdatedAt: null as string | null,
  tokenStatus: "unchecked",
};
const requests: DemoRequest[] = [];
const operations: Operation[] = [];
const installed: Array<{
  serverId: string;
  projectId: string;
  versionId: string;
  projectType: string;
}> = [];
const projects = [
  {
    projectId: "ferrite-core",
    slug: "ferrite-core",
    title: "FerriteCore",
    description: "Reduces memory use on the server.",
  },
  {
    projectId: "lithium",
    slug: "lithium",
    title: "Lithium",
    description: "Server optimizations for a more responsive game.",
  },
  {
    projectId: "fabric-api",
    slug: "fabric-api",
    title: "Fabric API",
    description: "Shared building blocks for Fabric mods.",
  },
];

function result(data: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function error(message: string, status = 403): Response {
  return result({ error: message }, status);
}

export async function demoFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const method = (options.method ?? "GET").toUpperCase();
  const url = new URL(path, "https://demo.invalid");
  const body = typeof options.body === "string" ? JSON.parse(options.body) : {};
  if (url.pathname === "/api/auth/login" && method === "POST") {
    role = body.role === "player" ? "player" : "admin";
    loggedIn = true;
    return result({ authenticated: true, csrfToken: "demo", role });
  }
  if (url.pathname === "/api/auth/logout" && method === "POST") {
    loggedIn = false;
    return result(null, 204);
  }
  if (url.pathname === "/api/auth/me" && method === "GET")
    return loggedIn
      ? result({ authenticated: true, csrfToken: "demo", role })
      : error("Sign in to the demo", 401);
  if (!loggedIn) return error("Sign in to the demo", 401);
  if (url.pathname === "/api/servers" && method === "GET")
    return result(servers);
  // In particular POST /api/servers is rejected: this demo cannot create servers.
  if (url.pathname === "/api/servers" && method !== "GET")
    return error("Server creation is unavailable in the demo.");
  if (url.pathname === "/api/metadata" && method === "GET")
    return result({ modrinthEnabled: true, versions: [] });
  if (url.pathname === "/api/auth/player-access" && role === "admin") {
    if (method === "GET") return result(playerAccess);
    if (method === "PUT") {
      playerAccess = {
        enabled: Boolean(body.enabled),
        hasPassword: playerAccess.hasPassword || Boolean(body.password),
      };
      return result(playerAccess);
    }
  }
  if (url.pathname === "/api/settings/marketplace" && role === "admin") {
    if (method === "GET") return result(marketplace);
    if (method === "PUT") {
      marketplace = {
        ...marketplace,
        enabled: Boolean(body.enabled),
        contact: String(body.contact ?? ""),
        ...(body.token !== undefined
          ? {
              hasToken: Boolean(body.token),
              tokenUpdatedAt: body.token ? new Date().toISOString() : null,
            }
          : {}),
      };
      return result(marketplace);
    }
  }
  if (url.pathname === "/api/modrinth/tags" && method === "GET")
    return result({
      categories: [],
      loaders: ["fabric"],
      gameVersions: ["1.21.4"],
    });
  if (url.pathname === "/api/modrinth/search" && method === "GET") {
    const query = (url.searchParams.get("q") ?? "").toLowerCase();
    const supported =
      url.searchParams.get("projectType") === "mod" &&
      url.searchParams.get("serverType") === "FABRIC";
    const hits = projects
      .filter(
        (project) => supported && project.title.toLowerCase().includes(query),
      )
      .map((project) => ({
        ...project,
        author: "Demo catalog",
        projectType: "mod",
        allProjectTypes: ["mod"],
        categories: [],
        displayCategories: [],
        downloads: 120000,
        follows: 1200,
        iconUrl: null,
        dateModified: now,
        license: "MIT",
        clientSide: "optional",
        serverSide: "optional",
        gameVersions: ["1.21.4"],
      }));
    return result({
      hits,
      offset: 0,
      limit: 20,
      totalHits: hits.length,
      gameVersionApplied: true,
      appliedFacets: [],
    });
  }
  const versionMatch = /^\/api\/modrinth\/projects\/([^/]+)\/versions$/.exec(
    url.pathname,
  );
  if (versionMatch && method === "GET") {
    const project = projects.find((item) => item.slug === versionMatch[1]);
    if (!project) return error("Project not found", 404);
    return result({
      versions: [
        {
          id: `${project.projectId}-v1`,
          projectId: project.projectId,
          name: "Demo release",
          versionNumber: "1.0.0",
          versionType: "release",
          loaders: ["fabric"],
          gameVersions: ["1.21.4"],
          datePublished: now,
          downloads: 1000,
          files: [
            {
              url: "https://demo.invalid/file",
              filename: `${project.slug}.jar`,
              primary: true,
              size: 1024,
              sha512: "",
              sha1: null,
            },
          ],
          dependencies: [],
        },
      ],
    });
  }
  const match = /^\/api\/servers\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
  const server = servers.find((s) => s.id === match?.[1]);
  if (!match || !server) return error("Unavailable in the demo.", 404);
  const suffix = match[2] ?? "";
  if (!suffix && method === "GET") return result(server);
  if (!suffix && method === "PUT" && role === "admin") {
    const parsed = ServerConfigSchema.safeParse(body);
    if (!parsed.success) return error("Invalid server settings.", 400);
    const { publicAddress: _old, ...oldSettings } = server.config;
    const { publicAddress: _new, ...newSettings } = parsed.data;
    if (JSON.stringify(oldSettings) !== JSON.stringify(newSettings)) {
      server.revision += 1;
      server.restartRequired = true;
    }
    server.config = parsed.data;
    return result(server);
  }
  if (
    /^actions\/(run|stop|restart|rebuild|apply|pull)$/.test(suffix) &&
    method === "POST" &&
    role === "admin"
  ) {
    if (suffix === "actions/stop") server.state = "stopped";
    if (suffix === "actions/run" || suffix === "actions/restart")
      server.state = "running";
    if (["actions/rebuild", "actions/apply", "actions/pull"].includes(suffix)) {
      server.appliedRevision = server.revision;
      server.restartRequired = false;
    }
    return result({});
  }
  if (suffix === "logs" && method === "GET")
    return result({
      logs: '[12:00:00] [Server thread/INFO]: Done! For help, type "help"',
    });
  if (suffix === "players" && method === "GET")
    return result({
      online: 3,
      max: 20,
      players: [{ name: "Alex" }, { name: "Steve" }, { name: "Sam" }],
      fetchedAt: now,
    });
  if (suffix === "stats" && method === "GET")
    return result({
      cpuPercent: 12,
      memoryUsage: "1.8 GiB",
      memoryPercent: 45,
      players: {
        online: 3,
        max: 20,
        players: [{ name: "Alex" }, { name: "Steve" }, { name: "Sam" }],
        fetchedAt: now,
      },
      uptime: "2 days",
    });
  if ((suffix === "addons" || suffix === "datapacks") && method === "GET")
    return result({
      files: installed
        .filter((item) => item.serverId === server.id)
        .map((item) => ({
          name: `${item.projectId}.jar`,
          size: 1024,
          modifiedAt: now,
          enabled: true,
        })),
    });
  if (suffix === "marketplace/inventory" && method === "GET")
    return result({
      items: installed
        .filter((item) => item.serverId === server.id)
        .map((item) => ({
          provider: "modrinth",
          target: "addons",
          projectType: item.projectType,
          projectId: item.projectId,
          projectTitle:
            projects.find((project) => project.projectId === item.projectId)
              ?.title ?? item.projectId,
          versionId: item.versionId,
          versionNumber: "1.0.0",
          filename: `${item.projectId}.jar`,
          levelName: null,
          enabled: true,
          installedAt: now,
          state: "installed",
          updateCandidate: null,
        })),
    });
  if (suffix === "operations" && method === "GET")
    return result(
      operations.filter((operation) => operation.serverId === server.id),
    );
  if (suffix === "modrinth/install" && method === "POST" && role === "admin") {
    const project = projects.find(
      (entry) => `${entry.projectId}-v1` === body.versionId,
    );
    if (
      !project ||
      server.config.type !== "FABRIC" ||
      body.projectType !== "mod"
    )
      return error("No matching demo project.", 400);
    if (
      !installed.some(
        (item) =>
          item.serverId === server.id && item.projectId === project.projectId,
      )
    ) {
      installed.push({
        serverId: server.id,
        projectId: project.projectId,
        versionId: body.versionId,
        projectType: "mod",
      });
      server.revision += 1;
      server.restartRequired = true;
    }
    const timestamp = new Date().toISOString();
    const operation: Operation = {
      id: `install-${nextId++}`,
      serverId: server.id,
      kind: "modrinth-install",
      status: "succeeded",
      message: `${project.title} installed in the demo.`,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    operations.unshift(operation);
    return result(operation, 202);
  }
  if (suffix === "mod-requests" && method === "GET")
    return result({
      requests: requests.filter((r) => r.serverId === server.id),
    });
  if (
    suffix === "mod-requests" &&
    method === "POST" &&
    role === "player" &&
    Array.isArray(body.items) &&
    body.items.length
  ) {
    const request: DemoRequest = {
      id: String(nextId++),
      serverId: server.id,
      items: body.items.map(
        (item: {
          projectId: string;
          versionId: string;
          projectType: string;
        }) => ({
          ...item,
          title:
            projects.find((project) => project.projectId === item.projectId)
              ?.title ?? item.projectId,
          versionNumber: "1.0.0",
        }),
      ),
      status: "pending",
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    requests.unshift(request);
    return result(request, 201);
  }
  const decision = /^mod-requests\/([^/]+)\/(approve|decline)$/.exec(suffix);
  if (decision && method === "POST" && role === "admin") {
    const request = requests.find(
      (r) => r.id === decision[1] && r.serverId === server.id,
    );
    if (!request || request.status !== "pending")
      return error("Request is no longer pending.", 409);
    request.status = decision[2] === "approve" ? "approved" : "declined";
    request.updatedAt = new Date().toISOString();
    if (decision[2] === "approve") {
      for (const item of request.items)
        installed.push({ serverId: server.id, ...item });
      server.revision += 1;
      server.restartRequired = true;
    }
    return result(request);
  }
  return error("This action is unavailable in the demo.");
}
