import { TomlError, parse as parseToml } from "smol-toml";

/**
 * The two bundle-level keys a pipe selection reads: a bundle's `domain` and its
 * `main_pipe`.
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
    // own that diagnostic, and they say it far better. Treat the metadata as absent.
    if (err instanceof TomlError) return {};
    throw err;
  }
  const table = parsed as Record<string, unknown>;
  return {
    domain: typeof table.domain === "string" ? table.domain : undefined,
    mainPipe: typeof table.main_pipe === "string" ? table.main_pipe : undefined,
  };
}
