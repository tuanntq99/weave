import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The SDK's tests run against an in-memory IndexedDB.
    setupFiles: ["./packages/notes-sdk/test/setup.ts"],
    // The server's tests run in the Workers runtime: `npm run test:server`.
    exclude: [...configDefaults.exclude, "server/**"],
  },
});
