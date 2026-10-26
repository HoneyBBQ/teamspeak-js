import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Informational: reported to Codecov, never a threshold.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/*.typetest.ts",
        "**/*.fuzz.test.ts",
        "**/*.integration.test.ts",
        "src/**/testing/**",
        "test/**",
        "scripts/**",
      ],
    },
    projects: [
      {
        test: {
          name: "@honeybbq/teamspeak",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*integration.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["src/**/*integration.test.ts"],
          // Every integration file talks to the same live server, and some of
          // them change server-wide state or are sensitive to its load. Run
          // the files one at a time so no suite depends on another's timing.
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "scripts",
          environment: "node",
          include: ["scripts/**/*.test.ts"],
        },
      },
    ],
  },
});
