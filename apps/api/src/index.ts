import { buildApp } from "./app.js";
import { createContext } from "./startup.js";
import { config } from "./config.js";

const KNOWN_INSECURE_PASSWORDS = [
  "change-me-now-please",
  // The value shipped in .env.example and documented in the README.
  "mineserver123!",
];

if (
  config.NODE_ENV === "production" &&
  KNOWN_INSECURE_PASSWORDS.includes(config.ADMIN_PASSWORD)
) {
  throw new Error("Set a strong ADMIN_PASSWORD before starting in production");
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
