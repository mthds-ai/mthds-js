/**
 * The case folding two tree paths collide on (mthds/docs/spec/method-tree.md, "Tree Paths"): the
 * path in NFC, mapped by Unicode full case folding, normalized to NFC again. JavaScript has no full
 * case folding of its own, `toLowerCase` being a case conversion, so the table is carried in
 * `case-folding-table.ts`, generated from the Unicode Character Database by
 * `scripts/gen-case-folding.mjs`.
 */

import { FULL_CASE_FOLDING } from "./case-folding-table.js";

export { CASE_FOLDING_UNICODE_VERSION } from "./case-folding-table.js";

let foldings: Map<number, string> | undefined;

function foldingTable(): Map<number, string> {
  if (foldings === undefined) {
    foldings = new Map();
    for (const [codePoint, ...mapping] of FULL_CASE_FOLDING) {
      foldings.set(codePoint!, String.fromCodePoint(...mapping));
    }
  }
  return foldings;
}

/** Unicode full case folding (statuses C and F of CaseFolding.txt, no locale tailoring) of `text`. */
export function fullCaseFold(text: string): string {
  const table = foldingTable();
  let folded = "";
  for (const character of text) {
    folded += table.get(character.codePointAt(0)!) ?? character;
  }
  return folded;
}

/** The key two tree paths collide on: `nfc(fullCaseFold(nfc(path)))`. */
export function caseFold(treePath: string): string {
  return fullCaseFold(treePath.normalize("NFC")).normalize("NFC");
}
