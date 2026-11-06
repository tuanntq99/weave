import type { Env } from "./env";

/* File bytes in R2, by scope: `files/<scope>/<path>`. A path is written
   once — the app never changes a file, it makes a new path — so a second
   put of it is taken as done, and what is read may be cached for good. */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

const json = (value: unknown, status: number) => Response.json(value, { status });

export async function handleFile(request: Request, env: Env, scope: string, path: string): Promise<Response> {
  if (!path || path.split("/").some((part) => part === ".." || part === "")) return json({ code: "bad_request" }, 400);
  const key = `files/${scope}/${path}`;

  if (request.method === "PUT") {
    const declared = Number(request.headers.get("Content-Length") ?? "0");
    if (declared > MAX_FILE_BYTES) return json({ code: "too_large" }, 413);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_FILE_BYTES) return json({ code: "too_large" }, 413);
    if (await env.FILES.head(key)) return json({ ok: true }, 200);
    await env.FILES.put(key, bytes, { httpMetadata: { contentType: request.headers.get("Content-Type") ?? "application/octet-stream" } });
    return json({ ok: true }, 200);
  }

  if (request.method === "GET" || request.method === "HEAD") {
    const object = await env.FILES.get(key);
    if (!object) return json({ code: "not_found" }, 404);
    return new Response(request.method === "HEAD" ? null : object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "Cache-Control": "private, max-age=31536000, immutable",
        ETag: object.httpEtag,
      },
    });
  }

  return json({ code: "method_not_allowed" }, 405);
}
