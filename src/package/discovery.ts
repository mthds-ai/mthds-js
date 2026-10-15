import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findManifestDirectory } from "../method-tree/discovery.js";
import { MANIFEST_NAME } from "../method-tree/membership.js";
import { parseMethodsToml } from "./manifest/parser.js";
import type { ParsedManifest } from "./manifest/schema.js";

export const MANIFEST_FILENAME = MANIFEST_NAME;

/**
 * Walk up from a bundle file's directory to find the nearest METHODS.toml, by Manifest Discovery:
 * stops at the first METHODS.toml found, at a directory holding an entry named `.git` of any kind,
 * or at the filesystem root (`src/method-tree/discovery.ts`).
 */
export function findPackageManifest(bundlePath: string): ParsedManifest | null {
  const directory = findManifestDirectory(resolve(dirname(bundlePath)));
  if (directory === null) return null;
  return parseMethodsToml(readFileSync(join(directory, MANIFEST_FILENAME), "utf-8"));
}
