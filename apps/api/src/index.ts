import { buildApp, createContext } from "./app.js";
import { config } from "./config.js";

if (
  config.NODE_ENV === "production" &&
  config.ADMIN_PASSWORD === "change-me-now-please"
) {
  throw new Error("Set a strong ADMIN_PASSWORD before starting in production");
}

const app = await buildApp(await createContext());

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.HOST, port: config.PORT });
