/**
 * The conformance corpus of the method tree, vendored in tests/fixtures/method-tree-corpus.json,
 * and the procedure that writes a tree case to disk, as conformance/specs/mthds-method-tree.md
 * ("Materializing a tree case") describes it.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CORPUS_PATH = fileURLToPath(
  new URL("../../fixtures/method-tree-corpus.json", import.meta.url),
);
export const CORPUS_SOURCE_PATH = fileURLToPath(
  new URL("../../fixtures/method-tree-corpus.source.json", import.meta.url),
);

export type Capability =
  | "case_sensitive_names"
  | "normalization_sensitive_names"
  | "symbolic_links"
  | "named_pipes";

export interface CaseEntry {
  readonly path: string;
  readonly type: "file" | "directory" | "symlink" | "fifo";
  readonly text?: string;
  readonly base64?: string;
  readonly target?: string;
}

export type Expected = Record<string, unknown>;

export interface TreeCase {
  readonly id: string;
  readonly description: string;
  readonly requires: readonly Capability[];
  readonly handed_over: string;
  readonly entries: readonly CaseEntry[];
  readonly expected: Expected;
  readonly references: readonly {
    readonly holder: string;
    readonly reference: string;
    readonly context: "path" | "url";
    readonly expected: Expected;
  }[];
  readonly function_names: readonly {
    readonly function_name: string;
    readonly expected: Expected;
  }[];
}

export interface MapCase {
  readonly id: string;
  readonly description: string;
  readonly document: string;
  readonly blob_store: readonly { sha256: string; size: number; base64: string }[];
  readonly expected: Expected;
}

export interface PathCase {
  readonly path: string;
  readonly description: string;
  readonly expected: Expected;
}

export interface Corpus {
  readonly corpus: string;
  readonly format: number;
  readonly trees: readonly TreeCase[];
  readonly maps: readonly MapCase[];
  readonly paths: readonly PathCase[];
}

export function loadCorpus(): Corpus {
  return JSON.parse(readFileSync(CORPUS_PATH, "utf-8")) as Corpus;
}

function makeFifo(path: string): void {
  execFileSync("mkfifo", [path], { stdio: "ignore" });
}

/** What the file system holding `directory` allows, found by trying each thing there. */
export function probeCapabilities(directory: string): Set<Capability> {
  const available = new Set<Capability>();
  const probe = mkdtempSync(join(directory, "capability-probe-"));
  try {
    writeFileSync(join(probe, "probe-case"), "");
    if (!existsSync(join(probe, "PROBE-CASE"))) available.add("case_sensitive_names");
    const composed = "probe-\u00e9";
    writeFileSync(join(probe, composed), "");
    if (!existsSync(join(probe, composed.normalize("NFD")))) {
      available.add("normalization_sensitive_names");
    }
    try {
      symlinkSync("probe-case", join(probe, "probe-link"));
      available.add("symbolic_links");
    } catch {
      // No symbolic links here.
    }
    try {
      makeFifo(join(probe, "probe-pipe"));
      available.add("named_pipes");
    } catch {
      // No named pipes here.
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
  return available;
}

/** A fresh directory for one case, under the system's temporary directory. */
export function newWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "mthds-tree-case-"));
}

/** Write each entry of a tree case at its path under `workspace`, names as given. */
export function materialize(workspace: string, entries: readonly CaseEntry[]): void {
  for (const entry of entries) {
    const path = join(workspace, ...entry.path.split("/"));
    mkdirSync(entry.type === "directory" ? path : dirname(path), { recursive: true });
    switch (entry.type) {
      case "file":
        writeFileSync(
          path,
          entry.base64 !== undefined
            ? Buffer.from(entry.base64, "base64")
            : Buffer.from(entry.text ?? "", "utf8"),
        );
        break;
      case "directory":
        break;
      case "symlink":
        symlinkSync(entry.target!, path);
        break;
      case "fifo":
        makeFifo(path);
        break;
    }
  }
}
