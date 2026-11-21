import { buildApp } from "./app.js";
import { createContext } from "./startup.js";
import { config, DEFAULT_ADMIN_PASSWORD } from "./config.js";

if (config.ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD) {
  console.warn(
    "ADMIN_PASSWORD is the default (123456). If you have not changed it in Account settings yet, do so after signing in.",
  );
}

const { app, jobs } = await buildApp(await createContext());

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  // Let in-flight operations (backup restore, world import, actions) finish
  // their filesystem swaps before exiting; capped so a wedged task can't
  // block shutdown forever.
  await jobs.drain(30_000);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.HOST, port: config.PORT });
