import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../../../schema";
import { embedFromUrl } from "../../core/embeds";
import { publicPicture, readEmbedDetails } from "./embed-details";

const video = (id: string) => embedFromUrl(`https://www.youtube.com/watch?v=${id}`)!;
const found = (title: string) => ({ status: "found", youtube: { title, author: "Someone" } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readEmbedDetails", () => {
  it("asks again after a failure, at most once a minute", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const call = vi.spyOn(app.cards, "call")
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce(found("Back again"));
    const embed = video("aaaaaaaaaa1");
    expect(await readEmbedDetails(embed)).toBeNull();
    now += 1_000;
    expect(await readEmbedDetails(embed)).toBeNull();
    expect(call).toHaveBeenCalledTimes(1);
    now += 60_000;
    const read = await readEmbedDetails(embed);
    expect(call).toHaveBeenCalledTimes(2);
    expect(read && "title" in read ? read.title : undefined).toBe("Back again");
  });

  it("keeps a successful answer for the session", async () => {
    const call = vi.spyOn(app.cards, "call").mockResolvedValue(found("Once"));
    const embed = video("aaaaaaaaaa2");
    await readEmbedDetails(embed);
    await readEmbedDetails(embed);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("does not leave a rejection unhandled", async () => {
    vi.spyOn(app.cards, "call").mockRejectedValue(new Error("down"));
    await expect(readEmbedDetails(video("aaaaaaaaaa3"))).resolves.toBeNull();
  });
});

describe("publicPicture", () => {
  it("lets a picture's URL go with its last view", async () => {
    vi.spyOn(app.web, "request").mockResolvedValue({ status: 200, contentType: "image/png", bodyBase64: btoa("png") });
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const one = await publicPicture("https://pbs.twimg.com/media/one.png");
    const two = await publicPicture("https://pbs.twimg.com/media/one.png");
    expect(one.url).toMatch(/^blob:/);
    expect(two.url).toBe(one.url);
    one.release();
    expect(revoke).not.toHaveBeenCalled();
    two.release();
    two.release();
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
