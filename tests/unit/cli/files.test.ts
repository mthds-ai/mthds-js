import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFiles, renderFilesText, type FilesListing } from "../../../src/cli/commands/files.js";
import { MethodTreeError } from "../../../src/method-tree/index.js";
import { outcomeNotes, resetOutcomeNotes } from "../../../src/usage-stats/outcome.js";

let workspace: string;
let written: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "mthds-files-"));
  written = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    written += String(chunk);
    return true;
  });
  resetOutcomeNotes();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(workspace, { recursive: true, force: true });
});

describe("mthds files", () => {
  it("prints the root, each file's size and path, the totals and the digest", async () => {
    mkdirSync(join(workspace, "funcs"));
    writeFileSync(join(workspace, "main.mthds"), 'domain = "x"\n');
    writeFileSync(join(workspace, "funcs", "a.py"), "x\n");
    writeFileSync(join(workspace, ".env"), "SECRET=1\n");
    await listFiles(workspace, {});
    expect(written).toMatch(
      /^Method tree at .+\n\n 2 {2}funcs\/a\.py\n13 {2}main\.mthds\n\n2 files, 15 bytes\nDigest: sha256:[0-9a-f]{64}\n$/,
    );
  });

  it("prints JSON with --format json", async () => {
    writeFileSync(join(workspace, "main.mthds"), "x");
    await listFiles(join(workspace, "main.mthds"), { format: "json" });
    const listing = JSON.parse(written) as FilesListing;
    expect(listing).toMatchObject({
      root: null,
      entry: "main.mthds",
      file_count: 1,
      total_size: 1,
      files: [{ path: "main.mthds", size: 1 }],
    });
    expect(listing.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("says when a lone file has no manifest above it", () => {
    const text = renderFilesText({
      root: null,
      entry: "greet.mthds",
      files: [{ path: "greet.mthds", size: 1, sha256: "0".repeat(64) }],
      file_count: 1,
      total_size: 1,
      digest: `sha256:${"0".repeat(64)}`,
    });
    expect(text.split("\n")[0]).toBe("One-file tree of greet.mthds (no METHODS.toml above it)");
  });

  it("renders a tree too large to spread its sizes into one call", () => {
    const files = Array.from({ length: 500_000 }, (_, index) => ({
      path: `f${index}`,
      size: index,
      sha256: "0".repeat(64),
    }));
    const text = renderFilesText({
      root: "/x",
      entry: null,
      files,
      file_count: files.length,
      total_size: 0,
      digest: `sha256:${"0".repeat(64)}`,
    });
    expect(text).toContain(`${String(499_999).padStart(6)}  f499999\n`);
  });

  it("names the entry of a lone file under a manifest", async () => {
    writeFileSync(join(workspace, "METHODS.toml"), "[package]\n");
    mkdirSync(join(workspace, "bundles"));
    writeFileSync(join(workspace, "bundles", "flow.mthds"), "x");
    await listFiles(join(workspace, "bundles", "flow.mthds"), {});
    expect(written.split("\n").slice(0, 2)).toEqual([
      `Method tree at ${realpathSync(workspace)}`,
      "Entry: bundles/flow.mthds",
    ]);
  });

  it("refuses a tree the standard refuses as the author's to fix", async () => {
    await expect(listFiles(workspace, {})).rejects.toBeInstanceOf(MethodTreeError);
    expect(outcomeNotes().errorDomain).toBe("input");
  });
});
