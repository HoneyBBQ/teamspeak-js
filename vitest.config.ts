import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
