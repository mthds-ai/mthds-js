import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import type { TemplateTable, TemplateValue } from "../../../src/protocol/toml_emitter.js";
import {
  TemplateFloat,
  TomlEmissionError,
  renderInlineLayout,
  renderTableLayout,
} from "../../../src/protocol/toml_emitter.js";

/**
 * The deterministic TOML emitter's layout rules, stated as bytes. Twin of
 * `mthds-python`'s `tests/unit/test_toml_emitter.py`.
 *
 * The shared fixture corpus in `tests/fixtures/protocol/inputs_template/` is what
 * pins the emitter against its Python twin, but it can only exercise the shapes
 * the captured bundles happen to produce. These cases state each rule on its own,
 * so the rule that failed is named by the test that broke — and so both sides of
 * the mirror have an executable statement of the contract rather than a paragraph
 * of prose.
 */

/** Control characters, built rather than typed, so this file holds none of its own. */
const START_OF_HEADING = String.fromCharCode(0x01);
const NUL = String.fromCharCode(0x00);

interface TableCase {
  topic: string;
  template: TemplateTable;
  expected: string;
}

interface InlineCase extends TableCase {
  comments: Record<string, string>;
}

const TABLE_LAYOUT: TableCase[] = [
  {
    topic:
      "scalars come before tables, each half in authored order, one blank line before every header",
    template: { alpha: "a", obj: { beta: 1, nested: { gamma: true } }, zeta: 2 },
    expected: 'alpha = "a"\nzeta = 2\n\n[obj]\nbeta = 1\n\n[obj.nested]\ngamma = true\n',
  },
  {
    topic:
      "a table whose members are all tables states no header: its children carry the dotted path",
    template: { outer: { inner: { leaf: 1 } } },
    expected: "[outer.inner]\nleaf = 1\n",
  },
  {
    topic:
      "an empty table is not a super table — it has no child to carry its path, so it states its header",
    template: { first: { alpha: 1 }, empty: {} },
    expected: "[first]\nalpha = 1\n\n[empty]\n",
  },
  {
    topic: "a non-empty list of mappings is an array of tables: one header per element",
    template: { items: [{ alpha: 1 }, { alpha: 2 }] },
    expected: "[[items]]\nalpha = 1\n\n[[items]]\nalpha = 2\n",
  },
  {
    topic:
      "an array-of-tables element always states its header, even with nothing but tables inside — and takes its blank line, where tomlkit, which rendered the corpus, omits it (L-260831-4031a7)",
    template: { outer: [{ inner: { leaf: 1 } }] },
    expected: "[[outer]]\n\n[outer.inner]\nleaf = 1\n",
  },
  {
    topic:
      "a list of scalars, an empty list and a mixed list are inline arrays, not arrays of tables",
    template: { tags: ["one", "two"], none: [], mixed: [{ alpha: 1 }, 2] },
    expected: 'tags = ["one", "two"]\nnone = []\nmixed = [{alpha = 1}, 2]\n',
  },
  {
    topic: "TOML has no null: a null keeps its key and takes an empty string, at every depth",
    template: { missing: null, obj: { also: null } },
    expected: 'missing = ""\n\n[obj]\nalso = ""\n',
  },
  {
    topic: "a key TOML cannot spell bare is quoted, in a header path as much as on a line",
    template: { "a.b": 1, "with space": { "": 2 }, "ok-1": 3 },
    expected: '"a.b" = 1\nok-1 = 3\n\n["with space"]\n"" = 2\n',
  },
  {
    topic:
      "a basic string takes the compact escapes, and any other control character its code point",
    template: { text: `quote " slash \\ break \n tab \t control ${START_OF_HEADING} accent é` },
    expected: 'text = "quote \\" slash \\\\ break \\n tab \\t control \\u0001 accent é"\n',
  },
  {
    topic:
      "numbers and booleans keep their own spelling: an integer bare, a float with its point — which on this side of the mirror is what TemplateFloat carries",
    template: {
      count: 0,
      price: new TemplateFloat(0),
      ratio: new TemplateFloat(1.5),
      negative: -7,
      enabled: false,
      disabled: true,
    },
    expected:
      "count = 0\nprice = 0.0\nratio = 1.5\nnegative = -7\nenabled = false\ndisabled = true\n",
  },
];

const INLINE_LAYOUT: InlineCase[] = [
  {
    topic:
      "every value stays at the top level, and a key with a comment takes it on the line above",
    template: { note: "text_value", widget: { label: "x" } },
    comments: { note: "concept: native.Text" },
    expected: '# concept: native.Text\nnote = "text_value"\nwidget = {label = "x"}\n',
  },
  {
    topic:
      "structure nests as inline tables and inline arrays, however deep, and empty ones stay visible",
    template: { deep: { inner: { items: [{}, { alpha: 1 }] } }, empty: {} },
    comments: {},
    expected: "deep = {inner = {items = [{}, {alpha = 1}]}}\nempty = {}\n",
  },
  {
    topic:
      "a comment for a key the template does not hold is ignored, and an empty one takes no line",
    template: { alpha: 1 },
    comments: { alpha: "", beta: "concept: never.Rendered" },
    expected: "alpha = 1\n",
  },
  {
    topic:
      "authored order is what survives — the reason a compact template is laid out inline at all",
    template: { structured: { alpha: 1 }, scalar: "z" },
    comments: {},
    expected: 'structured = {alpha = 1}\nscalar = "z"\n',
  },
];

/** A value the emitter has no spelling for — in TypeScript, the values JSON has none for either. */
const UNSPELLABLE_VALUES: unknown[] = [undefined, Symbol("nope"), () => 1, 10n];

// A comment is the one text that reaches the document unquoted, so a line terminator inside it
// ends the comment instead of corrupting it, and turns what follows into live TOML.
const UNSPELLABLE_COMMENTS: string[] = [
  "concept: native.Text\nrogue = 1",
  "concept: native.Text\rrogue = 1",
  `concept: native.Text${NUL}`,
];

/**
 * The emitter's own null rule, plus the unwrapping of the float marker, so a
 * round-trip compares like with like: a parse hands back plain numbers, and the
 * marker is a spelling decision rather than a different value.
 */
function plain(value: TemplateValue): unknown {
  if (value === null) return "";
  if (value instanceof TemplateFloat) return value.value;
  if (Array.isArray(value)) return value.map((element) => plain(element));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, plain(member)]));
  }
  return value;
}

describe("the table layout", () => {
  for (const { topic, template, expected } of TABLE_LAYOUT) {
    it(topic, () => {
      expect(renderTableLayout(template)).toBe(expected);
    });

    it(`parses back to what went in — ${topic}`, () => {
      // The expected bytes are what the twin is held to; that they are also *valid TOML carrying
      // the template* is the separate property, and the one a corpus of committed bytes cannot
      // state on its own. A layout rule that produced a well-formed-looking document saying
      // something else would pass every byte comparison there is.
      expect(parse(expected)).toEqual(plain(template));
    });
  }
});

describe("the inline layout", () => {
  for (const { topic, template, comments, expected } of INLINE_LAYOUT) {
    it(topic, () => {
      expect(renderInlineLayout(template, comments)).toBe(expected);
    });

    it(`parses back to what went in — ${topic}`, () => {
      expect(parse(expected)).toEqual(plain(template));
      // The comments are the half a parse throws away, so they are checked as text: a comment on
      // a key the template holds is a line of its own — the whole reason this layout exists — and
      // one naming a key it does not hold is nowhere in the document.
      for (const [key, commentText] of Object.entries(comments)) {
        if (!commentText) continue;
        expect(expected.includes(`# ${commentText}\n`)).toBe(key in template);
      }
    });
  }
});

describe("what the emitter refuses", () => {
  it("renders an empty template as an empty document in both layouts", () => {
    // Not a blank line and not a lone newline: a pipe declaring no inputs has nothing to fill in.
    expect(renderTableLayout({})).toBe("");
    expect(renderInlineLayout({}, {})).toBe("");
  });

  for (const value of UNSPELLABLE_VALUES) {
    it(`refuses a ${typeof value} rather than guessing a spelling for it`, () => {
      const template = { slot: value } as TemplateTable;
      expect(() => renderTableLayout(template)).toThrow(TomlEmissionError);
      expect(() => renderInlineLayout(template, {})).toThrow(TomlEmissionError);
    });
  }

  for (const commentText of UNSPELLABLE_COMMENTS) {
    it(`refuses a comment carrying ${JSON.stringify(commentText)} rather than writing it`, () => {
      // The comment is built from the descriptor's `concept_ref` — an unconstrained string from
      // whatever producer emitted the artifact. A line terminator in it does not corrupt the
      // comment: it ends it, and what follows parses as a line of the template in its own right.
      expect(() => renderInlineLayout({ slot: "value" }, { slot: commentText })).toThrow(
        TomlEmissionError,
      );
    });
  }
});
