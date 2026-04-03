import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/bin.ts",
        "src/cli.ts",
        "src/github/index.ts",
        "src/github/client.ts",
        "src/commands/hook-add.ts",
      ],
      thresholds: { lines: 99, functions: 97, branches: 93, statements: 99 },
    },
    pool: "threads",
    maxConcurrency: 10,
    testTimeout: 5_000,
    restoreMocks: true,
  },
});
