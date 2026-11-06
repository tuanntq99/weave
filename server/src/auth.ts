import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "./env";

/* Who is asking. Cloudflare Access stands in front of the whole hostname
   and signs every request it lets through (`Cf-Access-Jwt-Assertion`); the
   Worker checks that signature against the team's keys, its issuer and the
   application's audience, and reads the email. Away from Access — `wrangler
   dev` on this machine — DEV_USER signs someone in, and only there. */

export interface Person {
  email: string;
  userId: string;
}

const remoteKeys = new Map<string, JWTVerifyGetKey>();

function teamKeys(team: string): JWTVerifyGetKey {
  let keys = remoteKeys.get(team);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`));
    remoteKeys.set(team, keys);
  }
  return keys;
}

/** A person's id: the same for an email however it is written. */
export async function userIdOf(email: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `u_${hex.slice(0, 16)}`;
}

export const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** The person Access signed in, or — on this machine, with DEV_USER — the
 *  developer; null for anyone else. */
export async function whoIs(request: Request, env: Env, keys?: JWTVerifyGetKey): Promise<Person | null> {
  const url = new URL(request.url);
  if (env.DEV_USER && LOCAL_HOSTS.has(url.hostname)) {
    const email = `${env.DEV_USER}@dev.local`;
    return { email, userId: await userIdOf(email) };
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.ACCESS_TEAM || !env.ACCESS_AUD) return null;
  try {
    const { payload } = await jwtVerify(token, keys ?? teamKeys(env.ACCESS_TEAM), {
      issuer: `https://${env.ACCESS_TEAM}.cloudflareaccess.com`,
      audience: env.ACCESS_AUD,
    });
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    return email ? { email, userId: await userIdOf(email) } : null;
  } catch {
    return null;
  }
}
