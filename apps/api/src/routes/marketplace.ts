import type { FastifyInstance } from "fastify";
import {
  MarketplaceSettingsSchema,
  ModrinthInstallSchema,
  ModrinthPreviewSchema,
  ModrinthSearchQuerySchema,
  ModrinthUpdateSchema,
  ModrinthVersionQuerySchema,
  composeUserAgent,
  parseSearchCategories,
  supportedMarketplaceTypes,
  type MarketplaceSettings,
} from "@mineserver/shared";
import { listDatapacks, resolveLevelName } from "../datapacks.js";
import { instancePaths } from "../compose.js";
import { config } from "../config.js";
import type { ServerRow } from "../db.js";
import type { AppContext } from "../app.js";
import { requireServer, rowConfig } from "../helpers.js";
import {
  assertInstallable,
  buildPreview,
  buildUpdatePreview,
  marketplaceInventory,
  runInstall,
  runUpdate,
} from "../marketplace.js";

export async function marketplaceRoutes(
  app: FastifyInstance,
  context: AppContext,
): Promise<void> {
  const { store, modrinth, jobs } = context;

  /**
   * Modrinth requires a uniquely identifying User-Agent and recommends contact
   * details so they can reach an operator rather than block their traffic. The
   * project identity comes from the build; only the contact part is editable.
   */
  function marketplaceSettings(
    tokenStatus: MarketplaceSettings["tokenStatus"] = "unchecked",
  ): MarketplaceSettings {
    const row = store.getPanelSettings(config.MODRINTH_ENABLED);
    return {
      enabled: row.modrinth_enabled === 1,
      contact: row.modrinth_contact,
      // The token itself is never returned to a client.
      hasToken: row.modrinth_token !== null && row.modrinth_token !== "",
      userAgent: composeUserAgent(
        config.MODRINTH_USER_AGENT,
        row.modrinth_contact,
      ),
      tokenUpdatedAt: row.modrinth_token_updated_at,
      tokenStatus,
    };
  }

  app.get("/api/settings/marketplace", async () => marketplaceSettings());

  app.put("/api/settings/marketplace", async (request) => {
    const body = MarketplaceSettingsSchema.parse(request.body);
    store.updatePanelSettings({
      enabled: body.enabled,
      contact: body.contact,
      ...(body.token === undefined ? {} : { token: body.token }),
    });
    // A token can change which projects are visible, so cached answers from
    // before the change must not be served afterwards.
    modrinth.invalidate();
    // Tell the operator straight away whether a token they just entered works;
    // Modrinth ignores a bad token on public reads, so it would otherwise look
    // fine while silently doing nothing.
    let tokenStatus: MarketplaceSettings["tokenStatus"] = "unchecked";
    if (marketplaceSettings().enabled) {
      try {
        const valid = await modrinth.checkToken();
        tokenStatus =
          valid === null ? "unchecked" : valid ? "valid" : "invalid";
      } catch {
        tokenStatus = "unreachable";
      }
    }
    return marketplaceSettings(tokenStatus);
  });

  // Browse endpoints are not per-server: the response cache is shared across
  // servers, nothing is mutated, and the UI needs to relax the derived facets.
  // Facets are always built here from validated input; a raw facets parameter
  // is never accepted, or a client could aim arbitrary queries at the shared
  // 300 requests per minute budget.
  function assertMarketplaceEnabled() {
    if (!marketplaceSettings().enabled) {
      throw Object.assign(new Error("The mod marketplace is disabled"), {
        statusCode: 503,
      });
    }
  }

  const idOrSlugPattern = /^[A-Za-z0-9._-]{1,64}$/;
  function marketplaceId(value: string): string {
    const decoded = decodeURIComponent(value);
    if (!idOrSlugPattern.test(decoded)) {
      throw new Error("Invalid marketplace project id");
    }
    return decoded;
  }

  app.get(
    "/api/modrinth/tags",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async () => {
      assertMarketplaceEnabled();
      return modrinth.tags();
    },
  );

  app.get<{ Querystring: Record<string, string> }>(
    "/api/modrinth/search",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      assertMarketplaceEnabled();
      const query = ModrinthSearchQuerySchema.parse(request.query);
      if (
        !supportedMarketplaceTypes(query.serverType).includes(query.projectType)
      ) {
        throw new Error(
          `A ${query.serverType} server cannot use ${query.projectType} content`,
        );
      }
      return modrinth.search({
        query: query.q,
        serverType: query.serverType,
        gameVersion: query.gameVersion,
        projectType: query.projectType,
        categories: parseSearchCategories(query.categories),
        sort: query.sort,
        limit: query.limit,
        offset: query.offset,
      });
    },
  );

  app.get<{
    Params: { idOrSlug: string };
    Querystring: Record<string, string>;
  }>(
    "/api/modrinth/projects/:idOrSlug/versions",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      assertMarketplaceEnabled();
      const query = ModrinthVersionQuerySchema.parse(request.query);
      const versions = await modrinth.listVersions({
        idOrSlug: marketplaceId(request.params.idOrSlug),
        serverType: query.serverType,
        gameVersion: query.gameVersion,
        projectType: query.projectType,
      });
      return { versions: versions.slice(0, query.limit) };
    },
  );

  function marketplaceContext(row: ServerRow) {
    return {
      store,
      modrinth,
      serverId: row.id,
      serverConfig: rowConfig(row),
      paths: instancePaths(config.instancesRoot, row.id),
    };
  }

  // Datapacks live under the world directory, not in addons/, so the add-ons
  // listing cannot see them. Without this the UI has no way to know a datapack
  // is already installed.
  app.get<{ Params: { id: string } }>(
    "/api/servers/:id/datapacks",
    async (request) => {
      const row = requireServer(store, request.params.id);
      const paths = instancePaths(config.instancesRoot, row.id);
      const levelName = await resolveLevelName(paths.data, rowConfig(row));
      return { levelName, files: await listDatapacks(paths.data, levelName) };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/servers/:id/modrinth/preview",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      assertMarketplaceEnabled();
      const row = requireServer(store, request.params.id);
      const body = ModrinthPreviewSchema.parse(request.body);
      return buildPreview(marketplaceContext(row), body);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/servers/:id/modrinth/install",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      assertMarketplaceEnabled();
      const row = requireServer(store, request.params.id);
      const body = ModrinthInstallSchema.parse(request.body);
      // Reject an impossible target synchronously. Doing this only inside the
      // job would answer 202 and then fail, which reads as a broken install
      // rather than a request the panel was never able to honour.
      assertInstallable(rowConfig(row), body.projectType);
      // Download time is unbounded, so this follows the same 202 + operation
      // shape as a backup restore.
      const operation = jobs.runExclusive(row.id, "marketplace-install", () =>
        runInstall(marketplaceContext(row), body),
      );
      return reply.code(202).send(operation);
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { checkUpdates?: string };
  }>("/api/servers/:id/marketplace/inventory", async (request) => {
    assertMarketplaceEnabled();
    const row = requireServer(store, request.params.id);
    return {
      items: await marketplaceInventory(
        marketplaceContext(row),
        request.query.checkUpdates === "true",
      ),
    };
  });

  app.post<{ Params: { id: string } }>(
    "/api/servers/:id/modrinth/update/preview",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      assertMarketplaceEnabled();
      const row = requireServer(store, request.params.id);
      const body = ModrinthUpdateSchema.parse(request.body);
      return buildUpdatePreview(marketplaceContext(row), body);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/servers/:id/modrinth/update",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      assertMarketplaceEnabled();
      const row = requireServer(store, request.params.id);
      const body = ModrinthUpdateSchema.parse(request.body);
      await buildUpdatePreview(marketplaceContext(row), body);
      const operation = jobs.runExclusive(row.id, "marketplace-update", () =>
        runUpdate(marketplaceContext(row), body),
      );
      return reply.code(202).send(operation);
    },
  );
}
