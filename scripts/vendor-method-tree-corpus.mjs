// Vendors the conformance repository's method-tree corpus into tests/fixtures/, byte for byte, and
// records where it came from in tests/fixtures/method-tree-corpus.source.json: the conformance
// commit it was copied at, whether the file differed from that commit, and the SHA-256 of the
// bytes. The corpus is self-contained, every entry carrying its bytes, so this one file is all a
// test needs (conformance/specs/mthds-method-tree.md, "What an implementation runs").
//
//   make vendor-tree-corpus                         (from ../conformance)
//   make vendor-tree-corpus CONFORMANCE=<checkout>  (from another checkout or worktree)
//
// tests/unit/method-tree/corpus-vendoring.test.ts checks the copy against this record, and against
// the conformance checkout beside this repository when there is one. Never edit the copy: a case
// this package disagrees with is a case to change in conformance.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CORPUS_IN_CONFORMANCE = "tests/method_tree/fixtures/method-tree-corpus.json";
const FIXTURES = fileURLToPath(new URL("../tests/fixtures/", import.meta.url));
const COPY = join(FIXTURES, "method-tree-corpus.json");
const SOURCE_RECORD = join(FIXTURES, "method-tree-corpus.source.json");

function git(checkout, ...args) {
  return execFileSync("git", ["-C", checkout, ...args], { encoding: "utf-8" }).trim();
}

const checkout = resolve(process.argv[2] ?? fileURLToPath(new URL("../../conformance", import.meta.url)));
const bytes = readFileSync(join(checkout, CORPUS_IN_CONFORMANCE));
const commit = git(checkout, "rev-parse", "HEAD");
const differsFromCommit =
  git(checkout, "status", "--porcelain", "--", CORPUS_IN_CONFORMANCE) !== "";

writeFileSync(COPY, bytes);
const record = {
  source: `conformance/${CORPUS_IN_CONFORMANCE}`,
  conformance_commit: commit,
  uncommitted_changes_at_copy: differsFromCommit,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
writeFileSync(SOURCE_RECORD, `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`vendored ${CORPUS_IN_CONFORMANCE} at ${commit}${differsFromCommit ? " (uncommitted changes)" : ""}\n`);
