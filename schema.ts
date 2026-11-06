/* What Notes is built on, declared once. Its collections: its records
   (src/platform/records.ts), kept in the member's own scope and, for the
   page trees shared there, in a space's (`scopes`), each with its shape
   (`fields`), which every host checks on every write and from which the
   app's types are read (src/core/types.ts). A field is limited only where
   it says so. A paragraph's words and a page's name are rich text
   (`t.richText()`): they merge character by character when two people type
   in them at once; every other field is written by a patch of the fields
   that changed. the SDK and the sync server
   hold each collection to its definition, so a definition never
   changes in place. The services it uses, each at the version it is built
   against: the web's pictures, and the card brick that reads a YouTube
   video or a post on X (src/features/editor/embed-details.ts). Its
   typefaces are the system's own, which
   every page has (src/platform/fonts.ts). And what agents may use: the
   records they may read (a collection's `agents` word), and the window's
   operations, which agents call in the person's Notes window.

   What it declares — the kinds, the colours, the covers, history's limits —
   the app reads from here. It imports nothing of Notes'.

   The browser (src/main.tsx) imports this file first; a `Plane`
   (src/platform/plane.ts) opens a collection through the handle it answers,
   by name, and a space's records through its `.in(spaceId)`. History is
   bounded by the host's retention. */

import { schema, t } from "@notes/sdk";
import {
  COVER_IDS,
  HISTORY_RETENTION,
  PROPERTY_TYPES,
  SIDEBAR_SORTS,
  SIDEBAR_VIEWS,
  THEMES,
  VIEW_KINDS,
  blockFields,
  databaseId,
  options,
  pageFields,
  pageId,
  paragraph,
  paragraphs,
  settingsFields,
  versionFields,
} from "./schema-fields";

export * from "./schema-fields";

export default schema({
  collections: {
    // A member's own pages, and the page trees shared into a space: the
    // same collections in either scope. Agents read pages and paragraphs as
    // records: a page's record (its id the page's) holds its name, icon,
    // parent and database; a paragraph's, its page, kind and words.
    pages: {
      scopes: ["personal", "space"],
      fields: pageFields,
      agents: "read",
    },
    blocks: {
      scopes: ["personal", "space"],
      fields: blockFields,
      agents: "read",
    },
    // A part of a page's checkpoint (src/platform/history-record.ts).
    versions: {
      scopes: ["personal", "space"],
      fields: versionFields,
      retention: HISTORY_RETENTION,
    },
    // The member's own settings, which nobody else sees: `preferences` and
    // `roots` (the top level's order).
    workspace_settings: {
      fields: settingsFields,
      agents: "read",
    },
  },
  services: {
    /** A post's pictures and a video's still, as bytes (embed-details.ts). */
    web: "@notes/web@0.0.1",
    /** What a card says: a video's title and channel, a post's author,
     *  words and pictures (embed-details.ts). */
    cards: "@notes/web-card-preview@0.0.1",
  },
  /* The window's operations (src/app/commands.ts): what Notes does for
     people, which agents call in the person's Weave window. They see every page the window does — the person's own and
     their spaces' — and change them as the window's own controls do. */
  operations: {
    findPages: {
      runs: "window",
      effect: "read",
      description: "Find pages as ⌘K (Quick Find) does: names that start with the words, then names that contain them, then pages with a line that does (that line comes back as excerpt) — at most 12. Without words, the 8 pages changed last. Never the trash. Each has its id (the page_id of the other commands; open it with open {page: \"/?page=<id>\"}), name, kind and place (the pages above it).",
      input: { query: t.string(200).optional().describe("The words to find.") },
    },
    exportMarkdown: {
      runs: "window",
      effect: "read",
      description: "Read a page as Markdown, as Weave copies it: its paragraphs in order with the blocks shown in it — headings, lists, to-dos, quotes, code, tables, dividers, links and page mentions; pictures and files by name. version_id reads a checkpoint from its history (list_versions) instead. A database's rows are list_rows'.",
      input: { page_id: pageId, version_id: t.id().optional().describe("A checkpoint of the page's, from list_versions.") },
    },
    getBacklinks: {
      runs: "window",
      effect: "read",
      description: "The pages that link to a page, as its Backlinks count them: links from outside the page it lives in only.",
      input: { page_id: pageId },
    },
    listRows: {
      runs: "window",
      effect: "read",
      description: "A database's rows in a view's order: its filter, then its sorts (first key first); rows alike keep the order they were added in. view_id is the database's first view unless said; search keeps rows whose name contains the words. Each row is a page — its id, name, and values by property id (property ids and views are in the database page's record, get_page). Paged: pass next_cursor back as after.",
      input: {
        page_id: databaseId,
        view_id: t.id().optional().describe("One of its views."),
        search: t.string(200).optional().describe("Words a row's name contains."),
        after: t.id().optional().describe("next_cursor of the page before."),
        limit: t.int(1, 100).default(50).describe("At most this many rows."),
      },
    },
    listVersions: {
      runs: "window",
      effect: "read",
      description: "A page's history: the checkpoints kept of it (at most 20, none older than 30 days), oldest first — each with its id, summary, author and time. Read one with export_markdown {version_id}; bring one back with restore_version.",
      input: { page_id: pageId },
    },
    createPage: {
      runs: "window",
      effect: "write",
      description: "Make a page, as New page does: at the top level, inside a page (it lives there, as a file in a folder, and a link to it goes at the end of that page's words; expanded shows it there in place, as a block), or inside a database (a row of it). kind database makes a database whose first view is view (table unless said). title, icon (an emoji) and text (its first paragraph) are optional; add more with import_markdown. The window stays where it is. Answers the new page.",
      input: {
        title: t.string(500).optional().describe("Its name."),
        icon: t.string(64).optional().describe("An emoji."),
        text: t.string(32000).optional().describe("Its first paragraph."),
        parent_id: t.id().optional().describe("The page or database it goes in; left out, the top level."),
        kind: t.choice("document", "database").default("document").describe("A page of words, or a database."),
        view: t.choice(...VIEW_KINDS).optional().describe("A database's first view."),
        expanded: t.bool().optional().describe("Its link in its parent page shows it in place, as a block."),
      },
    },
    updatePage: {
      runs: "window",
      effect: "write",
      description: "Rename or decorate a page: its title (a rename keeps the links on the words it leaves), icon (an emoji; empty for none), cover (one of Weave' gradients; empty for none — it replaces a cover picture), full_width, and font. A database row's values are set with set_row_property.",
      input: {
        page_id: pageId,
        title: t.string(500).optional().describe("Its new name."),
        icon: t.string(64).optional().describe("An emoji, or empty for none."),
        cover: t.choice("", ...COVER_IDS).optional().describe("A gradient, or empty for none."),
        full_width: t.bool().optional().describe("Words across the whole window."),
        font: t.choice("default", "serif", "mono").optional().describe("Its typeface."),
      },
    },
    movePage: {
      runs: "window",
      effect: "write",
      description: "Move a page — its row, and everything in it — as Move to does: under another page (parent_id), or to the top level (top_level). Never into itself or a page inside it, into a database or into the trash; a shared page stays where it is shared, and a page leaves a shared tree only for someone with Full access.",
      input: {
        page_id: pageId,
        parent_id: t.id().optional().describe("The page it goes in."),
        top_level: t.bool().optional().describe("To the top level."),
      },
    },
    duplicatePage: {
      runs: "window",
      effect: "write",
      description: "Copy a page with everything in it, as Duplicate does: named \"<name> (copy)\", its row right after the original's, every page and paragraph under a fresh id; a database row keeps its values. Answers the copy.",
      input: { page_id: pageId },
    },
    archivePage: {
      runs: "window",
      effect: "write",
      description: "Move a page and everything in it to the trash, as Move to trash does: links to it stay, reading as in the trash, and restore_page brings it back.",
      input: { page_id: pageId },
    },
    restorePage: {
      runs: "window",
      effect: "write",
      description: "Bring a page back from the trash, as Restore does: into the page it lived in, or the top level when that is gone. A page in the trash with a page above it comes back with that one.",
      input: { page_id: t.id().describe("The page in the trash.") },
    },
    deletePage: {
      runs: "window",
      effect: "write",
      description: "Delete a page in the trash for good — everything in it and its history — as Delete permanently does. It cannot be undone, so a page not in the trash is refused: archive_page first.",
      input: { page_id: t.id().describe("The page in the trash.") },
    },
    setFavorite: {
      runs: "window",
      effect: "write",
      description: "Star or unstar a page in the person's own Favorites. Nothing on the page changes — it may be shared — and nobody else sees it.",
      input: { page_id: pageId, favorite: t.bool().describe("true to star, false to unstar.") },
    },
    createBlock: {
      runs: "window",
      effect: "write",
      description: "Add a paragraph to a page: its kind (text unless said; headings, todo, bullet, numbered, quote, callout, divider, code, file, embed) with text or content (runs with marks, http(s) or #page links, page and date mentions), checked, language, color, icon, align. target_page_id links a page at the end of its words — alone, the line stands for the page; file shows an existing file paragraph's bytes, and any other kind takes a picture already in Weave at the end of its words (source_file_block_id); embed_url makes a YouTube or X card. At the end unless before_id, after_id or parent_block_id (inside it) says.",
      input: {
        page_id: pageId,
        ...paragraph,
        before_id: t.id().optional().describe("The paragraph it goes before."),
        after_id: t.id().optional().describe("The paragraph it goes after."),
        parent_block_id: t.id().optional().describe("The paragraph or block it goes inside, last."),
      },
    },
    updateBlock: {
      runs: "window",
      effect: "write",
      description: "Change a paragraph — its words (text or content), kind, checked, language, color, icon, link target, file or card — as the editor does. A line holding nothing but a link to a page, or a block shown in place (its id is its page's): expanded true shows the page in place, false folds it into its link; locked keeps it read only there. Its page's name and icon are update_page's.",
      input: {
        page_id: pageId,
        block_id: t.id().describe("The paragraph, or the block shown in place."),
        ...paragraph,
        expanded: t.bool().optional().describe("A sub-page's: shown in place (true) or folded into its row (false)."),
        locked: t.bool().optional().describe("A sub-page shown in place: read only there."),
      },
    },
    deleteBlocks: {
      runs: "window",
      effect: "write",
      description: "Delete paragraphs and everything under them, as Delete does. A block or a sub-page's row among them sends its page to the trash, whole (restore_page brings it back).",
      input: { page_id: pageId, block_ids: paragraphs },
    },
    duplicateBlocks: {
      runs: "window",
      effect: "write",
      description: "Copy paragraphs, with what is under them, right after the last of them — under fresh ids, as Duplicate does. A block shown in place is copied as the page it is; a sub-page's row brings a copy of its page.",
      input: { page_id: pageId, block_ids: paragraphs },
    },
    moveBlocks: {
      runs: "window",
      effect: "write",
      description: "Move paragraphs, with what is under them, above, below or inside another paragraph or block of the page, as dragging them does. Nothing moves into itself.",
      input: {
        page_id: pageId,
        block_ids: paragraphs,
        target_id: t.id().describe("The paragraph they go by."),
        position: t.choice("above", "below", "inside").describe("Where, by the target."),
      },
    },
    groupBlocks: {
      runs: "window",
      effect: "write",
      description: "Make a block of paragraphs, as Turn into block does: the run of them becomes a page of its own, shown in place where they were; title names it. Answers the block's page id.",
      input: { page_id: pageId, block_ids: paragraphs, title: t.string(500).optional().describe("The block's name.") },
    },
    ungroupBlock: {
      runs: "window",
      effect: "write",
      description: "Take a block apart, as Ungroup does: its paragraphs stay where they are, in the page around it, and the block's page goes.",
      input: { page_id: pageId, block_id: t.id().describe("The block shown in place: its page's id.") },
    },
    importMarkdown: {
      runs: "window",
      effect: "write",
      description: "Add Markdown at the end of a page, as pasting it does: headings, lists, to-dos, quotes, code fences, tables, dividers, bold, italic, inline code, strikethrough and links.",
      input: { page_id: pageId, markdown: t.string(100000).describe("The Markdown.") },
    },
    createProperty: {
      runs: "window",
      effect: "write",
      description: "Add a property — a column — to a database, as Add property does: type text, select, status, date, person or image; a name; a Select's options; index places it (0 first). copy_of copies a property instead, its values with it, as Duplicate does.",
      input: {
        page_id: databaseId,
        type: t.choice(...PROPERTY_TYPES).optional().describe("What it holds."),
        name: t.string(200).optional().describe("Its name."),
        options,
        index: t.int(0).optional().describe("Where it goes among the properties; last unless said."),
        copy_of: t.id().optional().describe("A property to copy."),
      },
    },
    updateProperty: {
      runs: "window",
      effect: "write",
      description: "Rename a database property, change its type (values are kept where the new type can hold them, as Change type does), or set a Select's options. The row-name column (property_id name) is only renamed.",
      input: {
        page_id: databaseId,
        property_id: t.id().describe("The property, or name for the row-name column."),
        name: t.string(200).optional().describe("Its new name."),
        type: t.choice(...PROPERTY_TYPES).optional().describe("Its new type."),
        options,
      },
    },
    deleteProperty: {
      runs: "window",
      effect: "write",
      description: "Remove a property from a database, as Delete does: views stop filtering, sorting, grouping or dating by it, and the rows keep their values.",
      input: { page_id: databaseId, property_id: t.id().describe("The property.") },
    },
    setRowProperty: {
      runs: "window",
      effect: "write",
      description: "Set a database row's value: value for text, select (one of its options), status (one of its options), date (YYYY-MM-DD) or person, empty to clear; images (picture paragraph ids, their bytes reused) for an Image property. property_id name renames the row.",
      input: {
        page_id: t.id().describe("The row: a page of the database."),
        property_id: t.id().describe("The property, or name for the row's name."),
        value: t.string(2000).optional().describe("Its value; empty clears it."),
        images: t.list(t.id(), 50).optional().describe("An Image property's pictures: picture paragraphs' ids."),
      },
    },
    createView: {
      runs: "window",
      effect: "write",
      description: "Add a saved view to a database — table, board, list, gallery or calendar (a board or calendar adds the Status or Date property it needs when there is none) — or copy_of a view, filters and all. Answers its id.",
      input: {
        page_id: databaseId,
        kind: t.choice(...VIEW_KINDS).optional().describe("Its layout."),
        name: t.string(200).optional().describe("Its name."),
        copy_of: t.id().optional().describe("A view to copy."),
      },
    },
    updateView: {
      runs: "window",
      effect: "write",
      description: "Change a database view: name; layout (kind); filter (a Select or Status property and a value; empty clears); sorts (property ids, name for the row name, first key first, each once) or sort_property_id with sort_direction; group_by (Status or Select); date_by (a Date, for a calendar); minimal (a table drawn as Markdown); a gallery's card_preview (none, cover, content or an Image property) and card_properties. An empty id clears a setting.",
      input: {
        page_id: databaseId,
        view_id: t.id().describe("The view."),
        name: t.string(200).optional().describe("Its name."),
        kind: t.choice(...VIEW_KINDS).optional().describe("Its layout."),
        filter_property_id: t.string(128).optional().describe("The property it filters by; empty for none."),
        filter_value: t.string(200).optional().describe("The value kept."),
        sort_property_id: t.string(128).optional().describe("One property to sort by; empty for none."),
        sort_direction: t.choice("asc", "desc").default("asc").describe("sort_property_id's direction."),
        sorts: t.list(t.object({ property_id: t.id(), direction: t.choice("asc", "desc").default("asc") }), 20).optional().describe("The sort keys, first key first."),
        group_by: t.string(128).optional().describe("A Status or Select property; empty for none."),
        date_by: t.string(128).optional().describe("A Date property; empty for none."),
        minimal: t.bool().optional().describe("A table drawn as Markdown."),
        card_preview: t.string(128).optional().describe("none, cover, content or an Image property."),
        card_properties: t.list(t.id(), 50).optional().describe("The properties its cards show."),
      },
    },
    deleteView: {
      runs: "window",
      effect: "write",
      description: "Delete a saved view of a database; its last view stays.",
      input: { page_id: databaseId, view_id: t.id().describe("The view.") },
    },
    checkpointPage: {
      runs: "window",
      effect: "write",
      description: "Keep a checkpoint of a page in its history before a larger change, so restore_version can bring it back. Checkpoints close in time coalesce, and an unchanged page adds none. Answers the newest checkpoint's id.",
      input: { page_id: pageId, summary: t.string(200).optional().describe("What it is before.") },
    },
    restoreVersion: {
      runs: "window",
      effect: "write",
      description: "Bring a page back to a checkpoint from its history, as Restore in page history does: what it said then comes back, while where it lives and the space it is shared into stay as they are; what it held until now stays in its history.",
      input: { page_id: pageId, version_id: t.id().describe("The checkpoint, from list_versions.") },
    },
    setPreferences: {
      runs: "window",
      effect: "write",
      description: "Change the person's own Weave settings, which nobody else sees: theme, the page list's view and sort, whether the page list is folded, and the view a database opens on (database_id with view_id).",
      input: {
        theme: t.choice(...THEMES).optional().describe("Its colours."),
        sidebar_view: t.choice(...SIDEBAR_VIEWS).optional().describe("What the page list shows."),
        sidebar_sort: t.choice(...SIDEBAR_SORTS).optional().describe("The page list's order."),
        sidebar_collapsed: t.bool().optional().describe("The page list folded away."),
        database_id: t.id().optional().describe("A database."),
        view_id: t.id().optional().describe("Its view to open on."),
      },
    },
  },
});
