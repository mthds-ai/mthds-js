import type { MthdsFileItem } from "./types.js";

// `.mthds` files are TOML, where a string is basic ("…") OR literal ('…') — both are
// ordinary, and pipelex parses both. Matching only double quotes silently dropped the
// domain of a perfectly valid bundle, which then read as "declares no domain".
const DOMAIN_RE = /^\s*domain\s*=\s*(?:"([^"]+)"|'([^']+)')/m;
const MAIN_PIPE_RE = /^\s*main_pipe\s*=\s*(?:"([^"]+)"|'([^']+)')/m;

/** The captured value, whichever quote style carried it. */
function tomlString(content: string, pattern: RegExp): string | undefined {
  const match = content.match(pattern);
  return match ? (match[1] ?? match[2]) : undefined;
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

  const domains = uniq(
    files
      .map((file) => tomlString(file.content, DOMAIN_RE))
      .filter((domain): domain is string => !!domain),
  );

  if (pipeRef) {
    if (pipeRef.includes(".")) return pipeRef;
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
    files.flatMap((file) => {
      const domain = tomlString(file.content, DOMAIN_RE);
      const mainPipe = tomlString(file.content, MAIN_PIPE_RE);
      return domain && mainPipe ? [`${domain}.${mainPipe}`] : [];
    }),
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
