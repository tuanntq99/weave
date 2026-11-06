/** A run of rich text, as a record keeps it: words with their marks, or an
 *  embed that counts as one character. */
export type RichTextRun =
  | { text: string; marks?: Record<string, unknown> }
  | { embed: Record<string, unknown>; marks?: Record<string, unknown> };

/** A rich-text field's value: its runs, in order. */
export type RichText = RichTextRun[];

/** A record's value: a JSON object. */
export type Json = Record<string, unknown>;

/** Notes' collections, as every scope keeps them. */
export const COLLECTIONS = ["pages", "blocks", "versions", "workspace_settings"] as const;
export type Collection = (typeof COLLECTIONS)[number];

/** Each collection's rich-text fields: the ones that merge character by
 *  character rather than whole. */
export const RICH_FIELDS: Readonly<Record<Collection, readonly string[]>> = {
  pages: ["title_content"],
  blocks: ["content"],
  versions: [],
  workspace_settings: [],
};
