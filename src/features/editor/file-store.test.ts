import { afterEach, describe, expect, it, vi } from "vitest";

/* Pictures are made smaller in the uploader's browser before they are
   stored: R2's free 10 GB then lasts years (spec S5a). The decoding itself
   (canvas, createImageBitmap) is the browser's, stood in for here. */

const shrunk: Array<{ maxEdge?: number }> = [];
/** How many bytes the stand-in's copies weigh: unset, 100 per pixel of edge. */
let copyBytes: number | null = null;
vi.mock("../../shared/thumbnail", () => ({
  thumbnail: vi.fn(async (_blob: Blob, options: { maxEdge?: number } = {}) => {
    shrunk.push(options);
    // A 4000×3000 photograph, drawn at the edge asked for.
    const edge = options.maxEdge ?? 640;
    return { blob: new Blob([new Uint8Array(copyBytes ?? edge * 100)], { type: "image/webp" }), sourceWidth: 4000, sourceHeight: 3000 };
  }),
}));

const { stageFile } = await import("./file-store");

type Written = { path: string; bytes: Blob; mediaType: string };
function store() {
  const written: Written[] = [];
  return {
    written,
    files: {
      write: vi.fn(async (path: string, bytes: Blob, { mediaType }: { mediaType: string }) => { written.push({ path, bytes, mediaType }); }),
      read: vi.fn(),
      url: vi.fn(),
    } as never,
  };
}

const photo = (bytes: number, name = "holiday.jpg", type = "image/jpeg") => new File([new Uint8Array(bytes)], name, { type });
const place = { pageId: "page_1", owner: "u_ada" };

afterEach(() => {
  shrunk.length = 0;
  copyBytes = null;
});

describe("stageFile", () => {
  it("a heavy photograph is stored as a smaller WebP, its size and name saying so", async () => {
    const { files, written } = store();
    const staged = await stageFile(files, photo(3 * 1024 * 1024), place);
    const stored = await staged.transfer();
    expect(stored).not.toBe(staged.file);
    expect(stored.path).toBe(staged.file.path);
    expect(written[0]).toMatchObject({ path: staged.file.path, mediaType: "image/webp" });
    expect(written[0].bytes.size).toBe(256_000);
    expect(stored).toMatchObject({ type: "image/webp", name: "holiday.webp", size: 256_000, width: 2560, height: 1920 });
    // Its page copy is made from the smaller one.
    expect(shrunk[0]).toMatchObject({ maxEdge: 2560 });
    expect(stored.preview).toBe(`${staged.file.path}.page`);
  });

  it("a light picture is stored as it came", async () => {
    const { files, written } = store();
    const staged = await stageFile(files, photo(200 * 1024), place);
    const stored = await staged.transfer();
    expect(stored).toBe(staged.file);
    expect(written).toHaveLength(1);
    expect(written[0].bytes.size).toBe(200 * 1024);
    expect(shrunk).toEqual([]);
  });

  it("a GIF, an SVG or any other file is never redrawn", async () => {
    for (const [name, type] of [["moving.gif", "image/gif"], ["logo.svg", "image/svg+xml"], ["notes.pdf", "application/pdf"]]) {
      const { files, written } = store();
      const staged = await stageFile(files, photo(3 * 1024 * 1024, name, type), place);
      expect(await staged.transfer()).toBe(staged.file);
      expect(written[0].bytes.size).toBe(3 * 1024 * 1024);
    }
    expect(shrunk).toEqual([]);
  });

  it("a redrawing not a tenth smaller than the picture keeps the picture", async () => {
    copyBytes = 1_500_000;
    const { files, written } = store();
    const staged = await stageFile(files, photo(1_600_000), place);
    await staged.transfer();
    expect(written[0]).toMatchObject({ mediaType: "image/jpeg" });
    expect(written[0].bytes.size).toBe(1_600_000);
  });
});
