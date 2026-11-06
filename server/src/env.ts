import type { DirectoryDO } from "./directory-do";
import type { ScopeDO } from "./scope-do";

export interface Env {
  SCOPE: DurableObjectNamespace<ScopeDO>;
  DIRECTORY: DurableObjectNamespace<DirectoryDO>;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  /** The Access team's name: its domain is https://<team>.cloudflareaccess.com. */
  ACCESS_TEAM: string;
  /** The Access application's audience tag. */
  ACCESS_AUD: string;
  /** Who may use the admin restore. */
  OWNER_EMAIL: string;
  /** "on": people may share spaces (spec S5c). Unset: Notes is one person's. */
  SHARING?: string;
  /** Local development only: who `wrangler dev` signs in, on localhost. */
  DEV_USER?: string;
}
