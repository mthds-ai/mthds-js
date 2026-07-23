import { TomlError, parse as parseToml } from "smol-toml";
import type { MthdsFileItem } from "./types.js";

/**
 * The two bundle-level keys the pipe selector needs.
 *
 * Read with the real TOML parser rather than a regex. `.mthds` files ARE TOML, and TOML
 * spells these more ways than a regex comfortably matches: basic vs literal strings
 * (`"smoke"` / `'smoke'`), quoted keys (`"domain" = …`), comments and whitespace between
 * them. A regex that missed any of those silently reported a perfectly valid bundle as
 * "declares no domain" — which is precisely the bug this replaced. `smol-toml` is already
 * a dependency (see `package/manifest/validate.ts`), so this is cheaper than the regex was.
 */
export function readBundleMeta(content: string): { domain?: string; mainPipe?: string } {
  let parsed: unknown;
  try {
    parsed = parseToml(content);
  } catch (err) {
    // A malformed bundle is not this function's error to report — the CLI and the engine
    // own that diagnostic, and they say it far better. Treat the metadata as absent; a
    // caller who supplied a qualified `pipe_ref` never needed it anyway.
    if (err instanceof TomlError) return {};
    throw err;
  }
  const table = parsed as Record<string, unknown>;
  return {
    domain: typeof table.domain === "string" ? table.domain : undefined,
    mainPipe: typeof table.main_pipe === "string" ? table.main_pipe : undefined,
  };
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Resolve the QUALIFIED `domain.pipe_code` a `/v1/build/*` call targets, from the
 * closure's files and the caller's optional selector.
 *
 * Mirrors how the engine defaults the selector (`pipelex codegen inputs --pipe`):
 * an explicit ref wins; otherwise fall back to the closure's declared `main_pipe`,
 * which is an error both when NO file declares one and when SEVERAL do — an
 * ambiguous closure has no single "the" pipe, so guessing would be worse than
 * asking.
 *
 * Used by the local `pipelex` runner, which — unlike the API — never sees the
 * loaded library and so cannot let the engine resolve the ref for it. That is why
 * it is stricter in one spot: a BARE ref across a multi-domain closure throws here,
 * where the API would resolve it against the live library and echo it back
 * qualified.
 */
export function resolveQualifiedPipeRef(files: MthdsFileItem[], pipeRef?: string): string {
  // An empty string is a selector the caller SUPPLIED, not one they omitted. Defaulting
  // it would silently run a different pipe than was asked for — and the API rejects it
  // outright (`min_length=1` ⇒ 422), so accepting it here would diverge from the wire.
  if (pipeRef !== undefined && pipeRef.trim() === "") {
    throw new Error(
      'pipe_ref must be a qualified "domain.pipe_code" ref, or omitted entirely to ' +
        "default to the closure's main_pipe — an empty string is neither.",
    );
  }

  // A qualified ref is already the answer — resolve it before reading any file, so a
  // caller who named their pipe is never blocked by a bundle we cannot parse.
  if (pipeRef?.includes(".")) return pipeRef;

  const meta = files.map((file) => readBundleMeta(file.content));
  const domains = uniq(
    meta.map((entry) => entry.domain).filter((domain): domain is string => !!domain),
  );

  if (pipeRef) {
    if (domains.length === 1) return `${domains[0]}.${pipeRef}`;
    if (domains.length === 0) {
      throw new Error(
        `Pipe "${pipeRef}" cannot be qualified: no file in the closure declares a domain. ` +
          `Qualify it as "<domain>.${pipeRef}".`,
      );
    }
    throw new Error(
      `Pipe "${pipeRef}" is ambiguous: the closure spans domains [${domains.join(", ")}]. ` +
        `Qualify it as "<domain>.${pipeRef}".`,
    );
  }

  const mainPipes = uniq(
    meta.flatMap((entry) =>
      entry.domain && entry.mainPipe ? [`${entry.domain}.${entry.mainPipe}`] : [],
    ),
  );

  if (mainPipes.length === 1) return mainPipes[0]!;
  if (mainPipes.length === 0) {
    throw new Error(
      "No pipe was selected and the closure declares no main_pipe. Pass a qualified pipe ref.",
    );
  }
  throw new Error(
    `No pipe was selected and the closure declares several main_pipe values ` +
      `(${mainPipes.join(", ")}). Pass a qualified pipe ref.`,
  );
}
