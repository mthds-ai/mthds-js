/**
 * Git's ignore patterns, as the membership rule reads them (mthds/docs/spec/method-tree.md, "The
 * Membership Rule"): the `.gitignore` files inside a tree's root and the manifest's `[package]
 * exclude` patterns.
 *
 * This is a port of git's own code rather than a reading of its documentation, so the corners
 * agree: `wildmatch.c` for the glob itself, matched over bytes as git matches it, and the parts of
 * `dir.c` that read a pattern file (`add_patterns_from_buffer`, `trim_trailing_spaces`,
 * `parse_path_pattern`) and match a path against a list (`match_basename`, `match_pathname`,
 * `last_matching_pattern_from_list`), with `core.ignoreCase` off. Patterns are normalized to NFC
 * before they are parsed, and matched against the UTF-8 bytes of NFC tree paths.
 */

/** Where a pattern comes from, which is the rule a refusal names for a file it excludes. */
export type PatternSource = "gitignore" | "package_exclude";

/** One parsed pattern, as git's `struct path_pattern` holds it. */
export interface IgnorePattern {
  /** The pattern's bytes, without its leading `!` or its trailing `/`. */
  readonly pattern: Uint8Array;
  /** The length of the pattern's leading part that holds no glob character. */
  readonly noWildcardLength: number;
  readonly negative: boolean;
  /** The pattern ended with `/`, so it matches a directory only. */
  readonly mustBeDirectory: boolean;
  /** The pattern holds no `/`, so it matches a basename at any depth. */
  readonly noDirectory: boolean;
  /** The pattern is `*` followed by a literal, matched as a suffix. */
  readonly endsWith: boolean;
  /** The directory holding the pattern file, relative to the root, `""` for the root itself. */
  readonly base: Uint8Array;
  readonly source: PatternSource;
}

/** The patterns of one pattern file, in the order it lists them. */
export interface PatternList {
  readonly patterns: readonly IgnorePattern[];
}

const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const STAR = 0x2a;
const QUESTION = 0x3f;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const EXCLAMATION = 0x21;
const CARET = 0x5e;
const HYPHEN = 0x2d;
const COLON = 0x3a;
const SPACE = 0x20;
const HASH = 0x23;
const CARRIAGE_RETURN = 0x0d;
const LINE_FEED = 0x0a;

const encoder = new TextEncoder();
const asciiDecoder = new TextDecoder();

function isGlobSpecial(byte: number | undefined): boolean {
  return byte === STAR || byte === QUESTION || byte === OPEN_BRACKET || byte === BACKSLASH;
}

// ── wildmatch.c ───────────────────────────────────────────────────────────────

const WM_MATCH = 0;
const WM_NOMATCH = 1;
const WM_ABORT_ALL = -1;
const WM_ABORT_TO_STARSTAR = -2;

/**
 * Git's character classes are ASCII only, from its locale-independent `sane_ctype` table, so a
 * byte at or above 0x80 belongs to none of them.
 */
function inClass(className: string, byte: number): boolean | undefined {
  const isUpper = byte >= 0x41 && byte <= 0x5a;
  const isLower = byte >= 0x61 && byte <= 0x7a;
  const isDigit = byte >= 0x30 && byte <= 0x39;
  const isAlpha = isUpper || isLower;
  const isSpace = byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
  const isControl = byte < 0x20 || byte === 0x7f;
  const isPrint = byte >= 0x20 && byte < 0x7f;
  switch (className) {
    case "alnum":
      return isAlpha || isDigit;
    case "alpha":
      return isAlpha;
    case "blank":
      return byte === 0x20 || byte === 0x09;
    case "cntrl":
      return isControl;
    case "digit":
      return isDigit;
    case "graph":
      return isPrint && byte !== 0x20;
    case "lower":
      return isLower;
    case "print":
      return isPrint;
    case "punct":
      return isPrint && byte !== 0x20 && !isAlpha && !isDigit;
    case "space":
      return isSpace;
    case "upper":
      return isUpper;
    case "xdigit":
      return isDigit || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
    default:
      return undefined;
  }
}

/**
 * `dowild` of git's `wildmatch.c`, over byte arrays standing for NUL-terminated strings: reading
 * past the end yields 0, git's terminator. Case folding is never on.
 */
function doWild(
  pattern: Uint8Array,
  patternStart: number,
  text: Uint8Array,
  textStart: number,
  pathname: boolean,
): number {
  const at = (bytes: Uint8Array, index: number): number =>
    index < bytes.length ? bytes[index]! : 0;
  let p = patternStart;
  let t = textStart;
  for (; at(pattern, p) !== 0; t += 1, p += 1) {
    let pCh = at(pattern, p);
    let tCh = at(text, t);
    if (tCh === 0 && pCh !== STAR) return WM_ABORT_ALL;
    switch (pCh) {
      case BACKSLASH:
        // A literal match with the next character; a trailing backslash compares with 0.
        p += 1;
        pCh = at(pattern, p);
        if (tCh !== pCh) return WM_NOMATCH;
        continue;
      case QUESTION:
        if (pathname && tCh === SLASH) return WM_NOMATCH;
        continue;
      case STAR: {
        let matchSlash: boolean;
        p += 1;
        if (at(pattern, p) === STAR) {
          const prevP = p;
          while (at(pattern, ++p) === STAR) {
            // Skip a run of stars.
          }
          if (!pathname) {
            matchSlash = true;
          } else if (
            (prevP - patternStart < 2 || at(pattern, prevP - 2) === SLASH) &&
            (at(pattern, p) === 0 ||
              at(pattern, p) === SLASH ||
              (at(pattern, p) === BACKSLASH && at(pattern, p + 1) === SLASH))
          ) {
            // `**/` may match nothing: try the rest of the pattern on the text as it stands.
            if (
              at(pattern, p) === SLASH &&
              doWild(pattern, p + 1, text, t, pathname) === WM_MATCH
            ) {
              return WM_MATCH;
            }
            matchSlash = true;
          } else {
            matchSlash = false;
          }
        } else {
          matchSlash = !pathname;
        }
        if (at(pattern, p) === 0) {
          // A trailing `**` matches everything; a trailing `*` only when no slash remains.
          if (!matchSlash && text.indexOf(SLASH, t) !== -1) return WM_ABORT_TO_STARSTAR;
          return WM_MATCH;
        } else if (!matchSlash && at(pattern, p) === SLASH) {
          // One star followed by a slash matches up to the next directory separator.
          const slash = text.indexOf(SLASH, t);
          if (slash === -1) return WM_ABORT_ALL;
          t = slash;
          break;
        }
        for (;;) {
          if (tCh === 0) break;
          if (!isGlobSpecial(at(pattern, p))) {
            // Advance faster to the next occurrence of the literal that follows the star.
            const literal = at(pattern, p);
            while ((tCh = at(text, t)) !== 0 && (matchSlash || tCh !== SLASH)) {
              if (tCh === literal) break;
              t += 1;
            }
            if (tCh !== literal) return matchSlash ? WM_ABORT_ALL : WM_ABORT_TO_STARSTAR;
          }
          const matched = doWild(pattern, p, text, t, pathname);
          if (matched !== WM_NOMATCH) {
            if (!matchSlash || matched !== WM_ABORT_TO_STARSTAR) return matched;
          } else if (!matchSlash && tCh === SLASH) {
            return WM_ABORT_TO_STARSTAR;
          }
          t += 1;
          tCh = at(text, t);
        }
        return WM_ABORT_ALL;
      }
      case OPEN_BRACKET: {
        p += 1;
        pCh = at(pattern, p);
        if (pCh === CARET) pCh = EXCLAMATION;
        const negated = pCh === EXCLAMATION;
        if (negated) {
          p += 1;
          pCh = at(pattern, p);
        }
        let prevCh = 0;
        let matched = false;
        do {
          if (pCh === 0) return WM_ABORT_ALL;
          if (pCh === BACKSLASH) {
            p += 1;
            pCh = at(pattern, p);
            if (pCh === 0) return WM_ABORT_ALL;
            if (tCh === pCh) matched = true;
          } else if (
            pCh === HYPHEN &&
            prevCh !== 0 &&
            at(pattern, p + 1) !== 0 &&
            at(pattern, p + 1) !== CLOSE_BRACKET
          ) {
            p += 1;
            pCh = at(pattern, p);
            if (pCh === BACKSLASH) {
              p += 1;
              pCh = at(pattern, p);
              if (pCh === 0) return WM_ABORT_ALL;
            }
            if (tCh <= pCh && tCh >= prevCh) matched = true;
            pCh = 0; // So that prevCh becomes 0.
          } else if (pCh === OPEN_BRACKET && at(pattern, p + 1) === COLON) {
            const classStart = p + 2;
            p = classStart;
            while ((pCh = at(pattern, p)) !== 0 && pCh !== CLOSE_BRACKET) p += 1;
            if (pCh === 0) return WM_ABORT_ALL;
            const classLength = p - classStart - 1;
            if (classLength < 0 || at(pattern, p - 1) !== COLON) {
              // No `:]`: treat the `[` as a member of the set.
              p = classStart - 2;
              pCh = OPEN_BRACKET;
              if (tCh === pCh) matched = true;
            } else {
              const className = asciiDecoder.decode(
                pattern.subarray(classStart, classStart + classLength),
              );
              const member = inClass(className, tCh);
              if (member === undefined) return WM_ABORT_ALL; // A malformed [:class:].
              if (member) matched = true;
              pCh = 0; // So that prevCh becomes 0.
            }
          } else if (tCh === pCh) {
            matched = true;
          }
          prevCh = pCh;
          p += 1;
          pCh = at(pattern, p);
        } while (pCh !== CLOSE_BRACKET);
        if (matched === negated || (pathname && tCh === SLASH)) return WM_NOMATCH;
        continue;
      }
      default:
        if (tCh !== pCh) return WM_NOMATCH;
        continue;
    }
    // Reached only from the `break` of a star followed by a slash: the loop's increment consumes
    // the slash in both the pattern and the text.
  }
  return t < text.length && text[t] !== 0 ? WM_NOMATCH : WM_MATCH;
}

/** `wildmatch` of git: whether `pattern` matches `text`, with `WM_PATHNAME` when `pathname`. */
export function wildmatch(pattern: Uint8Array, text: Uint8Array, pathname: boolean): boolean {
  return doWild(pattern, 0, text, 0, pathname) === WM_MATCH;
}

// ── dir.c: reading patterns ───────────────────────────────────────────────────

/** `trim_trailing_spaces`: drop the trailing spaces of a line, unless a backslash escapes one. */
function trimTrailingSpaces(line: Uint8Array): Uint8Array {
  let lastSpace = -1;
  for (let index = 0; index < line.length; index += 1) {
    const byte = line[index]!;
    if (byte === SPACE) {
      if (lastSpace === -1) lastSpace = index;
    } else if (byte === BACKSLASH) {
      index += 1;
      if (index >= line.length) return line;
      lastSpace = -1;
    } else {
      lastSpace = -1;
    }
  }
  return lastSpace === -1 ? line : line.subarray(0, lastSpace);
}

function simpleLength(bytes: Uint8Array): number {
  let length = 0;
  while (length < bytes.length && !isGlobSpecial(bytes[length])) length += 1;
  return length;
}

/** `parse_path_pattern` followed by `add_pattern`; `null` for a line that leaves no pattern. */
function parsePattern(
  line: Uint8Array,
  base: Uint8Array,
  source: PatternSource,
): IgnorePattern | null {
  let bytes = line;
  let negative = false;
  if (bytes[0] === EXCLAMATION) {
    negative = true;
    bytes = bytes.subarray(1);
  }
  // `no_wildcard(p + 1)` reads the pattern before its trailing slash is dropped.
  const endsWith = bytes[0] === STAR && simpleLength(bytes.subarray(1)) === bytes.length - 1;
  let mustBeDirectory = false;
  if (bytes.length > 0 && bytes[bytes.length - 1] === SLASH) {
    bytes = bytes.subarray(0, bytes.length - 1);
    mustBeDirectory = true;
  }
  // An empty pattern matches no name, so leaving it out changes nothing.
  if (bytes.length === 0) return null;
  const noDirectory = !bytes.includes(SLASH);
  const noWildcardLength = Math.min(simpleLength(bytes), bytes.length);
  return {
    pattern: bytes,
    noWildcardLength,
    negative,
    mustBeDirectory,
    noDirectory,
    endsWith,
    base,
    source,
  };
}

/** Encode a pattern line after normalizing it to NFC, as the membership rule asks. */
function nfcBytes(text: string): Uint8Array {
  return encoder.encode(text.normalize("NFC"));
}

/**
 * The patterns of a `.gitignore` file's text, as `add_patterns_from_buffer` reads them: one per
 * line, an empty line and a line starting with `#` holding none, a carriage return before the line
 * feed dropped, and trailing spaces trimmed. The caller has already decoded the bytes as UTF-8 and
 * skipped a leading byte order mark. `base` is the directory holding the file, relative to the
 * root, `""` for the root, as text or as the bytes the walk matches it by.
 */
export function parseGitignore(
  text: string,
  base: string | Uint8Array,
  source: PatternSource,
): PatternList {
  const baseBytes = typeof base === "string" ? nfcBytes(base) : base;
  const bytes = nfcBytes(text);
  const patterns: IgnorePattern[] = [];
  let start = 0;
  // Git appends a line feed to a non-empty file, so a last line without one is read too.
  const buffer =
    bytes.length > 0 && bytes[bytes.length - 1] !== LINE_FEED
      ? Uint8Array.from([...bytes, LINE_FEED])
      : bytes;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== LINE_FEED) continue;
    if (index !== start && buffer[start] !== HASH) {
      const end = index > start && buffer[index - 1] === CARRIAGE_RETURN ? index - 1 : index;
      const pattern = parsePattern(
        trimTrailingSpaces(buffer.subarray(start, end)),
        baseBytes,
        source,
      );
      if (pattern !== null) patterns.push(pattern);
    }
    start = index + 1;
  }
  return { patterns };
}

/**
 * The manifest's `exclude` patterns, read as git reads `core.excludesFile` relative to the root:
 * each entry one line, which holds no line break.
 */
export function parseExcludePatterns(entries: readonly string[]): PatternList {
  return parseGitignore(entries.map((entry) => `${entry}\n`).join(""), "", "package_exclude");
}

// ── dir.c: matching ───────────────────────────────────────────────────────────

function bytesEqual(
  left: Uint8Array,
  leftStart: number,
  right: Uint8Array,
  rightStart: number,
  length: number,
): boolean {
  for (let index = 0; index < length; index += 1) {
    if (left[leftStart + index] !== right[rightStart + index]) return false;
  }
  return true;
}

function matchBasename(basename: Uint8Array, pattern: IgnorePattern): boolean {
  const { pattern: bytes, noWildcardLength } = pattern;
  if (noWildcardLength === bytes.length) {
    return bytes.length === basename.length && bytesEqual(bytes, 0, basename, 0, bytes.length);
  }
  if (pattern.endsWith) {
    const suffixLength = bytes.length - 1;
    return (
      suffixLength <= basename.length &&
      bytesEqual(bytes, 1, basename, basename.length - suffixLength, suffixLength)
    );
  }
  return wildmatch(bytes, basename, false);
}

function matchPathname(pathname: Uint8Array, pattern: IgnorePattern): boolean {
  let bytes = pattern.pattern;
  let prefix = pattern.noWildcardLength;
  if (bytes[0] === SLASH) {
    bytes = bytes.subarray(1);
    prefix -= 1;
  }
  const base = pattern.base;
  const baseLength = base.length;
  if (
    pathname.length < baseLength + 1 ||
    (baseLength > 0 && pathname[baseLength] !== SLASH) ||
    !bytesEqual(pathname, 0, base, 0, baseLength)
  ) {
    return false;
  }
  let name = baseLength > 0 ? pathname.subarray(baseLength + 1) : pathname;
  if (prefix > 0) {
    if (prefix > name.length) return false;
    if (!bytesEqual(bytes, 0, name, 0, prefix)) return false;
    bytes = bytes.subarray(prefix);
    name = name.subarray(prefix);
    if (bytes.length === 0 && name.length === 0) return true;
  }
  return wildmatch(bytes, name, true);
}

/**
 * `last_matching_pattern_from_list`: the last pattern of the list matching a path, or `null`.
 * `pathname` is the path's UTF-8 bytes relative to the root and `basename` its last segment's.
 */
export function lastMatchingPattern(
  list: PatternList,
  pathname: Uint8Array,
  basename: Uint8Array,
  isDirectory: boolean,
): IgnorePattern | null {
  for (let index = list.patterns.length - 1; index >= 0; index -= 1) {
    const pattern = list.patterns[index]!;
    if (pattern.mustBeDirectory && !isDirectory) continue;
    if (pattern.noDirectory) {
      if (matchBasename(basename, pattern)) return pattern;
      continue;
    }
    if (matchPathname(pathname, pattern)) return pattern;
  }
  return null;
}

/**
 * Whether the pattern lists exclude a path, and which source excludes it: the lists are read
 * deepest first, the first one holding a matching pattern decides, and a negative pattern
 * re-includes. `lists` runs from the root's `.gitignore` file to the deepest, followed by the
 * manifest's patterns, which `exclude` reads below every `.gitignore` file in precedence.
 */
export function excludingSource(
  gitignoreLists: readonly PatternList[],
  manifestList: PatternList | null,
  pathname: Uint8Array,
  basename: Uint8Array,
  isDirectory: boolean,
): PatternSource | null {
  for (let index = gitignoreLists.length - 1; index >= 0; index -= 1) {
    const matched = lastMatchingPattern(gitignoreLists[index]!, pathname, basename, isDirectory);
    if (matched !== null) return matched.negative ? null : matched.source;
  }
  if (manifestList !== null) {
    const matched = lastMatchingPattern(manifestList, pathname, basename, isDirectory);
    if (matched !== null) return matched.negative ? null : matched.source;
  }
  return null;
}
