/* A list item's marker: bullets cycle by depth, and numbered items count
   in numbers, then letters, then Roman numerals, as nesting goes. */

const BULLETS = ["•", "◦", "▪"];

/** Notion cycles list markers by depth so nesting stays readable without
 *  colour or extra rules. */
export function bulletFor(depth: number): string {
  return BULLETS[depth % BULLETS.length];
}

export function numberFor(value: number, depth: number): string {
  if (depth % 3 === 1) return `${lettered(value)}.`;
  if (depth % 3 === 2) return `${romanize(value)}.`;
  return `${value}.`;
}

/** 1 → a, 26 → z, 27 → aa, 703 → aaa: letters as spreadsheet columns
 *  count, so a long list goes on past z instead of starting again. */
function lettered(value: number): string {
  let left = Math.max(1, Math.trunc(value));
  let letters = "";
  while (left > 0) {
    left -= 1;
    letters = String.fromCharCode(97 + (left % 26)) + letters;
    left = Math.floor(left / 26);
  }
  return letters;
}

function romanize(value: number): string {
  const table: Array<[number, string]> = [[10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let remaining = value;
  let result = "";
  for (const [amount, symbol] of table) {
    while (remaining >= amount) {
      result += symbol;
      remaining -= amount;
    }
  }
  return result || "i";
}
