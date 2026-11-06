import type { JWTVerifyGetKey } from "jose";
import { LOCAL_HOSTS, whoIs, type Person } from "./auth";
import type { Env } from "./env";
import { handleFile } from "./files";
import { accessOf, isMemberRole } from "./sharing";

export { DirectoryDO } from "./directory-do";
export { ScopeDO } from "./scope-do";

/* The Worker: Notes' pages as static assets, and under /api what they ask
   of the server: who is signed in, a scope's sync socket, files, and (with
   SHARING on, spec S5c) spaces and their members. Every /api request names
   a person or is turned away. */

const json = (value: unknown, status = 200) => Response.json(value, { status });

const handleOf = (email: string) => email.split("@")[0] || "me";
const displayNameOf = (handle: string) => handle.charAt(0).toUpperCase() + handle.slice(1);
const sharingOn = (env: Env) => env.SHARING === "on";

/** Whether a browser says the request comes from another site's page. The
 *  Access cookie goes with any request to this host, a socket's too, so only
 *  Notes' own pages (and, on this machine, its dev server) may use it. */
function fromElsewhere(request: Request, url: URL, env: Env): boolean {
  const origin = request.headers.get("Origin");
  if (!origin || origin === url.origin) return false;
  try {
    return !(env.DEV_USER && LOCAL_HOSTS.has(url.hostname) && LOCAL_HOSTS.has(new URL(origin).hostname));
  } catch {
    return true;
  }
}

/** The space a scope belongs to: `space:<id>`, or its files'
 *  `space:<id>|bucket:<name>`. */
const SPACE_SCOPE = /^space:(space_[0-9a-z_-]{1,64})(?:\|bucket:[\w-]{1,64})?$/i;

/** What a person may do with a scope: their own personal one, write; a
 *  space's (sharing on), as their role says; anything else, nothing. */
async function accessTo(person: Person, scope: string, env: Env): Promise<"read" | "write" | null> {
  if (scope === `personal:${person.userId}`) return "write";
  const space = SPACE_SCOPE.exec(scope);
  if (!space || !sharingOn(env)) return null;
  return accessOf(await env.DIRECTORY.getByName("directory").roleIn(space[1], person.userId));
}

const refusal = (answer: { code: string; message: string }) =>
  json({ code: answer.code, message: answer.message }, answer.code === "not_found" ? 404 : answer.code === "bad_request" ? 400 : 403);

/** /api/spaces and /api/people. */
async function handleSharing(request: Request, url: URL, env: Env, person: Person, ctx: ExecutionContext): Promise<Response | null> {
  const directory = env.DIRECTORY.getByName("directory");
  const body = async (): Promise<Record<string, unknown>> =>
    (request.headers.get("Content-Type")?.includes("json") ? await request.json<Record<string, unknown>>().catch(() => ({})) : {});
  const disconnect = (spaceId: string, userId: string, code: number) =>
    ctx.waitUntil(env.SCOPE.getByName(`space:${spaceId}`).disconnect(userId, code).catch(() => undefined));

  if (url.pathname === "/api/people" && request.method === "GET") {
    return json(await directory.search(url.searchParams.get("q") ?? ""));
  }
  if (url.pathname === "/api/spaces") {
    if (request.method === "GET") return json(await directory.spacesOf(person.userId));
    if (request.method === "POST") {
      const { name } = await body();
      return json(await directory.createSpace(person.userId, typeof name === "string" ? name : ""));
    }
    return json({ code: "method_not_allowed" }, 405);
  }

  const route = /^\/api\/spaces\/(space_[0-9a-z_-]{1,64})\/(members|leave)(?:\/(u_[0-9a-f]{16}))?$/i.exec(url.pathname);
  if (!route) return null;
  const [, spaceId, what, userId] = route;

  if (what === "leave" && request.method === "POST" && !userId) {
    const answer = await directory.leave(spaceId, person.userId);
    if (!answer.ok) return refusal(answer);
    disconnect(spaceId, person.userId, 4403);
    return json({ ok: true });
  }
  if (what !== "members") return json({ code: "not_found" }, 404);

  if (!userId && request.method === "GET") {
    if (!(await directory.roleIn(spaceId, person.userId))) return json({ code: "forbidden" }, 403);
    return json(await directory.members(spaceId));
  }
  if (!userId && request.method === "POST") {
    const { handle, role } = await body();
    if (typeof handle !== "string" || !isMemberRole(role)) return json({ code: "bad_request" }, 400);
    const answer = await directory.invite(spaceId, person.userId, handle, role);
    return answer.ok ? json({ created: answer.created }) : refusal(answer);
  }
  if (userId && request.method === "PATCH") {
    const { role } = await body();
    if (!isMemberRole(role)) return json({ code: "bad_request" }, 400);
    const answer = await directory.setRole(spaceId, person.userId, userId, role);
    if (!answer.ok) return refusal(answer);
    // Reconnects, and so opens the space again with what the new role allows.
    disconnect(spaceId, userId, 4000);
    return json({ ok: true });
  }
  if (userId && request.method === "DELETE") {
    const answer = await directory.remove(spaceId, person.userId, userId);
    if (!answer.ok) return refusal(answer);
    disconnect(spaceId, userId, 4403);
    return json({ ok: true });
  }
  return json({ code: "method_not_allowed" }, 405);
}

export function createWorker(options: { keys?: JWTVerifyGetKey } = {}) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

      if (fromElsewhere(request, url, env)) return json({ code: "cross_site" }, 403);
      const person = await whoIs(request, env, options.keys);
      if (!person) return json({ code: "signed_out" }, 401);

      if (url.pathname === "/api/me") {
        const handle = handleOf(person.email);
        const displayName = displayNameOf(handle);
        // Known to others, to be found and invited.
        if (sharingOn(env)) ctx.waitUntil(env.DIRECTORY.getByName("directory").meet({ userId: person.userId, email: person.email, handle, displayName }));
        return json({ id: person.userId, handle, displayName, avatarUrl: null, sharing: sharingOn(env) });
      }

      if (url.pathname === "/api/admin/restore" && request.method === "POST") {
        if (!env.OWNER_EMAIL || person.email !== env.OWNER_EMAIL.trim().toLowerCase()) return json({ code: "forbidden" }, 403);
        const { scope, at } = await request.json<{ scope?: unknown; at?: unknown }>();
        if (typeof scope !== "string" || typeof at !== "number") return json({ code: "bad_request" }, 400);
        const stub = env.SCOPE.getByName(scope);
        const restored = await stub.restoreTo(at);
        if (!restored.ok) return json({ code: "unavailable", reason: restored.reason }, 501);
        await stub.restart().catch(() => undefined);
        return json(restored);
      }

      if (url.pathname === "/api/people" || url.pathname.startsWith("/api/spaces")) {
        if (!sharingOn(env)) return json({ code: "sharing_off" }, 403);
        const answer = await handleSharing(request, url, env, person, ctx);
        if (answer) return answer;
      }

      const sync = /^\/api\/sync\/([^/]+)$/.exec(url.pathname);
      if (sync) {
        const scope = decodeURIComponent(sync[1]);
        const access = await accessTo(person, scope, env);
        if (!access || scope.includes("|")) return json({ code: "forbidden" }, 403);
        if (request.headers.get("Upgrade") !== "websocket") return json({ code: "upgrade_required" }, 426);
        const headers = new Headers(request.headers);
        headers.set("X-Notes-User", person.userId);
        headers.set("X-Notes-Access", access);
        ctx.waitUntil(env.DIRECTORY.getByName("directory").add(scope));
        return env.SCOPE.getByName(scope).fetch(new Request(request, { headers }));
      }

      const file = /^\/api\/files\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (file) {
        const scope = decodeURIComponent(file[1]);
        const access = await accessTo(person, scope, env);
        if (!access) return json({ code: "forbidden" }, 403);
        if (access === "read" && request.method !== "GET" && request.method !== "HEAD") return json({ code: "forbidden" }, 403);
        return handleFile(request, env, scope, decodeURIComponent(file[2]));
      }

      return json({ code: "not_found" }, 404);
    },

    /** Nightly: a backup of every scope the server has seen. */
    async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
      const scopes = await env.DIRECTORY.getByName("directory").list();
      for (const scope of scopes) await env.SCOPE.getByName(scope).backup(scope, controller.scheduledTime);
    },
  } satisfies ExportedHandler<Env>;
}

export default createWorker();
