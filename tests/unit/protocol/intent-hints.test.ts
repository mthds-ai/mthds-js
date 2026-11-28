import { describe, expect, it } from "vitest";
import type { IntentHints } from "../../../src/protocol/input_form.js";
import {
  HINT_KEYS,
  INTENT_WORDS,
  PART_WORDS,
  ROLE_WORDS,
  isHintKey,
  isIntentWord,
  isPartWord,
  isRoleWord,
} from "../../../src/protocol/intent_hints.js";

/** The vocabularies `mthds/docs/spec/intent-hints.md` pins at MTHDS `9.2.0`, in the page's order. */
describe("intent-hint vocabularies", () => {
  it("names the three keys", () => {
    expect(HINT_KEYS).toEqual(["intent", "role", "part"]);
  });

  it("names every intent word, the six of 9.2.0 included", () => {
    expect(INTENT_WORDS).toEqual([
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
    ]);
  });

  it("names the role and part words", () => {
    expect(ROLE_WORDS).toEqual(["subject", "context", "guidance", "reference", "setting"]);
    expect(PART_WORDS).toEqual([
      "title",
      "summary",
      "verdict",
      "metric",
      "body",
      "evidence",
      "detail",
    ]);
  });

  it("reads a word by name and leaves a word it does not know to the consumer", () => {
    const hints: IntentHints = { role: "subject", part: "summary", future_key: "kept" };
    expect(isHintKey("role")).toBe(true);
    expect(isHintKey("future_key")).toBe(false);
    expect(isRoleWord(hints["role"]!)).toBe(true);
    expect(isPartWord(hints["part"]!)).toBe(true);
    expect(isIntentWord("scan")).toBe(true);
    expect(isIntentWord("hologram")).toBe(false);
    expect(isRoleWord("verdict")).toBe(false);
    expect(isPartWord("subject")).toBe(false);
  });
});
