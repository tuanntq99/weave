import type { PageFont } from "../core/types";

/* Notes is set in the system's own typefaces, through the `--notes-font-*`
   variables index.html declares; their stacks end in the system's CJK faces,
   so no family has to be loaded for a page. Kept so the editor's callers
   need not change. */

/** The families a page set in `font` needs: none to load. */
export function loadPageFonts(_font: PageFont, _cjkItalic: boolean): void {}
