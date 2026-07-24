/**
 * The canonical **catalog serialization** of a method's source files — the JSON
 * `[{ name, content }]` array form (the webapp-editor format) that the hosted
 * platform persists for a stored method's `.mthds` source and its custom
 * PipeFunc `python`.
 *
 * One canonical type + (de)serializer so every JS/TS consumer — the platform
 * contract, `@pipelex/sdk`, `pipelex-mcp` — agrees on the shape instead of each
 * re-porting the platform's `_method_source_to_contents` and drifting.
 *
 * This is the AT-REST catalog representation and is distinct from the run-surface
 * `files` map (`Record<relativePath, text>` on {@link RunRequest}): the catalog
 * stores an ordered, named ARRAY; a run carries an unordered path→text MAP. The
 * empty list is serialized as the empty string `""` — the platform's "no source"
 * / "clear the field" sentinel — never as the literal `"[]"`.
 */

import { PipelineRequestError } from "./exceptions.js";

/** One named source file of a method bundle: a bundle-relative path and its text. */
export interface MethodFile {
  /** Bundle-relative path, e.g. `"funcs/price.py"` or `"bundle.mthds"`. */
  name: string;
  /** The file's UTF-8 text content. */
  content: string;
}

/** A file carries no source when its content is empty or whitespace-only. */
function isBlank(content: string): boolean {
  return content.trim().length === 0;
}

/**
 * Serialize method files to the canonical catalog string. Blank-content entries
 * are dropped (a zero-source file is not persisted), so the canonical form never
 * carries an empty file. An empty result serializes to `""` — the platform's
 * "no source" / "clear the field" signal — not `"[]"`.
 */
export function serializeMethodFiles(files: readonly MethodFile[]): string {
  const kept = files.filter((file) => !isBlank(file.content));
  if (kept.length === 0) return "";
  return JSON.stringify(kept.map(({ name, content }) => ({ name, content })));
}

/**
 * Parse the canonical catalog string back into method files. A blank source
 * (`""` / whitespace / `null` / `undefined`) and an empty JSON array both yield
 * `[]`. A JSON `[{ name, content }]` array yields those files, with blank-content
 * entries dropped (mirroring serialization, so the round-trip is stable).
 *
 * Anything else — a non-array JSON value, an array entry that is not a
 * `{ name: string, content: string }` object, or unparseable text — is a
 * contract violation for this typed surface and throws {@link PipelineRequestError}.
 * (Raw, unnamed `.mthds` text is a legacy `mthds`-only shape handled elsewhere;
 * the catalog file-array is always the named-array form.)
 */
export function parseMethodFiles(source: string | null | undefined): MethodFile[] {
  if (source == null || source.trim().length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new PipelineRequestError(
      "Method file source is not valid JSON; expected a [{ name, content }] array.",
      { cause },
    );
  }

  if (!Array.isArray(parsed)) {
    throw new PipelineRequestError(
      "Method file source must be a JSON array of { name, content } entries.",
    );
  }

  const files: MethodFile[] = [];
  for (const entry of parsed) {
    if (!isMethodFileEntry(entry)) {
      throw new PipelineRequestError(
        "Each method file entry must be an object with string `name` and string `content`.",
      );
    }
    if (!isBlank(entry.content)) files.push({ name: entry.name, content: entry.content });
  }
  return files;
}

function isMethodFileEntry(value: unknown): value is MethodFile {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { content?: unknown }).content === "string"
  );
}
