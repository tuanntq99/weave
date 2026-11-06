import { describe, expect, it } from "vitest";
import { files, heldUrlCount } from "../src/files";

describe("files", () => {
  it("writes and reads bytes, the person's own and a space's apart", async () => {
    await files.write("a.txt", new Blob(["mine"], { type: "text/plain" }));
    await files.bucket("page_files").in("s1").write("a.txt", new Blob(["shared"]), { contentType: "text/plain" });
    expect(await (await files.read("a.txt")).text()).toBe("mine");
    expect(await (await files.bucket("page_files").in("s1").read("a.txt")).text()).toBe("shared");
  });

  it("answers not_found for a file that is not there", async () => {
    await expect(files.read("missing")).rejects.toMatchObject({ code: "not_found" });
  });

  it("shares one URL between views and lets it go with the last", async () => {
    await files.write("p.png", new Blob(["x"], { type: "image/png" }));
    const one = files.url("p.png");
    const two = files.url("p.png");
    const url = await one.ready;
    expect(url).toMatch(/^blob:/);
    expect(await two.ready).toBe(url);
    expect(two.url).toBe(url);
    one.release();
    expect(heldUrlCount()).toBe(1);
    two.release();
    two.release();
    expect(heldUrlCount()).toBe(0);
  });
});
