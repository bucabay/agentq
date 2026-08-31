import { assertProvider } from "./provider.mjs";
import { createPostgresProvider } from "./providers/postgres.mjs";

export const DEFAULT_URL = process.env.AGENTQ_URL ?? "postgres://127.0.0.1:5432/agents";

/**
 * Picks a provider from the connection URL scheme. No config file, no registry, no plugin loader —
 * the URL you already have to supply is the whole selection mechanism.
 */
export function createProvider(url = DEFAULT_URL) {
  const scheme = String(url).split(":")[0];

  switch (scheme) {
    case "postgres":
    case "postgresql":
      return assertProvider(createPostgresProvider(url), "postgres");

    case "redis":
    case "rediss":
      throw new Error(
        "redis provider is not implemented. See docs/queue-backend.md for why Postgres is the " +
        "choice at agent-run scale, and what would have to change for Redis to be worth it.",
      );

    default:
      throw new Error(`unsupported queue URL scheme "${scheme}:" — expected postgres:`);
  }
}

export { assertProvider, PROVIDER_METHODS } from "./provider.mjs";
