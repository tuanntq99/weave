import react from "@vitejs/plugin-react";
import { readdirSync, readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import { serviceWorkerSource } from "./src/pwa/build-sw";

/** Writes sw.js beside the build: the service worker of src/pwa, given
 *  every file the build made (and public/'s) to keep (spec S5b). */
function pwa(): Plugin {
  return {
    name: "notes-pwa",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const template = readFileSync(new URL("./src/pwa/service-worker.js", import.meta.url), "utf8");
      const files = [...Object.keys(bundle), ...readdirSync(new URL("./public", import.meta.url))];
      this.emitFile({ type: "asset", fileName: "sw.js", source: serviceWorkerSource(template, files) });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), pwa()],
});
