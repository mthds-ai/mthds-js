import type { MthdsFileItem } from "./types.js";

const DOMAIN_RE = /^\s*domain\s*=\s*"([^"]+)"/m;
const MAIN_PIPE_RE = /^\s*main_pipe\s*=\s*"([^"]+)"/m;

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
  const domains = uniq(
    files.map((file) => file.content.match(DOMAIN_RE)?.[1]).filter((d): d is string => !!d),
  );

  if (pipeRef) {
    if (pipeRef.includes(".")) return pipeRef;
    if (domains.length === 1) return `${domains[0]}.${pipeRef}`;
    throw new Error(
      `Pipe "${pipeRef}" is ambiguous: the closure spans domains [${domains.join(", ")}]. ` +
        `Qualify it as "<domain>.${pipeRef}".`,
    );
  }

  const mainPipes = uniq(
    files.flatMap((file) => {
      const domain = file.content.match(DOMAIN_RE)?.[1];
      const mainPipe = file.content.match(MAIN_PIPE_RE)?.[1];
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
