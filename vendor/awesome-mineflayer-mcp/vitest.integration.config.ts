import { defineConfig } from "vitest/config";

// Integration tests (test/integration/*.it.ts) drive the BUILT server against a
// real Minecraft server. Run them with: npm run build && npm run test:integration
// (start a server first: `docker compose up -d`). They are NOT part of `npm test`.
export default defineConfig({
  test: {
    include: ["test/integration/**/*.it.ts"],
    environment: "node",
    testTimeout: 90_000,
    hookTimeout: 45_000,
  },
});
