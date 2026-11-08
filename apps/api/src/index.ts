import { buildApp, createContext } from "./app.js";
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

const app = await buildApp(await createContext());

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.HOST, port: config.PORT });
