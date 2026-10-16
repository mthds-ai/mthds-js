/**
 * The vendored core error registry: the snapshot is the one its source record names, the
 * generated module is the snapshot's, the version is the one this package targets, and every
 * entry holds to the protocol's closed lists. When a checkout of mthds sits beside this repository
 * (`../mthds`) and holds the recorded commit, the snapshot is checked against the registry at that
 * commit too.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CORE_ERROR_BASE_URL,
  CORE_REGISTRY,
  ERROR_CODES,
  ERROR_FAMILIES,
  EXTENSION_PREFIXES,
  MTHDS_ERROR_REGISTRY_VERSION,
} from "../../../src/problems/registry.generated.js";
import { MTHDS_ERROR_REGISTRY_TARGET_VERSION } from "../../../src/problems/registry-target.js";
import { PROBLEM_CODE_PATTERN, codeFamily, typeUriOf } from "../../../src/problems/registry.js";
import { PROBLEM_DOMAINS, RETRY_VERDICTS, STEP_KINDS } from "../../../src/problems/vocabulary.js";
import { templateParams } from "../../../src/problems/build.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SNAPSHOT_PATH = `${REPO_ROOT}scripts/registry/mthds-error-registry.json`;
const SOURCE_PATH = `${REPO_ROOT}scripts/registry/mthds-error-registry.source.json`;
const MTHDS_CHECKOUT = `${REPO_ROOT}../mthds`;

interface SnapshotEntry {
  code: string;
  title: string;
  domain: string;
  retry: string;
  raised_as: string;
  status?: number;
  detail: string;
  steps: Record<string, { kind: string; detail: string }>;
  params?: Record<string, { type: string; optional?: boolean; operator_only?: boolean }>;
}

const snapshotText = readFileSync(SNAPSHOT_PATH, "utf-8");
const snapshot = JSON.parse(snapshotText) as {
  version: string;
  base_url: string;
  extension_prefixes: Array<{ prefix: string }>;
  families: Array<{ family: string }>;
  codes: SnapshotEntry[];
};
const source = JSON.parse(readFileSync(SOURCE_PATH, "utf-8")) as {
  source: string;
  ref: string;
  mthds_commit: string;
  version: string;
  sha256: string;
};

/** Whether the mthds checkout beside this repository holds `commit`. */
function checkoutHolds(commit: string): boolean {
  if (!existsSync(MTHDS_CHECKOUT)) return false;
  const probe = spawnSync("git", ["-C", MTHDS_CHECKOUT, "cat-file", "-e", `${commit}^{commit}`]);
  return probe.status === 0;
}

describe("the vendored core error registry", () => {
  it("is the snapshot its source record names, byte for byte", () => {
    const digest = createHash("sha256").update(snapshotText).digest("hex");
    expect(digest).toBe(source.sha256);
  });

  it("is the version this package targets", () => {
    expect(snapshot.version).toBe(source.version);
    expect(MTHDS_ERROR_REGISTRY_VERSION).toBe(snapshot.version);
    expect(MTHDS_ERROR_REGISTRY_TARGET_VERSION).toBe(MTHDS_ERROR_REGISTRY_VERSION);
  });

  it("generates the committed module", () => {
    const check = spawnSync(
      process.execPath,
      [`${REPO_ROOT}scripts/gen-error-registry.mjs`, "--check"],
      {
        encoding: "utf-8",
      },
    );
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  });

  it.runIf(checkoutHolds(source.mthds_commit))(
    "is the registry of the recorded mthds commit, in the checkout beside this repository",
    () => {
      const atCommit = execFileSync(
        "git",
        [
          "-C",
          MTHDS_CHECKOUT,
          "show",
          `${source.mthds_commit}:docs/spec/openapi/mthds-error-registry.json`,
        ],
        { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
      );
      expect(atCommit).toBe(snapshotText);
    },
  );

  it("holds the snapshot's codes, families, base URL and extension prefixes", () => {
    expect(Object.keys(CORE_REGISTRY).sort()).toEqual(snapshot.codes.map((e) => e.code).sort());
    expect(Object.values(ERROR_CODES).sort()).toEqual(Object.keys(CORE_REGISTRY).sort());
    expect(CORE_ERROR_BASE_URL).toBe(snapshot.base_url);
    expect(EXTENSION_PREFIXES.map((ext) => ext.prefix)).toEqual(
      snapshot.extension_prefixes.map((ext) => ext.prefix),
    );
    expect([...ERROR_FAMILIES]).toEqual(snapshot.families.map((family) => family.family));
  });

  describe.each(snapshot.codes.map((entry) => [entry.code, entry] as const))(
    "%s",
    (code, entry) => {
      it("is a code of a core family", () => {
        expect(code).toMatch(PROBLEM_CODE_PATTERN);
        expect(ERROR_FAMILIES as readonly string[]).toContain(codeFamily(code));
        expect(typeUriOf(code)).toBe(`${snapshot.base_url}/${code}`);
      });

      it("takes its domain, retry and step kinds from the protocol's closed lists", () => {
        expect(PROBLEM_DOMAINS as readonly string[]).toContain(entry.domain);
        expect(RETRY_VERDICTS as readonly string[]).toContain(entry.retry);
        for (const step of Object.values(entry.steps)) {
          expect(STEP_KINDS as readonly string[]).toContain(step.kind);
        }
      });

      it("holds well-formed templates naming only parameters it declares", () => {
        const declared = Object.keys(entry.params ?? {});
        const templates = [entry.detail, ...Object.values(entry.steps).map((step) => step.detail)];
        for (const template of templates) {
          for (const name of templateParams(template)) expect(declared).toContain(name);
        }
      });

      it("is the module's entry for it", () => {
        const moduleEntry = CORE_REGISTRY[code as keyof typeof CORE_REGISTRY];
        expect(moduleEntry.title).toBe(entry.title);
        expect(moduleEntry.domain).toBe(entry.domain);
        expect(moduleEntry.retry).toBe(entry.retry);
        expect(moduleEntry.detail).toBe(entry.detail);
        expect(moduleEntry.steps).toEqual(entry.steps);
      });
    },
  );
});
