import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Exclude vendored test files from Solidity contract dependencies
    // (OpenZeppelin contracts ship their hardhat test suite which we
    // mustn't try to run inside vitest).
    exclude: ["node_modules/**", "contracts/**", "dist/**"],
    // Fork integration tests (anvil, ANVIL_RPC_URL) mine real txs from one
    // relayer account: generous timeouts, one file at a time.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    globalSetup: ["src/testing/globalSetup.ts"],
  },
});
