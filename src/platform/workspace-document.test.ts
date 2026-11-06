import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../../schema";
import { setMeForTests } from "../../packages/notes-sdk/src/identity";
import { LocalLiveCollection } from "../../packages/notes-sdk/src/live";
import { spaces } from "../../packages/notes-sdk/src/spaces";
import { createPlatformClient } from "./client";
import { REFUSAL_TIMING, WorkspaceDocument, type Refusal } from "./workspace-document";

const NOW = "2026-11-05T00:00:00.000Z";

/** A page record as Notes keeps it. */
function pageRecord(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    id, title_content: [{ text: title }], icon: "", kind: "document",
    created_at: NOW, updated_at: NOW, created_by: "Ada", updated_by: "Ada", ...extra,
  };
}

/** Ada shares a page (in the trash) into a space where Grace may only
 *  view; Grace opens Notes. */
async function viewerWorkspace() {
  setMeForTests("ada");
  const { space } = await spaces.create({ name: "Team" });
  await spaces.members.invite(space.id, "grace", "viewer");
  const shared = await LocalLiveCollection.open(`space:${space.id}|pages`, ["title_content"]);
  await shared.put("shared", pageRecord("shared", "Shared", { share_space_id: space.id, archived: true, archived_at: NOW }));
  setMeForTests("grace");
  const document = await WorkspaceDocument.open(await createPlatformClient());
  return { document, spaceId: space.id };
}

describe("a viewer's changes", () => {
  it("drops a viewer's change to a shared page, and says so", async () => {
    const { document, spaceId } = await viewerWorkspace();
    expect(document.state.pages.shared?.archived).toBe(true);
    const refused: Refusal[] = [];
    document.onRefused((refusal) => refused.push(refusal));
    const before = document.state.pages.shared;
    document.transact([{ type: "delete", path: ["pages", "shared", "archived"] }]);
    expect(document.state.pages.shared).toBe(before);
    expect(refused).toEqual([{ pageId: "shared", reason: "read_only" }]);
    await document.flush();
    const stored = await app.pages.in(spaceId).live();
    expect(stored.get("shared")?.archived).toBe(true);
    await document.close();
  });

  it("tells of a burst of view-only changes to one page once", async () => {
    const { document } = await viewerWorkspace();
    const refused: Refusal[] = [];
    document.onRefused((refusal) => refused.push(refusal));
    for (let index = 0; index < 5; index += 1) document.transact([{ type: "set", path: ["pages", "shared", "icon"], value: `${index}` }]);
    expect(refused).toEqual([{ pageId: "shared", reason: "read_only" }]);
    await document.close();
  });

  it("still writes the member's own pages and settings", async () => {
    const { document } = await viewerWorkspace();
    document.transact([
      { type: "set", path: ["pages", "mine"], value: { ...pageRecord("mine", "Mine"), title: "Mine", parent_id: null, block_tree: { by_id: {} } } },
      { type: "set", path: ["preferences", "theme"], value: "dark" },
    ]);
    expect(document.state.pages.mine?.title).toBe("Mine");
    expect(document.state.preferences.theme).toBe("dark");
    await document.flush();
    expect((await app.pages.live()).get("mine")).toBeDefined();
    await document.close();
  });
});

/** Ada's own Notes, with one page of hers. */
async function ownWorkspace() {
  setMeForTests("ada");
  const document = await WorkspaceDocument.open(await createPlatformClient());
  document.transact([{ type: "set", path: ["pages", "p"], value: { ...pageRecord("p", "Plans"), title: "Plans", parent_id: null, block_tree: { by_id: {} } } }]);
  await document.flush();
  const statuses: string[] = [];
  document.onSyncStatus((status) => statuses.push(status));
  const refusals: Refusal[] = [];
  document.onRefused((refusal) => refusals.push(refusal));
  return { document, statuses, refusals, last: () => statuses[statuses.length - 1] };
}

const refusedOnce = () => vi.spyOn(LocalLiveCollection.prototype, "patch")
  .mockRejectedValueOnce(Object.assign(new Error("no"), { retryable: false }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("refused writes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    REFUSAL_TIMING.quietMs = 5000;
    REFUSAL_TIMING.toastMs = 2000;
  });

  it("reads refused until a later write is stored", async () => {
    const { document, last } = await ownWorkspace();
    refusedOnce();
    document.transact([{ type: "set", path: ["pages", "p", "icon"], value: "🧪" }]);
    await settle();
    expect(last()).toBe("refused");
    document.transact([{ type: "set", path: ["pages", "p", "icon"], value: "📘" }]);
    await document.flush();
    expect(last()).toBe("saved");
    await document.close();
  });

  it("clears refused after quiet seconds", async () => {
    REFUSAL_TIMING.quietMs = 60;
    const { document, last } = await ownWorkspace();
    refusedOnce();
    document.transact([{ type: "set", path: ["pages", "p", "icon"], value: "🧪" }]);
    await settle();
    expect(last()).toBe("refused");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(last()).toBe("saved");
    await document.close();
  });

  it("tells of a burst of refusals on one page once", async () => {
    const { document, refusals } = await ownWorkspace();
    const spy = vi.spyOn(LocalLiveCollection.prototype, "patch");
    for (let index = 0; index < 5; index += 1) spy.mockRejectedValueOnce(Object.assign(new Error("no"), { retryable: false }));
    for (let index = 0; index < 5; index += 1) {
      document.transact([{ type: "set", path: ["pages", "p", "icon"], value: `${index}` }]);
      await settle();
    }
    expect(refusals).toEqual([{ pageId: "p", reason: "refused" }]);
    await document.close();
  });
});
