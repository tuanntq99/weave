import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { mayChangeRole, mayInvite, mayLeave, mayRemove, type MemberRole, type Refusal, type Role } from "./sharing";

/* One object, "directory": every scope the server has seen (for the
   nightly backup) and, for sharing (spec S5c), the people who signed in,
   the spaces and who is in each. */

export interface KnownPerson {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: null;
}

export type Answer<T> = ({ ok: true } & T) | ({ ok: false } & Refusal);
type Done = Answer<Record<never, never>>;

const NOT_IN: Refusal = { code: "forbidden", message: "You are not in this space" };

export class DirectoryDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS scopes (scope TEXT PRIMARY KEY, since INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS people (user_id TEXT PRIMARY KEY, email TEXT NOT NULL, handle TEXT NOT NULL, display_name TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS members (space_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (space_id, user_id)) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS members_by_user ON members(user_id);
      `);
    });
  }

  async add(scope: string): Promise<void> {
    this.sql.exec("INSERT OR IGNORE INTO scopes (scope, since) VALUES (?, ?)", scope, Date.now());
  }

  async list(): Promise<string[]> {
    return this.sql.exec<{ scope: string }>("SELECT scope FROM scopes ORDER BY scope").toArray().map((row) => row.scope);
  }

  /* ── People ──────────────────────────────────────────────────────────── */

  /** Someone signed in: known from now on (nothing written once known). */
  async meet(person: { userId: string; email: string; handle: string; displayName: string }): Promise<void> {
    this.sql.exec(
      "INSERT OR IGNORE INTO people (user_id, email, handle, display_name) VALUES (?, ?, ?, ?)",
      person.userId, person.email, person.handle, person.displayName,
    );
  }

  async search(query: string): Promise<KnownPerson[]> {
    const like = `%${query.toLowerCase().replace(/[%_]/g, "")}%`;
    return this.sql.exec<{ user_id: string; handle: string; display_name: string }>(
      "SELECT user_id, handle, display_name FROM people WHERE handle LIKE ? OR email LIKE ? OR lower(display_name) LIKE ? ORDER BY handle LIMIT 10",
      like, like, like,
    ).toArray().map(personOf);
  }

  /** Someone by email, or by handle when only one person has it. */
  private find(who: string): string | null {
    const wanted = who.trim().replace(/^@/, "").toLowerCase();
    const rows = this.sql.exec<{ user_id: string }>(
      wanted.includes("@") ? "SELECT user_id FROM people WHERE email = ?" : "SELECT user_id FROM people WHERE handle = ?", wanted,
    ).toArray();
    return rows.length === 1 ? rows[0].user_id : null;
  }

  /* ── Spaces ──────────────────────────────────────────────────────────── */

  async createSpace(userId: string, name: string): Promise<{ id: string; name: string }> {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const id = `space_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const clean = name.trim().slice(0, 100) || "Untitled space";
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO spaces (id, name, created_at) VALUES (?, ?, ?)", id, clean, Date.now());
      this.sql.exec("INSERT INTO members (space_id, user_id, role) VALUES (?, ?, 'owner')", id, userId);
    });
    return { id, name: clean };
  }

  async spacesOf(userId: string): Promise<Array<{ id: string; name: string; myRole: Role }>> {
    return this.sql.exec<{ id: string; name: string; role: Role }>(
      "SELECT spaces.id, spaces.name, members.role FROM members JOIN spaces ON spaces.id = members.space_id WHERE members.user_id = ? ORDER BY spaces.created_at",
      userId,
    ).toArray().map((row) => ({ id: row.id, name: row.name, myRole: row.role }));
  }

  async roleIn(spaceId: string, userId: string): Promise<Role | null> {
    return this.sql.exec<{ role: Role }>("SELECT role FROM members WHERE space_id = ? AND user_id = ?", spaceId, userId).toArray()[0]?.role ?? null;
  }

  async members(spaceId: string): Promise<Array<KnownPerson & { role: Role }>> {
    return this.sql.exec<{ user_id: string; handle: string | null; display_name: string | null; role: Role }>(
      "SELECT members.user_id, people.handle, people.display_name, members.role FROM members LEFT JOIN people ON people.user_id = members.user_id WHERE members.space_id = ?",
      spaceId,
    ).toArray().map((row) => ({
      ...personOf({ user_id: row.user_id, handle: row.handle ?? row.user_id, display_name: row.display_name ?? row.user_id }),
      role: row.role,
    }));
  }

  async invite(spaceId: string, by: string, who: string, role: MemberRole): Promise<Answer<{ created: boolean }>> {
    const mine = await this.roleIn(spaceId, by);
    if (!mine) return { ok: false, ...NOT_IN };
    const refused = mayInvite(mine, role);
    if (refused) return { ok: false, ...refused };
    const userId = this.find(who);
    if (!userId) return { ok: false, code: "not_found", message: "No one by that name has opened Notes yet" };
    const created = this.sql.exec("INSERT OR IGNORE INTO members (space_id, user_id, role) VALUES (?, ?, ?)", spaceId, userId, role).rowsWritten > 0;
    return { ok: true, created };
  }

  async setRole(spaceId: string, by: string, userId: string, role: MemberRole): Promise<Done> {
    const mine = await this.roleIn(spaceId, by);
    if (!mine) return { ok: false, ...NOT_IN };
    const refused = mayChangeRole(mine, (await this.roleIn(spaceId, userId)) ?? undefined, role);
    if (refused) return { ok: false, ...refused };
    this.sql.exec("UPDATE members SET role = ? WHERE space_id = ? AND user_id = ?", role, spaceId, userId);
    return { ok: true };
  }

  async remove(spaceId: string, by: string, userId: string): Promise<Done> {
    const mine = await this.roleIn(spaceId, by);
    if (!mine) return { ok: false, ...NOT_IN };
    const refused = mayRemove(mine, (await this.roleIn(spaceId, userId)) ?? undefined);
    if (refused) return { ok: false, ...refused };
    this.sql.exec("DELETE FROM members WHERE space_id = ? AND user_id = ?", spaceId, userId);
    return { ok: true };
  }

  async leave(spaceId: string, userId: string): Promise<Done> {
    const mine = await this.roleIn(spaceId, userId);
    if (!mine) return { ok: false, ...NOT_IN };
    const refused = mayLeave(mine);
    if (refused) return { ok: false, ...refused };
    this.sql.exec("DELETE FROM members WHERE space_id = ? AND user_id = ?", spaceId, userId);
    return { ok: true };
  }
}

const personOf = (row: { user_id: string; handle: string; display_name: string }): KnownPerson =>
  ({ id: row.user_id, handle: row.handle, displayName: row.display_name, avatarUrl: null });
