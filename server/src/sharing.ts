/* Who may do what in a space (spec S5c): the rules local mode keeps
   (packages/notes-sdk/src/spaces.ts), on the server. */

export type Role = "owner" | "admin" | "editor" | "viewer";
export type MemberRole = Exclude<Role, "owner">;
export const MEMBER_ROLES: readonly MemberRole[] = ["admin", "editor", "viewer"];

export interface Refusal {
  code: "forbidden" | "bad_request" | "not_found";
  message: string;
}

const refuse = (message: string, code: Refusal["code"] = "forbidden"): Refusal => ({ code, message });
const manages = (role: Role) => role === "owner" || role === "admin";

export const isMemberRole = (value: unknown): value is MemberRole => MEMBER_ROLES.includes(value as MemberRole);

export function mayInvite(mine: Role, role: MemberRole): Refusal | null {
  if (!manages(mine)) return refuse("Only the owner and Full access can invite");
  if (role === "admin" && mine !== "owner") return refuse("Only the owner gives Full access");
  return null;
}

export function mayChangeRole(mine: Role, current: Role | undefined, next: MemberRole): Refusal | null {
  if (!manages(mine)) return refuse("Only the owner and Full access change roles");
  if (!current) return refuse("Not a member", "not_found");
  if (current === "owner") return refuse("The owner keeps their role");
  if ((next === "admin" || current === "admin") && mine !== "owner") return refuse("Only the owner gives or takes Full access");
  return null;
}

export function mayRemove(mine: Role, target: Role | undefined): Refusal | null {
  if (!manages(mine)) return refuse("Only the owner and Full access remove members");
  if (!target) return refuse("Not a member", "not_found");
  if (target === "owner") return refuse("The owner cannot be removed");
  if (target === "admin" && mine !== "owner") return refuse("Only the owner removes Full access");
  return null;
}

export function mayLeave(mine: Role): Refusal | null {
  return mine === "owner" ? refuse("The owner cannot leave their space") : null;
}

/** What a role may do with the space's records and files. */
export const accessOf = (role: Role | null): "read" | "write" | null =>
  role === null ? null : role === "viewer" ? "read" : "write";
