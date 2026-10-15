/**
 * The `.gitignore` reading of the membership rule, checked against git itself: for each set of
 * pattern files, the files git would commit from a scratch repository must be the tree this
 * package lists from the same directory. The trees hold no dot segment and no default, so git's
 * listing and the tree are the same set (mthds/docs/spec/method-tree.md, "Checking the Rule
 * Against Git"). Skipped where git is not installed.
 */

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listMethodTree, MethodTreeError } from "../../../src/method-tree/index.js";
import { parseGitignore, wildmatch } from "../../../src/method-tree/gitignore.js";

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = gitAvailable();
const scratch = mkdtempSync(join(tmpdir(), "mthds-gitignore-"));
const isolatedHome = mkdtempSync(join(tmpdir(), "mthds-gitignore-home-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(isolatedHome, { recursive: true, force: true });
});

/** Files every case writes, beside the case's own pattern files. */
const FILES = [
  "README.md",
  "main.mthds",
  "debug.log",
  "keep.log",
  "a.txt",
  "b.txt",
  "1.txt",
  "ab.txt",
  "a b.txt",
  "a.c",
  "a.h",
  "#hash",
  "!bang",
  "trail ",
  "caf\u00e9.md",
  "build/out.txt",
  "build/keep.txt",
  "build/deep/x.txt",
  "doc/guide.txt",
  "doc/api/ref.txt",
  "doc/api/ref.md",
  "src/build/gen.txt",
  "src/main.py",
  "src/sub/a/b/x.py",
  "foo/bar/baz.txt",
  "foo/a/bar/q.txt",
  "x/foo",
  "x/y/foo",
  "foo/plain",
  "logs/2026/jan.log",
  "sub",
  "dir/sub/file.txt",
];

const CASES: { name: string; patterns: Record<string, string>; exclude?: string[] }[] = [
  { name: "a basename glob at any depth", patterns: { ".gitignore": "*.log\n" } },
  { name: "a negation after a glob", patterns: { ".gitignore": "*.log\n!keep.log\n" } },
  { name: "an anchored name", patterns: { ".gitignore": "/build\n" } },
  { name: "a directory-only pattern", patterns: { ".gitignore": "build/\n" } },
  { name: "a directory-only pattern does not match a file", patterns: { ".gitignore": "sub/\n" } },
  { name: "a pattern with a middle slash", patterns: { ".gitignore": "doc/*.txt\n" } },
  { name: "a leading double star", patterns: { ".gitignore": "**/foo\n" } },
  { name: "a trailing double star", patterns: { ".gitignore": "foo/**\n" } },
  { name: "a middle double star", patterns: { ".gitignore": "foo/**/q.txt\nsrc/**/x.py\n" } },
  { name: "a lone double star with a negation", patterns: { ".gitignore": "**\n!*.md\n" } },
  { name: "character classes", patterns: { ".gitignore": "[ab].txt\n[[:digit:]].txt\n" } },
  { name: "a negated class and a range", patterns: { ".gitignore": "[!a].txt\n*.[c-h]\n" } },
  { name: "a question mark", patterns: { ".gitignore": "?b.txt\n" } },
  { name: "escaped hash and bang", patterns: { ".gitignore": "\\#hash\n\\!bang\n" } },
  { name: "a comment line", patterns: { ".gitignore": "#hash\n" } },
  { name: "trailing spaces trimmed", patterns: { ".gitignore": "a.txt   \n" } },
  { name: "an escaped trailing space kept", patterns: { ".gitignore": "trail\\ \n" } },
  { name: "carriage returns", patterns: { ".gitignore": "a.txt\r\nb.txt\r\n" } },
  { name: "a space inside a name", patterns: { ".gitignore": "a b.txt\n" } },
  { name: "a non-ASCII name", patterns: { ".gitignore": "caf*.md\n" } },
  { name: "a byte order mark", patterns: { ".gitignore": "\ufeffREADME.md\n" } },
  { name: "a star slash", patterns: { ".gitignore": "*/\n!doc/\n" } },
  { name: "an anchored star", patterns: { ".gitignore": "/*.txt\n" } },
  {
    name: "a deeper file overrides a shallower one",
    patterns: { ".gitignore": "*.txt\n", "doc/.gitignore": "!guide.txt\n" },
  },
  {
    name: "a negation cannot re-include under an excluded directory",
    patterns: { ".gitignore": "build/\n!build/keep.txt\n" },
  },
  {
    name: "a directory's files ignored, then one re-included",
    patterns: { ".gitignore": "build/*\n!build/keep.txt\n" },
  },
  {
    name: "a nested file's patterns are relative to its directory",
    patterns: { "src/.gitignore": "/build\n*.py\n" },
  },
  {
    name: "the manifest's patterns rank below every .gitignore file",
    patterns: { ".gitignore": "!keep.log\n" },
    exclude: ["*.log", "doc/", "\\#hash"],
  },
  { name: "the manifest's comments", patterns: {}, exclude: ["#hash", "logs/**/*.log"] },
];

function writeCase(
  directory: string,
  patterns: Record<string, string>,
  exclude: string[] | undefined,
): void {
  for (const file of FILES) {
    const path = join(directory, ...file.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${file}\n`);
  }
  for (const [file, text] of Object.entries(patterns)) {
    const path = join(directory, ...file.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  if (exclude !== undefined) {
    const lines = exclude.map((pattern) => JSON.stringify(pattern)).join(", ");
    writeFileSync(
      join(directory, "METHODS.toml"),
      `[package]\naddress = "github.com/acme/x"\nversion = "1.0.0"\ndescription = "x"\nexclude = [${lines}]\n`,
    );
  }
}

/** What git would commit from `directory`, with its configuration isolated from this machine. */
function gitListing(directory: string, exclude: string[] | undefined): string[] {
  const excludesFile = join(directory, "..", `${directory.split("/").pop()}.excludes`);
  writeFileSync(excludesFile, (exclude ?? []).map((pattern) => `${pattern}\n`).join(""));
  const env = {
    PATH: process.env["PATH"] ?? "",
    HOME: isolatedHome,
    XDG_CONFIG_HOME: isolatedHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const config = [
    "-c",
    "core.ignoreCase=false",
    "-c",
    "core.precomposeUnicode=false",
    "-c",
    `core.excludesFile=${excludesFile}`,
  ];
  execFileSync("git", ["init", "-q", "--template=", directory], { env, stdio: "ignore" });
  const output = execFileSync(
    "git",
    ["-C", directory, ...config, "ls-files", "--others", "--exclude-standard", "-z"],
    { env, encoding: "utf-8" },
  );
  rmSync(join(directory, ".git"), { recursive: true, force: true });
  return output
    .split("\0")
    .filter((path) => path !== "")
    .filter((path) => !path.split("/").some((segment) => segment.startsWith(".")))
    .sort();
}

describe.skipIf(!HAS_GIT)("the .gitignore patterns, against git", () => {
  for (const [index, testCase] of CASES.entries()) {
    it(testCase.name, async () => {
      const directory = join(scratch, `case-${index}`);
      mkdirSync(directory);
      writeCase(directory, testCase.patterns, testCase.exclude);
      const expected = gitListing(directory, testCase.exclude);
      let listed: string[];
      try {
        listed = (await listMethodTree(directory)).files.map((file) => file.path).sort();
      } catch (err) {
        if (err instanceof MethodTreeError && err.code === "empty_tree") listed = [];
        else throw err;
      }
      expect(listed).toEqual(expected);
    });
  }
});

describe("wildmatch, git's glob", () => {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  const cases: [pattern: string, text: string, pathname: boolean, matches: boolean][] = [
    ["foo", "foo", true, true],
    ["foo", "bar", true, false],
    ["*", "a/b", true, false],
    ["*", "a/b", false, true],
    ["**", "a/b", true, true],
    ["a/**/b", "a/b", true, true],
    ["a/**/b", "a/x/y/b", true, true],
    ["a/*/b", "a/x/y/b", true, false],
    ["?", "/", true, false],
    ["[a-c]x", "bx", true, true],
    ["[!a-c]x", "bx", true, false],
    ["[^a-c]x", "dx", true, true],
    ["[[:alpha:]]", "\u00e9", true, false],
    ["[[:bogus:]]", "a", true, false],
    ["[]]", "]", true, true],
    ["[a-]", "-", true, true],
    ["\\*", "*", true, true],
    ["\\*", "a", true, false],
    ["*.txt", "a.txt", true, true],
    ["*.txt", "dir/a.txt", true, false],
    ["caf?", "caf\u00e9", true, false],
    ["caf??", "caf\u00e9", true, true],
  ];
  for (const [pattern, text, pathname, matches] of cases) {
    it(`${pattern} ${matches ? "matches" : "does not match"} ${text}${pathname ? " (pathname)" : ""}`, () => {
      expect(wildmatch(encode(pattern), encode(text), pathname)).toBe(matches);
    });
  }
});

describe("parseGitignore", () => {
  it("normalizes a pattern to NFC", () => {
    const [pattern] = parseGitignore("cafe\u0301.txt\n", "", "gitignore").patterns;
    expect(new TextDecoder().decode(pattern!.pattern)).toBe("caf\u00e9.txt");
  });

  it("reads a last line with no line feed, and skips empty lines and comments", () => {
    const patterns = parseGitignore("\n# comment\n\na.txt\n!b", "", "gitignore").patterns;
    expect(patterns.map((pattern) => new TextDecoder().decode(pattern.pattern))).toEqual([
      "a.txt",
      "b",
    ]);
    expect(patterns[1]!.negative).toBe(true);
  });
});
