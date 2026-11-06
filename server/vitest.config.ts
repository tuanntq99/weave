import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { ACCESS_TEAM: "notes-test", ACCESS_AUD: "aud-test", OWNER_EMAIL: "ada@example.com" } },
    }),
  ],
});
