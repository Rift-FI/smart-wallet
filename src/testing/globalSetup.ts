/**
 * vitest globalSetup: probe the anvil fork once so integration suites can
 * `describe.skipIf(!up)` synchronously (no top-level await under CJS).
 */
import { forkAvailable } from "./fork";

export default async function setup(): Promise<void> {
  const up = await forkAvailable();
  process.env.FORK_AVAILABLE = up ? "1" : "0";
  if (!up) console.warn(`[fork] anvil not reachable at ${process.env.ANVIL_RPC_URL || "http://127.0.0.1:8546"} — fork integration tests will be skipped`);
}
