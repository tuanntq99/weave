/* Whether Notes keeps its data in this browser alone ("local": `vite dev`,
   the tests) or in step with its sync server ("remote": a build to deploy).
   VITE_SYNC chooses; VITE_SYNC_URL names the server, the page's own origin
   unless said. */

export interface SdkConfig {
  mode: "local" | "remote";
  url: string;
}

function initial(): SdkConfig {
  const env = (import.meta as { env?: Record<string, string | boolean | undefined> }).env ?? {};
  const chosen = env.VITE_SYNC === "remote" || env.VITE_SYNC === "local" ? env.VITE_SYNC : env.PROD ? "remote" : "local";
  const origin = typeof location !== "undefined" ? location.origin : "";
  return { mode: chosen, url: typeof env.VITE_SYNC_URL === "string" && env.VITE_SYNC_URL ? env.VITE_SYNC_URL : origin };
}

let config = initial();

export const sdkConfig = (): SdkConfig => config;

export function configureSdk(next: Partial<SdkConfig>): void {
  config = { ...config, ...next };
}

export const isRemote = () => config.mode === "remote";

/** Something the server-backed SDK does not do (yet): sharing, for one. */
export const unavailable = (what: string) => Object.assign(new Error(`${what} is not available yet`), { code: "unavailable", retryable: false });
