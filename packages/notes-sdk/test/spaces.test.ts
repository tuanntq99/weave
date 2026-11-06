import { describe, expect, it } from "vitest";
import { setMeForTests } from "../src/identity";
import { people_, spaces } from "../src/spaces";

describe("spaces", () => {
  it("makes a space its maker owns, invites someone in, and lists them", async () => {
    const { space } = await spaces.create({ name: "Team" });
    expect(space.myRole).toBe("owner");
    expect(space.capabilities).toEqual({ canInvite: true, canManageRoles: true, canRemoveMembers: true, canLeave: false });
    expect(await spaces.members.invite(space.id, "@Grace", "editor")).toEqual({ created: true });
    expect(await spaces.members.invite(space.id, "grace", "editor")).toEqual({ created: false });
    const members = await spaces.members.list(space.id);
    expect(members.map((member) => [member.handle, member.role])).toEqual([["ada", "owner"], ["grace", "editor"]]);

    setMeForTests("grace");
    const mine = await spaces.list();
    expect(mine.map((item) => [item.name, item.myRole, item.capabilities.canInvite])).toEqual([["Team", "editor", false]]);
    await expect(spaces.members.invite(space.id, "bob", "viewer")).rejects.toMatchObject({ code: "forbidden" });
    await spaces.leave(space.id);
    expect(await spaces.list()).toEqual([]);
  });

  it("keeps Full access the owner's to give, and the owner in their space", async () => {
    const { space } = await spaces.create({ name: "Team" });
    await spaces.members.invite(space.id, "grace", "admin");
    await spaces.members.invite(space.id, "bob", "editor");
    setMeForTests("grace");
    await expect(spaces.members.update(space.id, "u_bob", "admin")).rejects.toMatchObject({ code: "forbidden" });
    await spaces.members.update(space.id, "u_bob", "viewer");
    await expect(spaces.members.remove(space.id, "u_ada")).rejects.toMatchObject({ code: "forbidden" });
    setMeForTests("ada");
    await expect(spaces.leave(space.id)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("tells a live list when the spaces change", async () => {
    const live = await spaces.live();
    const seen: number[] = [];
    live.subscribe((list) => seen.push(list.length));
    await spaces.create({ name: "One" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual([0, 1]);
    await live.close();
  });

  it("finds people the browser knows, and offers a handle not seen yet", async () => {
    const { space } = await spaces.create({ name: "Team" });
    await spaces.members.invite(space.id, "grace", "editor");
    expect((await people_.search("gra")).map((person) => person.handle)).toEqual(["grace", "gra"]);
    expect(await people_.search("  ")).toEqual([]);
  });
});
