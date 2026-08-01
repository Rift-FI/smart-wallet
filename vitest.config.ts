import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Exclude vendored test files from Solidity contract dependencies
    // (OpenZeppelin contracts ship their hardhat test suite which we
    // mustn't try to run inside vitest).
    exclude: ["node_modules/**", "contracts/**", "dist/**"],
  },
});
