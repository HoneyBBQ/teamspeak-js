import { resolve } from "node:path";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [
    dts({
      include: ["src"],
      outDir: "dist",
      rollupTypes: false,
    }),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        "crypto/index": resolve(__dirname, "src/crypto/index.ts"),
        "transport/index": resolve(__dirname, "src/transport/index.ts"),
        "discovery/index": resolve(__dirname, "src/discovery/index.ts"),
        "command/index": resolve(__dirname, "src/command/index.ts"),
        "handshake/index": resolve(__dirname, "src/handshake/index.ts"),
      },
      formats: ["es", "cjs"],
      fileName: (format, name) => (format === "es" ? `${name}.mjs` : `${name}.cjs`),
    },
    rolldownOptions: {
      external: [
        "node:crypto",
        "node:dgram",
        "node:net",
        "node:dns",
        "node:dns/promises",
        "node:buffer",
        "node:events",
        /^node:/,
      ],
    },
    target: "node20",
    sourcemap: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
