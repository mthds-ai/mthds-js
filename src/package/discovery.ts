import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseMethodsToml } from "./manifest/parser.js";
import type { ParsedManifest } from "./manifest/schema.js";

export const MANIFEST_FILENAME = "METHODS.toml";

/**
 * Walk up from a bundle file's directory to find the nearest METHODS.toml.
 *
 * Stops at the first METHODS.toml found, or when a .git/ directory is
 * encountered, or at the filesystem root.
 */
export function findPackageManifest(bundlePath: string): ParsedManifest | null {
  let current = resolve(dirname(bundlePath));

  while (true) {
    const manifestPath = join(current, MANIFEST_FILENAME);
    if (existsSync(manifestPath)) {
      const content = readFileSync(manifestPath, "utf-8");
      return parseMethodsToml(content);
    }

    // Stop at .git boundary
    const gitDir = join(current, ".git");
    if (existsSync(gitDir)) {
      return null;
    }

    // Stop at filesystem root
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}
