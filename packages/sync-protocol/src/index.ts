/* @notes/sync-protocol: what a Notes client and its sync server share. */

export { mergePatch, mergeRichText, sameRichText } from "./merge";
export { commitOp, fromWire, mergeOps, toWire, type Op, type WriteBody } from "./ops";
export * from "./messages";
export { validateRecord, type FieldLike, type Validation } from "./validate";
export { COLLECTIONS, RICH_FIELDS, type Collection, type Json, type RichText, type RichTextRun } from "./types";
