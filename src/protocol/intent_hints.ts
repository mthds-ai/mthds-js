/**
 * The intent-hint vocabularies the standard pins at MTHDS `9.2.0` — mirror of
 * `mthds/protocol/intent_hints.py`, from "Intent Hints"
 * (`mthds/docs/spec/intent-hints.md`).
 *
 * A field descriptor's `hints` slot (`IntentHints` in `./input_form.ts`) is a
 * flat string → string map, and stays one: unknown keys and unknown words ride
 * through it untouched, as the language's content-leniency rule requires, so a
 * descriptor produced against a later vocabulary still type-checks here. These
 * tuples name the keys and words this version defines, for a consumer that
 * wants to read a hint by name rather than by a string literal:
 *
 *     const role = node.hints?.["role"];
 *     if (role !== undefined && isRoleWord(role)) { … }
 *
 * They type what a consumer compares against, never what the descriptor
 * accepts: nothing here narrows the `hints` map, and a word this module does
 * not list is a word from a later version or an author's own, which a consumer
 * ignores rather than refuses. How a consumer honours a word is its own
 * decision, and a consumer that ignores hints entirely stays correct.
 *
 * What each key applies to, and why none changes a node's `kind` except a
 * text-valued node's `intent`, is the standard's to say
 * (`docs/spec/intent-hints.md` and `docs/spec/input-form-descriptor.md`,
 * "Intent Hints on a Descriptor"). Runtime values because a union is erased at
 * build, the same shape as `FIELD_KINDS`.
 */

/**
 * The keys of the `hints` table this version defines: `intent`, what kind of
 * value the site holds beyond its type; `role`, what part an input slot plays
 * in the job, meaningful on a top-level field only; and `part`, what part of
 * its record a structure field is, meaningful on a nested field only.
 */
export const HINT_KEYS = ["intent", "role", "part"] as const;

/** One of `HINT_KEYS`. */
export type HintKey = (typeof HINT_KEYS)[number];

/**
 * The words of the `intent` key, each applying to one value class of site:
 *
 * - text-valued: `prose` (flowing natural language), `label` (a short
 *   designation on a single line), `code` (source code or another formal text
 *   a machine reads), `identifier` (a short reference naming one thing
 *   exactly, copied rather than written) and `question` (a request addressed
 *   to the method, in the person's own words). `prose`, `code` and `question`
 *   make a text-valued node `prose`; `label` and `identifier` make it `text`.
 * - number-valued: `rating` (a subjective score on a scale) and `quantity` (an
 *   amount of something, counted or measured).
 * - image-valued: `photo` (a picture taken of the world with a camera) and
 *   `screenshot` (a capture of a screen); image-valued or document-valued:
 *   `scan` (a paper document captured by a scanner or a camera).
 */
export const INTENT_WORDS = [
  "prose",
  "label",
  "rating",
  "quantity",
  "code",
  "identifier",
  "question",
  "photo",
  "screenshot",
  "scan",
] as const;

/** One of `INTENT_WORDS`. */
export type IntentWord = (typeof INTENT_WORDS)[number];

/**
 * The words of the `role` key — what part an input plays in the job the method
 * does: `subject` (the material the method works on; changes every run),
 * `context` (a fact about this case the method needs; most runs), `guidance`
 * (how the person wants the work done; sometimes), `reference` (the yardstick
 * the method applies; set once, reused) and `setting` (a choice with a
 * sensible default; rarely).
 */
export const ROLE_WORDS = ["subject", "context", "guidance", "reference", "setting"] as const;

/** One of `ROLE_WORDS`. */
export type RoleWord = (typeof ROLE_WORDS)[number];

/**
 * The words of the `part` key — what part of its record a structure field is:
 * `title` (the words that name the record; text-valued), `summary` (the record
 * in one or two sentences; text-valued), `verdict` (the answer the reader came
 * for: a decision, a status, a score), `metric` (a headline number that is not
 * a verdict; number-valued), and `body` (the main content), `evidence` (what
 * supports the verdict) and `detail` (anything else worth showing), each on any
 * field.
 */
export const PART_WORDS = [
  "title",
  "summary",
  "verdict",
  "metric",
  "body",
  "evidence",
  "detail",
] as const;

/** One of `PART_WORDS`. */
export type PartWord = (typeof PART_WORDS)[number];

function isOneOf<T extends string>(vocabulary: readonly T[], word: string): word is T {
  return (vocabulary as readonly string[]).includes(word);
}

/** Whether `key` is a `hints` key this version defines. */
export function isHintKey(key: string): key is HintKey {
  return isOneOf(HINT_KEYS, key);
}

/** Whether `word` is an `intent` word this version defines. */
export function isIntentWord(word: string): word is IntentWord {
  return isOneOf(INTENT_WORDS, word);
}

/** Whether `word` is a `role` word this version defines. */
export function isRoleWord(word: string): word is RoleWord {
  return isOneOf(ROLE_WORDS, word);
}

/** Whether `word` is a `part` word this version defines. */
export function isPartWord(word: string): word is PartWord {
  return isOneOf(PART_WORDS, word);
}
