import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createWorker } from "../src/worker";

const DAY = 24 * 60 * 60 * 1000;
const NOW = "2026-11-05T00:00:00.000Z";
const page = (id: string) => ({
  id, title_content: [{ text: id }], icon: "", kind: "document",
  created_at: NOW, updated_at: NOW, created_by: "Ada", updated_by: "Ada",
});
let names = 0;
const scopeName = () => `personal:u_maint${(++names).toString().padStart(11, "0")}`;

describe("the nightly alarm", () => {
  it("drops tombstones older than 90 days and moves the horizon", async () => {
    const stub = env.SCOPE.getByName(scopeName());
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("INSERT INTO records (collection, id, value, seq, deleted_at) VALUES ('pages', 'old', NULL, 5, ?)", Date.now() - 91 * DAY);
      sql.exec("INSERT INTO records (collection, id, value, seq, deleted_at) VALUES ('pages', 'recent', NULL, 6, ?)", Date.now() - DAY);
      sql.exec("INSERT INTO meta (key, value) VALUES ('head', '6')");
      await state.storage.setAlarm(Date.now());
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const after = await stub.since(5) as unknown as { reset: boolean };
    expect(after.reset).toBe(true);
    const kept = await stub.since(6) as unknown as { reset: boolean; changes: unknown[] };
    expect(kept.reset).toBe(false);
    await runInDurableObject(stub, async (_instance, state) => {
      const ids = state.storage.sql.exec<{ id: string }>("SELECT id FROM records").toArray().map((row) => row.id);
      expect(ids).toEqual(["recent"]);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("drops applied ops older than 7 days", async () => {
    const stub = env.SCOPE.getByName(scopeName());
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO applied_ops (op_id, seq, value, at) VALUES ('old', 1, NULL, ?), ('new', 2, NULL, ?)", Date.now() - 8 * DAY, Date.now());
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec<{ op_id: string }>("SELECT op_id FROM applied_ops").toArray().map((row) => row.op_id)).toEqual(["new"]);
    });
  });

  it("a first write schedules the alarm", async () => {
    const stub = env.SCOPE.getByName(scopeName());
    await stub.apply({ t: "write", opId: "o1", collection: "pages", id: "p1", action: "put", value: page("p1") });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
    });
  });
});

describe("backups", () => {
  it("the cron writes one backup per scope, in the export format", async () => {
    const scope = scopeName();
    await env.SCOPE.getByName(scope).apply({ t: "write", opId: "o1", collection: "pages", id: "p1", action: "put", value: page("p1") });
    await env.DIRECTORY.getByName("directory").add(scope);
    const ctx = createExecutionContext();
    await createWorker().scheduled(createScheduledController({ scheduledTime: Date.parse("2026-11-06T03:00:00Z"), cron: "0 3 * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    const listed = await env.FILES.list({ prefix: `backups/${scope}/` });
    expect(listed.objects.map((object) => object.key)).toEqual([`backups/${scope}/2026-11-06.json`]);
    const body = await (await env.FILES.get(listed.objects[0].key))!.json() as Record<string, unknown>;
    expect(body).toMatchObject({ format: "notes-backup", version: 1, user: { id: scope.slice("personal:".length) }, files: [], meta: [] });
    expect(body.records).toEqual([{ bucket: `${scope}|pages`, id: "p1", value: page("p1") }]);
  });

  it("keeps the newest 30", async () => {
    const scope = scopeName();
    for (let day = 1; day <= 31; day += 1) await env.FILES.put(`backups/${scope}/2026-10-${String(day).padStart(2, "0")}.json`, "{}");
    await env.SCOPE.getByName(scope).backup(scope, Date.parse("2026-11-06T03:00:00Z"));
    const keys = (await env.FILES.list({ prefix: `backups/${scope}/` })).objects.map((object) => object.key).sort();
    expect(keys).toHaveLength(30);
    expect(keys[0]).toBe(`backups/${scope}/2026-10-03.json`);
    expect(keys[29]).toBe(`backups/${scope}/2026-11-06.json`);
  });
});

describe("restore to a time", () => {
  it("restoreTo asks the storage for a bookmark (local runtime: not implemented)", async () => {
    // Point-in-time recovery exists only on Cloudflare: the local runtime
    // says so. That the call reaches it is what can be checked here; a real
    // restore is tried by hand after the first deploy (README, "Restore").
    const stub = env.SCOPE.getByName(scopeName());
    await stub.apply({ t: "write", opId: "o1", collection: "pages", id: "p1", action: "put", value: page("p1") });
    expect(await stub.restoreTo(Date.now() - 1000)).toMatchObject({ ok: false, reason: expect.stringMatching(/point-in-time recovery/) });
  });

  it("only the owner may ask for it", async () => {
    const response = await createWorker().fetch(new Request("https://localhost/api/admin/restore", {
      method: "POST", body: JSON.stringify({ scope: "personal:u_x", at: Date.now() }),
    }), { ...env, DEV_USER: "grace" }, createExecutionContext());
    expect(response.status).toBe(403);
  });
});
