/**
 * The conformance corpus of the method tree, run as conformance/specs/mthds-method-tree.md ("What
 * an implementation runs") asks: every tree case through the lister, every map case through the
 * receiver's reader, every path case through the tree path rule. A tree case needing what this
 * host's file system lacks, such as case-sensitive names on macOS, is skipped and reported as
 * skipped, never as passed; Linux, where CI runs, holds every case.
 */

import { afterAll, describe, expect, it } from "vitest";
import { realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import {
  listMethodTree,
  MethodTreeError,
  readFileEntryMap,
  treePathViolation,
  type BlobStore,
  type MethodTree,
  type ReferenceResolution,
} from "../../../src/method-tree/index.js";
import type { FunctionLocation } from "../../../src/method-tree/function-names.js";
import {
  loadCorpus,
  materialize,
  newWorkspace,
  probeCapabilities,
  type Expected,
} from "./corpus.js";

const corpus = loadCorpus();
const capabilities = probeCapabilities(tmpdir());
const workspaces: string[] = [];

afterAll(() => {
  for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true });
});

function refusalOf(err: unknown): Expected {
  if (!(err instanceof MethodTreeError)) throw err;
  return {
    refusal: {
      code: err.code,
      names: [...err.names],
      ...(err.excludedBy !== undefined ? { excluded_by: err.excludedBy } : {}),
      ...(err.excludedDirectory !== undefined ? { excluded_directory: err.excludedDirectory } : {}),
    },
  };
}

function referenceOutcome(resolution: ReferenceResolution): Expected {
  switch (resolution.kind) {
    case "not_a_reference":
      return { not_a_reference: true };
    case "tree_path":
      return { tree_path: resolution.treePath };
    case "refused": {
      const { refusal } = resolution;
      return {
        refusal: {
          code: refusal.code,
          names: [refusal.reference],
          ...(refusal.resolved !== undefined ? { resolved: refusal.resolved } : {}),
          ...(refusal.excludedBy !== undefined ? { excluded_by: refusal.excludedBy } : {}),
          ...(refusal.excludedDirectory !== undefined
            ? { excluded_directory: refusal.excludedDirectory }
            : {}),
        },
      };
    }
  }
}

function functionOutcome(location: FunctionLocation): Expected {
  return location.kind === "located"
    ? { module: location.module, function: location.function }
    : { refusal: { code: location.code, names: [...location.names] } };
}

function treeOutcome(tree: MethodTree, workspace: string): Expected {
  return {
    root: tree.root === null ? null : relative(workspace, tree.root).split(sep).join("/") || ".",
    ...(tree.entry !== null ? { entry: tree.entry } : {}),
    files: tree.files.map((file) => ({ path: file.path, sha256: file.sha256, size: file.size })),
    digest: tree.digest,
  };
}

describe("the method-tree corpus: trees", () => {
  for (const treeCase of corpus.trees) {
    const missing = treeCase.requires.filter((capability) => !capabilities.has(capability));
    const title = `${treeCase.id}${missing.length > 0 ? ` (this host lacks ${missing.join(", ")})` : ""}`;
    it.skipIf(missing.length > 0)(title, async () => {
      const workspace = newWorkspace();
      workspaces.push(workspace);
      materialize(workspace, treeCase.entries);
      const physicalWorkspace = realpathSync(workspace);
      let tree: MethodTree;
      try {
        tree = await listMethodTree(join(workspace, ...treeCase.handed_over.split("/")));
      } catch (err) {
        expect(refusalOf(err)).toEqual(treeCase.expected);
        return;
      }
      expect(treeOutcome(tree, physicalWorkspace)).toEqual(treeCase.expected);
      for (const probe of treeCase.references) {
        const resolution = await tree.resolveReference(probe);
        expect(
          referenceOutcome(resolution),
          `reference '${probe.reference}' (${probe.context}) from '${probe.holder}'`,
        ).toEqual(probe.expected);
      }
      for (const probe of treeCase.function_names) {
        expect(
          functionOutcome(tree.locateFunction(probe.function_name)),
          `function_name '${probe.function_name}'`,
        ).toEqual(probe.expected);
      }
    });
  }
});

describe("the method-tree corpus: maps", () => {
  for (const mapCase of corpus.maps) {
    it(mapCase.id, async () => {
      const held = new Map(
        mapCase.blob_store.map((blob) => [blob.sha256, Buffer.from(blob.base64, "base64")]),
      );
      const store: BlobStore = { read: (sha256) => Promise.resolve(held.get(sha256) ?? null) };
      let outcome: Expected;
      try {
        const read = await readFileEntryMap(mapCase.document, store);
        outcome = {
          files: read.files.map((file) => ({
            path: file.path,
            sha256: file.sha256,
            size: file.size,
          })),
          digest: read.digest,
        };
      } catch (err) {
        outcome = refusalOf(err);
      }
      expect(outcome).toEqual(mapCase.expected);
    });
  }
});

describe("the method-tree corpus: paths", () => {
  for (const pathCase of corpus.paths) {
    it(`${JSON.stringify(pathCase.path).slice(0, 60)}: ${pathCase.description}`, () => {
      const outcome =
        treePathViolation(pathCase.path) === null
          ? { valid: true }
          : { refusal: { code: "invalid_tree_path", names: [pathCase.path] } };
      expect(outcome).toEqual(pathCase.expected);
    });
  }
});
