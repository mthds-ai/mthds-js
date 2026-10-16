// Vendors the MTHDS core error registry's JSON snapshot into scripts/registry/, byte for byte,
// records where it came from in scripts/registry/mthds-error-registry.source.json, and regenerates
// src/problems/registry.generated.ts from it (scripts/gen-error-registry.mjs). The standard
// publishes the snapshot with every release, in its repository at the release's tag and as an
// asset of the release (mthds/docs/spec/error-registry.md), so it is vendored from either:
//
//   node scripts/vendor-error-registry.mjs <ref> [<mthds checkout>]
//       reads docs/spec/openapi/mthds-error-registry.json at <ref> (a tag such as v7.1.0, a branch
//       or a commit) in the mthds checkout, ../mthds beside this repository by default;
//   node scripts/vendor-error-registry.mjs --release <version>
//       downloads the asset of the standard's release v<version> from GitHub, the one networked path.
//
//   make vendor-error-registry REF=<ref> [MTHDS=<checkout>]
//   make vendor-error-registry RELEASE=<version>
//
// After vendoring a registry of another version, move MTHDS_ERROR_REGISTRY_TARGET_VERSION in
// src/problems/registry-target.ts to it: the offline drift check, tests/unit/problems/registry.test.ts,
// fails until the vendored version and the declared target agree. Never edit the copy by hand.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY_IN_MTHDS = "docs/spec/openapi/mthds-error-registry.json";
const RELEASE_ASSET_URL = (version) =>
  `https://github.com/mthds-ai/mthds/releases/download/v${version}/mthds-error-registry.json`;
const REGISTRY_DIR = new URL("./registry/", import.meta.url);
const COPY = fileURLToPath(new URL("mthds-error-registry.json", REGISTRY_DIR));
const SOURCE_RECORD = fileURLToPath(new URL("mthds-error-registry.source.json", REGISTRY_DIR));
const GENERATOR = fileURLToPath(new URL("./gen-error-registry.mjs", import.meta.url));

function usage() {
  process.stderr.write(
    "usage: node scripts/vendor-error-registry.mjs <ref> [<mthds checkout>]\n" +
      "       node scripts/vendor-error-registry.mjs --release <version>\n",
  );
  process.exit(2);
}

function git(checkout, ...args) {
  return execFileSync("git", ["-C", checkout, ...args], { maxBuffer: 64 * 1024 * 1024 });
}

async function fromRelease(version) {
  const url = RELEASE_ASSET_URL(version);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} answered ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes, record: { source: url } };
}

function fromCheckout(ref, checkoutArg) {
  const checkout = resolve(checkoutArg ?? fileURLToPath(new URL("../../mthds", import.meta.url)));
  const commit = git(checkout, "rev-parse", "--verify", `${ref}^{commit}`).toString("utf-8").trim();
  const bytes = git(checkout, "show", `${commit}:${REGISTRY_IN_MTHDS}`);
  return { bytes, record: { source: `mthds/${REGISTRY_IN_MTHDS}`, ref, mthds_commit: commit } };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();
  const { bytes, record } =
    args[0] === "--release"
      ? await fromRelease(args[1] ?? usage())
      : fromCheckout(args[0], args[1]);
  const registry = JSON.parse(bytes.toString("utf-8"));
  if (typeof registry.version !== "string") {
    throw new Error("the file read is not an error registry snapshot: it has no version");
  }
  writeFileSync(COPY, bytes);
  const sourceRecord = {
    ...record,
    version: registry.version,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  writeFileSync(SOURCE_RECORD, `${JSON.stringify(sourceRecord, null, 2)}\n`);
  process.stdout.write(`vendored the error registry ${registry.version} from ${record.source}\n`);
  execFileSync("node", [GENERATOR], { stdio: "inherit" });
}

await main();
