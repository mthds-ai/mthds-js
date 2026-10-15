/**
 * The vendored method-tree corpus is the conformance repository's file, byte for byte: its bytes
 * hash to what tests/fixtures/method-tree-corpus.source.json recorded when it was copied, and they
 * equal the file at the recorded commit in the conformance checkout beside this repository, when
 * that checkout holds the commit. Re-vendor with `make vendor-tree-corpus`, never by hand.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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

  it("is the conformance repository's file at the recorded commit, when a checkout beside this one holds it", () => {
    // tests/fixtures/ sits two levels below the repository, whose siblings hold `conformance`.
    const conformance = join(dirname(CORPUS_PATH), "..", "..", "..", "conformance");
    if (!existsSync(join(conformance, ".git"))) return; // Not checked out here, as in CI.
    const corpusPath = record.source.replace(/^conformance\//, "");
    let committedBytes: Buffer;
    try {
      // The recorded commit, not the working tree, which may be on another branch or edited.
      committedBytes = execFileSync(
        "git",
        ["-C", conformance, "show", `${record.conformance_commit}:${corpusPath}`],
        { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
      );
    } catch {
      return; // The checkout does not hold the commit yet; fetching it is the developer's call.
    }
    expect(bytes.equals(committedBytes)).toBe(true);
  });
});
