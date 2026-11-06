import type { RichText, RichTextRun } from "./types";

/* How writes meet what is already stored.

   A patch is a JSON Merge Patch (RFC 7396): a field set to null goes, an
   object merges into an object, anything else replaces.

   A rich-text field merges character by character, three ways: the runs the
   writer started from (`base`), what is stored now (`current`) and what the
   writer wants (`next`). Each side's change is the one stretch that differs
   from the base (a common prefix and suffix around it); two changes in
   different places are both kept, and two in the same place keep the
   writer's. That is not a CRDT, but it is what two people typing in one
   paragraph need: neither loses their words. */

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return structuredClone(patch);
  const result: Record<string, unknown> = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else if (value === undefined) continue;
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

/** One character of rich text: a code unit of words with its marks, or an
 *  embed. */
interface Unit {
  text: string;
  embed?: Record<string, unknown>;
  marks?: Record<string, unknown>;
  key: string;
}

function unitsOf(runs: unknown): Unit[] {
  if (!Array.isArray(runs)) return [];
  const units: Unit[] = [];
  for (const run of runs as RichTextRun[]) {
    if (!isObject(run)) continue;
    const marks = isObject(run.marks) ? run.marks : undefined;
    const marksKey = marks ? JSON.stringify(marks) : "";
    if ("embed" in run && isObject(run.embed)) {
      units.push({ text: "", embed: run.embed, marks, key: `e${JSON.stringify(run.embed)}|${marksKey}` });
    } else if ("text" in run && typeof run.text === "string") {
      // Whole code points, so a pair is never split between two changes.
      for (const char of run.text) units.push({ text: char, marks, key: `t${char}|${marksKey}` });
    }
  }
  return units;
}

function runsOf(units: Unit[]): RichText {
  const runs: RichText = [];
  let open: { text: string; marks?: Record<string, unknown>; marksKey: string } | null = null;
  const close = () => {
    if (open) runs.push(open.marks ? { text: open.text, marks: open.marks } : { text: open.text });
    open = null;
  };
  for (const unit of units) {
    if (unit.embed) {
      close();
      runs.push(unit.marks ? { embed: unit.embed, marks: unit.marks } : { embed: unit.embed });
      continue;
    }
    const marksKey = unit.marks ? JSON.stringify(unit.marks) : "";
    if (open && open.marksKey === marksKey) open.text += unit.text;
    else {
      close();
      open = { text: unit.text, marks: unit.marks, marksKey };
    }
  }
  close();
  return runs;
}

interface Change {
  start: number;
  /** Where the changed stretch ends in the base. */
  end: number;
  inserted: Unit[];
}

function changeFrom(base: Unit[], next: Unit[]): Change | null {
  let start = 0;
  while (start < base.length && start < next.length && base[start].key === next[start].key) start += 1;
  if (start === base.length && start === next.length) return null;
  let tail = 0;
  while (
    tail < base.length - start && tail < next.length - start
    && base[base.length - 1 - tail].key === next[next.length - 1 - tail].key
  ) tail += 1;
  return { start, end: base.length - tail, inserted: next.slice(start, next.length - tail) };
}

/** `next` merged with whatever reached `current` since `base`. */
export function mergeRichText(base: unknown, current: unknown, next: unknown): RichText {
  const b = unitsOf(base);
  const c = unitsOf(current);
  const n = unitsOf(next);
  const ours = changeFrom(b, n);
  const theirs = changeFrom(b, c);
  if (!ours) return runsOf(c);
  if (!theirs) return runsOf(n);
  // Changes that only touch at an edge are apart; two insertions at one
  // place are both kept, theirs first.
  const apart = ours.end <= theirs.start || theirs.end <= ours.start;
  if (!apart) return runsOf(n);
  const [first, second] = ours.start < theirs.start || (ours.start === theirs.start && theirs.start !== theirs.end)
    ? [ours, theirs] : [theirs, ours];
  const merged = [
    ...b.slice(0, first.start),
    ...first.inserted,
    ...b.slice(first.end, second.start),
    ...second.inserted,
    ...b.slice(second.end),
  ];
  return runsOf(merged);
}

/** Whether two rich-text values hold the same words and marks, however
 *  they are split into runs. */
export function sameRichText(left: unknown, right: unknown): boolean {
  const a = unitsOf(left);
  const b = unitsOf(right);
  return a.length === b.length && a.every((unit, index) => unit.key === b[index].key);
}
