/**
 * The inputs-template projection: one pipe's input-form descriptor rendered as a
 * fill-in template. Exact mirror of `mthds/protocol/inputs_template.py`.
 *
 * A template is what somebody — a person at a form, an agent preparing a run —
 * fills in and hands back as the pipe's inputs. It used to be built server-side
 * and fetched over HTTP; it is projected here instead, from the `input_form`
 * descriptor the standard already defines, so a client holding the descriptor
 * needs nothing further to offer a template for a method it does not have on
 * disk.
 *
 * **The projection walks the descriptor, never a runtime content class**, and
 * that is the whole difference from the reference engine's own renderer: the
 * engine reflects the pydantic class each input resolves to, so its template
 * states what the *runtime* holds, where this states what the *method declares*.
 * Every difference the two exhibit is recorded, with worked sites, in
 * `tests/fixtures/protocol/inputs_template/manifest.json`.
 *
 * The bar this is held to is **byte identity with the Python twin** in the
 * `mthds` PyPI package, across every kind of the closed vocabulary, both shapes
 * and both formats. That is what stops the JS/Python asymmetry the build-route
 * retirement removed from being rebuilt one layer up, and it is a measured
 * contract rather than an intention:
 * `tests/fixtures/protocol/inputs_template/` holds the expected bytes, both repos
 * commit it identically, and each runs the twin of the same parity suite. The
 * TOML half of it is spelled out by `./toml_emitter.js` rather than by either
 * language's TOML library, for the reasons that module states — and so, on this
 * side only, is the JSON half: Python prints a float with its decimal point where
 * `JSON.stringify` cannot, so the numbers a template carries are spelled by one
 * shared rule instead of by each language's serializer.
 *
 * Two shapes, and the difference is what the runtime's own input shaper can take
 * back:
 *
 * - **compact** — the light form a smart-inputs run accepts directly: a bare
 *   string for a text slot, a bare URL for a file-ish one, the content mapping
 *   for a structured one. A slot whose bare value the shaper could *not* rebuild
 *   keeps its `{concept, content}` envelope, because a template that does not run
 *   is not a template.
 * - **explicit** — every slot keeps the ceremonial `{concept, content}` envelope,
 *   whatever it holds.
 *
 * Three rules are this projection's own, because the descriptor states facts the
 * engine reads elsewhere: an `enum` takes its first choice (the engine picks at
 * random, which no committed template could carry), an `unknown` node renders as
 * an empty mapping — the escape hatch's only honest value — and a fixed
 * `Concept[N]` slot renders `N` elements rather than one.
 *
 * Every switch over `FieldKind` here is exhaustive and carries no default arm,
 * deliberately: a kind added to the standard breaks this module where the rule
 * for it has to be written — `noImplicitReturns` reports the function whose
 * switch stopped covering the union — rather than falling through to a guess.
 */

import type {
  InputFormField,
  InputFormItem,
  InputFormTopLevelField,
  PipeInputFormDescriptor,
} from "./input_form.js";
import type { PresenceMarker } from "./pipe_io_contracts.js";
import type { TemplateTable, TemplateValue } from "./toml_emitter.js";
import {
  TemplateFloat,
  renderInlineLayout,
  renderTableLayout,
  spellNumber,
} from "./toml_emitter.js";

const MOCK_URL_PREFIX = "https://mock.invalid/";
const FILE_CONTENT_KEY = "url";
const TIME_FORMAT = "time";

// The two keys of the ceremonial envelope — the explicit shape's whole framing, and what a compact
// slot keeps when its value is not re-shapable from a bare one.
const ENVELOPE_CONCEPT_KEY = "concept";
const ENVELOPE_CONTENT_KEY = "content";

// The single wire key a native scalar's value sits inside. It is a fact about the *payload*, which
// the descriptor deliberately does not carry — so the projection needs this table to build the
// explicit `{concept, content}` envelope. It is the standard's to state, not any runtime's: the
// native content shapes are pinned by `docs/spec/native-concepts.md`.
const TEXT_CONTENT_KEY = "text";
const NUMBER_CONTENT_KEY = "number";
const BOOLEAN_CONTENT_KEY = "yes_no";
const DATE_CONTENT_KEY = "date";
const TIME_CONTENT_KEY = "time";

const NATIVE_PREFIX = "native.";

// The natives an input shaper cannot build top-down: their compact form keeps the whole
// `{concept, content}` envelope, because a bare value at one of these positions is not re-shapable.
// The vocabulary is the standard's closed native set (`docs/spec/native-concepts.md`), which is why
// a projection may consult it: it reads an identity the descriptor states, never sniffs a shape.
const OUT_OF_MATRIX_NATIVES = new Set([
  "Anything",
  "Composite",
  "Dynamic",
  "Html",
  "JSON",
  "Page",
  "SearchResult",
  "TextAndImages",
]);

// `native.Number`'s content is a number union, placeholdered as `1` rather than as the `0` / `0.0` a
// plain `type = "number"` structure field takes. The descriptor states `kind = "number"` for both,
// so the native identity is what separates them.
const NATIVE_NUMBER = "Number";
const NATIVE_NUMBER_PLACEHOLDER = 1;

const CONCEPT_COMMENT_PREFIX = "concept: ";

/** The JSON writer's indent — two spaces, the width Python's `json.dumps` is called with. */
const JSON_INDENT = "  ";

/** The serializations a rendered inputs template can be asked for. */
export const INPUTS_TEMPLATE_FORMATS = ["json", "toml"] as const;

/** One of {@link INPUTS_TEMPLATE_FORMATS}. */
export type InputsTemplateFormat = (typeof INPUTS_TEMPLATE_FORMATS)[number];

/** A descriptor node the projection cannot render — a programming error, never bad input. */
export class InputsTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputsTemplateError";
  }
}

/**
 * Project one pipe's descriptor into a fill-in inputs template and serialize it.
 *
 * @param descriptor - The pipe's input-form descriptor.
 * @param options - `explicit` keeps the ceremonial `{concept, content}` envelope
 *   on every slot; without it the compact shape a smart-inputs run accepts
 *   directly is emitted. `format` is the serialization to render.
 * @returns The serialized template: JSON with no trailing newline, TOML with exactly one.
 * @throws {InputsTemplateError} The format is not one this version renders.
 */
export function renderInputsTemplate(
  descriptor: PipeInputFormDescriptor,
  options: { explicit: boolean; format: InputsTemplateFormat },
): string {
  const { explicit, format } = options;
  // The format arrives as a plain string from a CLI flag or a request field, so it is checked
  // rather than trusted: an unknown one is an error here, not a silently empty document.
  if (!(INPUTS_TEMPLATE_FORMATS as readonly string[]).includes(format)) {
    throw new InputsTemplateError(
      `Unknown inputs-template format '${String(format)}'; expected one of ${INPUTS_TEMPLATE_FORMATS.join(", ")}.`,
    );
  }
  const template = projectInputsTemplate(descriptor, { explicit });
  switch (format) {
    case "json":
      return renderJsonTemplate(template);
    case "toml":
      if (explicit) return renderTableLayout(template);
      return renderInlineLayout(template, projectConceptComments(descriptor));
  }
}

/**
 * Project one pipe's descriptor into the fill-in inputs template.
 *
 * @param descriptor - The pipe's input-form descriptor.
 * @param options - `explicit` keeps the ceremonial `{concept, content}` envelope
 *   on every slot; without it the compact shape a smart-inputs run accepts
 *   directly is emitted.
 * @returns The template, one entry per declared input slot, in authored order.
 */
export function projectInputsTemplate(
  descriptor: PipeInputFormDescriptor,
  options: { explicit: boolean },
): TemplateTable {
  const template: TemplateTable = {};
  for (const field of descriptor.fields) {
    template[field.name] = options.explicit
      ? {
          [ENVELOPE_CONCEPT_KEY]: field.concept_ref ?? null,
          [ENVELOPE_CONTENT_KEY]: slotContent(field, field.name),
        }
      : compactSlot(field);
  }
  return template;
}

/** The per-slot `concept: …` comment map a compact TOML rendering carries above each key. */
export function projectConceptComments(
  descriptor: PipeInputFormDescriptor,
): Record<string, string> {
  return Object.fromEntries(
    descriptor.fields.map((field) => [
      field.name,
      `${CONCEPT_COMMENT_PREFIX}${formatSlotSignature(field)}`,
    ]),
  );
}

/**
 * The io-ref notation for one declared slot — `Concept`, `Concept[]`, `Concept[2]`,
 * `Concept?`, `Concept!`.
 *
 * Rebuilt from the descriptor, because that is all a client projection has: the
 * concept reference, the multiplicity the `list` node states, and the authored
 * presence marker. The marker needs no fallback here where the Python twin has
 * one — {@link InputFormTopLevelField} states `presence` as required, so the type
 * is what guarantees it.
 */
export function formatSlotSignature(field: InputFormTopLevelField): string {
  return `${field.concept_ref ?? ""}${multiplicitySuffix(field)}${presenceSymbol(field.presence)}`;
}

/** The io-ref plurality suffix: none for a single slot, `[]` for a variable list, `[N]` for a fixed one. */
function multiplicitySuffix(field: InputFormItem): string {
  switch (field.kind) {
    case "list":
      return field.item_count === undefined ? "[]" : `[${field.item_count}]`;
    case "text":
    case "prose":
    case "date":
    case "number":
    case "boolean":
    case "enum":
    case "document":
    case "image":
    case "object":
    case "unknown":
      return "";
  }
}

/** The io-ref suffix symbol a presence marker renders as. */
function presenceSymbol(presence: PresenceMarker): string {
  switch (presence) {
    case "plain":
      return "";
    case "optional":
      return "?";
    case "force":
      return "!";
  }
}

/**
 * The native concept this node's chain names, if any.
 *
 * Reads `concept_ref` first, then the `refines` membership list, so a concept
 * refining a native resolves the same way the native itself does.
 */
export function nativeCode(node: InputFormItem): string | null {
  const candidates = [
    ...(node.concept_ref === undefined ? [] : [node.concept_ref]),
    ...(node.refines ?? []),
  ];
  for (const candidate of candidates) {
    if (candidate.startsWith(NATIVE_PREFIX)) return candidate.slice(NATIVE_PREFIX.length);
  }
  return null;
}

/**
 * Whether this slot's compact form keeps the ceremonial envelope instead of unwrapping.
 *
 * Two ways to earn it, and both mean the same thing — a bare value at this
 * position is not re-shapable, so unwrapping would pin a template that does not
 * run. Either the native is one a shaper cannot build top-down at all, or the
 * descriptor states it as an object: a shaper's bare-value arm dispatches a native
 * on its scalar kind, so it rejects the object outright. `native.Date` is the
 * second case — it is a scalar a shaper knows, until the optional `time` beside
 * its required `date` makes the rendered form an object.
 *
 * **A list is decided by its element, on both paths.** What a shaper is handed at
 * a plural slot is one element at a time, so the question is the element's, never
 * the list's. The membership test already reads it — a `list` node's
 * `concept_ref` names the ELEMENT concept — and the kind test has to be asked of
 * the `item` for the same reason, or `native.Date[]` unwraps to a bare array of
 * the very objects a single `native.Date` keeps its envelope to avoid.
 */
export function keepsEnvelope(node: InputFormItem): boolean {
  const code = nativeCode(node);
  if (code === null) return false;
  if (OUT_OF_MATRIX_NATIVES.has(code)) return true;
  switch (node.kind) {
    case "object":
      return true;
    case "list":
      return keepsEnvelope(node.item);
    case "text":
    case "prose":
    case "date":
    case "number":
    case "boolean":
    case "enum":
    case "document":
    case "image":
    case "unknown":
      return false;
  }
}

/** The single wire key a slot-position scalar's value sits inside, or null when it is not one. */
export function slotContentKey(node: InputFormItem): string | null {
  switch (node.kind) {
    case "text":
    case "prose":
      return node.format === TIME_FORMAT ? TIME_CONTENT_KEY : TEXT_CONTENT_KEY;
    case "number":
      return NUMBER_CONTENT_KEY;
    case "boolean":
      return BOOLEAN_CONTENT_KEY;
    case "date":
      return DATE_CONTENT_KEY;
    case "enum":
      return TEXT_CONTENT_KEY;
    case "image":
    case "document":
      return FILE_CONTENT_KEY;
    case "object":
    case "list":
    case "unknown":
      return null;
  }
}

/**
 * The value one descriptor node takes inside a content mapping.
 *
 * A scalar-typed node is its bare placeholder; a concept-typed one (`image`,
 * `document`, `object`) is the content mapping its concept carries, because that
 * is what sits at the field in the payload.
 *
 * One case reads as a scalar and is not: a nested node that names a native concept
 * holds that native's own content object, not a bare value — `native.Text` inside
 * a page's text-and-images is a text content, so the payload carries
 * `{"text": …}` there. The descriptor states the difference itself, in whether the
 * node carries a `concept_ref`: an authored `type = "text"` structure field
 * carries none and stays bare.
 */
export function projectValue(node: InputFormItem, name: string): TemplateValue {
  switch (node.kind) {
    case "text":
    case "prose":
    case "date":
    case "number":
    case "boolean":
    case "enum": {
      const contentKey = nativeCode(node) === null ? null : slotContentKey(node);
      if (contentKey !== null) return { [contentKey]: leafPlaceholder(node, contentKey) };
      return leafPlaceholder(node, name);
    }
    case "image":
    case "document":
      return { [FILE_CONTENT_KEY]: leafPlaceholder(node, FILE_CONTENT_KEY) };
    case "object":
      return Object.fromEntries(
        node.fields.map((member) => [member.name, projectValue(member, member.name)]),
      );
    case "list":
      return repeatElements(node.item_count, () => projectValue(node.item, `${name}_item`));
    case "unknown":
      return {};
  }
}

/**
 * The fill-in value for a node the descriptor states as a leaf.
 *
 * `name` is the name of the field the value occupies, which is what the
 * placeholder is built from: a structure field's own name when the leaf sits
 * inside a content mapping, and the content key when it sits at a slot, where the
 * value occupies its native content shape's single field.
 */
function leafPlaceholder(node: InputFormItem, name: string): TemplateValue {
  switch (node.kind) {
    case "text":
    case "prose":
      return node.format === TIME_FORMAT ? "12:00:00" : `${name}_value`;
    case "date":
      return node.datetime ? "2026-01-01T12:00:00" : "2026-01-01";
    case "number":
      if (nativeCode(node) === NATIVE_NUMBER) return NATIVE_NUMBER_PLACEHOLDER;
      if (node.integer) return 0;
      // A float placeholder keeps its decimal point across both serializations, which
      // TypeScript's single number type cannot carry on its own.
      return new TemplateFloat(0);
    case "boolean":
      return false;
    case "enum":
      // The first choice, never a random one: these bytes are committed. The authored
      // choices are `unknown[]` — whatever a bundle declared is what the template offers.
      return node.choices.length > 0 ? (node.choices[0] as TemplateValue) : `${name}_value`;
    case "image":
    case "document":
      return `${MOCK_URL_PREFIX}${FILE_CONTENT_KEY}`;
    case "object":
    case "list":
    case "unknown":
      throw new InputsTemplateError(`Not a leaf kind: ${node.kind}`);
  }
}

/**
 * A list's elements: its declared count, or one example for a variable list.
 *
 * Each repetition is projected afresh, never one value repeated: the elements of a
 * fixed `Concept[N]` slot are identical in content and must be distinct objects,
 * or filling the first entry of the returned template fills every other one with it.
 */
function repeatElements(
  itemCount: number | undefined,
  projectElement: () => TemplateValue,
): TemplateValue[] {
  return Array.from({ length: itemCount ?? 1 }, () => projectElement());
}

/** The `content` half of one slot's envelope — what the concept carries at that position. */
function slotContent(node: InputFormItem, name: string): TemplateValue {
  const contentKey = slotContentKey(node);
  if (contentKey !== null) return { [contentKey]: leafPlaceholder(node, contentKey) };
  switch (node.kind) {
    case "list":
      return repeatElements(node.item_count, () => slotContent(node.item, `${name}_item`));
    case "object":
    case "unknown":
    case "text":
    case "prose":
    case "date":
    case "number":
    case "boolean":
    case "enum":
    case "image":
    case "document":
      return projectValue(node, name);
  }
}

/** One slot's (or one slot element's) compact value: a scalar unwraps, everything else keeps its mapping. */
function compactValue(node: InputFormItem, name: string): TemplateValue {
  const contentKey = slotContentKey(node);
  if (contentKey !== null) return leafPlaceholder(node, contentKey);
  return projectValue(node, name);
}

/**
 * One slot in the compact shape.
 *
 * A slot whose bare value is not re-shapable keeps the whole envelope, exactly as
 * the engine's own compact rendering does: unwrapping it would emit a template
 * that no longer runs.
 */
function compactSlot(field: InputFormField): TemplateValue {
  if (keepsEnvelope(field)) {
    return {
      [ENVELOPE_CONCEPT_KEY]: field.concept_ref ?? null,
      [ENVELOPE_CONTENT_KEY]: slotContent(field, field.name),
    };
  }
  switch (field.kind) {
    case "list":
      return repeatElements(field.item_count, () => compactValue(field.item, `${field.name}_item`));
    case "object":
    case "unknown":
    case "text":
    case "prose":
    case "date":
    case "number":
    case "boolean":
    case "enum":
    case "image":
    case "document":
      return compactValue(field, field.name);
  }
}

/**
 * The template as JSON text, two-space indented and with no trailing newline.
 *
 * Written here rather than handed to `JSON.stringify` for one reason: a
 * {@link TemplateFloat} must print as `0.0` where `JSON.stringify` prints `0`,
 * and the corpus is bytes. Everything else follows Python's
 * `json.dumps(indent=2, ensure_ascii=False)` — strings raw rather than
 * `\u`-escaped, `{}` and `[]` for the empty container, `": "` between a key and
 * its value.
 */
function renderJsonTemplate(template: TemplateTable): string {
  return renderJsonValue(template, "");
}

function renderJsonValue(value: TemplateValue, indent: string): string {
  if (value === null) return "null";
  if (value instanceof TemplateFloat || typeof value === "number") return spellNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  const inner = `${indent}${JSON_INDENT}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const elements = value.map((element) => `${inner}${renderJsonValue(element, inner)}`);
    return `[\n${elements.join(",\n")}\n${indent}]`;
  }
  const members = Object.entries(value).map(
    ([key, member]) => `${inner}${JSON.stringify(key)}: ${renderJsonValue(member, inner)}`,
  );
  if (members.length === 0) return "{}";
  return `{\n${members.join(",\n")}\n${indent}}`;
}
