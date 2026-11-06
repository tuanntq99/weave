import type { Env as NotesEnv } from "../src/env";

// What `env` from "cloudflare:workers" holds in the tests: the server's bindings.
declare global {
  namespace Cloudflare {
    interface Env extends NotesEnv {}
  }
}
