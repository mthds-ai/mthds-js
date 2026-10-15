/**
 * The vendored method-tree corpus is the conformance repository's file, byte for byte: its bytes
 * hash to what tests/fixtures/method-tree-corpus.source.json recorded when it was copied, and they
 * equal the conformance checkout beside this repository when there is one. Re-vendor with
 * `make vendor-tree-corpus`, never by hand.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CORPUS_PATH, CORPUS_SOURCE_PATH, loadCorpus } from "./corpus.js";

interface SourceRecord {
  source: string;
  conformance_commit: string;
  uncommitted_changes_at_copy: boolean;
  sha256: string;
}

describe("the vendored method-tree corpus", () => {
  const bytes = readFileSync(CORPUS_PATH);
  const record = JSON.parse(readFileSync(CORPUS_SOURCE_PATH, "utf-8")) as SourceRecord;

  it("is the file its source record names, unedited since it was copied", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(record.sha256);
    expect(record.conformance_commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is a corpus this package reads", () => {
    const corpus = loadCorpus();
    expect(corpus.corpus).toBe("mthds-method-tree");
    expect(corpus.format).toBe(1);
  });

  it("is the conformance repository's file when that repository is checked out beside this one", () => {
    // tests/fixtures/ sits two levels below the repository, whose siblings hold `conformance`.
    const canonical = join(
      dirname(CORPUS_PATH),
      "..",
      "..",
      "..",
      "conformance",
      "tests",
      "method_tree",
      "fixtures",
      "method-tree-corpus.json",
    );
    let canonicalBytes: Buffer;
    try {
      canonicalBytes = readFileSync(canonical);
    } catch {
      return; // Not checked out here, as in CI: conformance's own drift check compares the copies.
    }
    expect(bytes.equals(canonicalBytes)).toBe(true);
  });
});
