import { createProvider } from "../src/index.mjs";
import { runConformance } from "./conformance.mjs";

const URL = process.env.AGENTQ_TEST_URL ?? "postgres://127.0.0.1:5432/agents_test";
runConformance("postgres", () => createProvider(URL));
