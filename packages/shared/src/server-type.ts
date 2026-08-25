import { z } from "zod";

export const serverTypes = [
  "VANILLA",
  "PAPER",
  "FABRIC",
  "FORGE",
  "NEOFORGE",
] as const;
export const ServerTypeSchema = z.enum(serverTypes);
export type ServerType = z.infer<typeof ServerTypeSchema>;
