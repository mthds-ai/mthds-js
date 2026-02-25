/**
 * Flat parsed manifest types and Zod schemas for the package manager.
 *
 * Zod schemas are the **source of truth** for which keys are allowed in
 * METHODS.toml.  `.strict()` rejects unknown keys (equivalent to Pydantic's
 * `extra="forbid"`).
 *
 * This is separate from the nested MethodsManifest in types.ts which is used
 * by the installer. A conversion bridge (convert.ts) maps between the two.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const _SINGLE_CONSTRAINT =
  "(?:" +
  "\\*" +
  "|(?:(?:\\^|~|>=?|<=?|==|!=)?(?:0|[1-9]\\d*)(?:\\.(?:0|[1-9]\\d*|\\*))?(?:\\.(?:0|[1-9]\\d*|\\*))?)" +
  "(?:-(?:(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?" +
  ")";

const VERSION_CONSTRAINT_RE = new RegExp(
  `^${_SINGLE_CONSTRAINT}(?:\\s*,\\s*${_SINGLE_CONSTRAINT})*$`,
);

const ADDRESS_RE = /^[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+\/[a-zA-Z0-9._/-]+$/;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RESERVED_DOMAINS: ReadonlySet<string> = new Set(["native", "mthds", "pipelex"]);

export const MTHDS_STANDARD_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Standalone validation helpers (used outside the parser too)
// ---------------------------------------------------------------------------

export function isReservedDomainPath(domainPath: string): boolean {
  const firstSegment = domainPath.split(".")[0]!;
  return RESERVED_DOMAINS.has(firstSegment);
}

export function isValidSemver(version: string): boolean {
  return SEMVER_RE.test(version);
}

export function isValidVersionConstraint(constraint: string): boolean {
  return VERSION_CONSTRAINT_RE.test(constraint.trim());
}

export function isValidAddress(address: string): boolean {
  return ADDRESS_RE.test(address);
}

// ---------------------------------------------------------------------------
// Zod schemas — source of truth for allowed TOML keys
// ---------------------------------------------------------------------------

/** Method name: lowercase alphanumeric + hyphens/underscores, 2-25 chars, starts with a letter */
export const METHOD_NAME_RE = /^[a-z][a-z0-9_-]{1,24}$/;

export function isValidMethodName(name: string): boolean {
  return METHOD_NAME_RE.test(name);
}

/** Raw [package] section in METHODS.toml */
export const PackageSectionSchema = z.object({
  name: z.string().optional(),
  address: z.string(),
  version: z.string(),
  description: z.string(),
  display_name: z.string().optional(),
  authors: z.array(z.string()).optional(),
  license: z.string().optional(),
  mthds_version: z.string().optional(),
  main_pipe: z.string().optional(),
}).strict();

/** Flattened domain exports (after walkExportsTable) */
export const DomainExportsSchema = z.object({
  pipes: z.array(z.string()),
}).strict();

/** Top-level METHODS.toml structure */
export const MethodsTomlSchema = z.object({
  package: PackageSectionSchema,
  exports: z.record(z.string(), z.unknown()).optional(),
}).strict();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DomainExports {
  readonly pipes: string[];
}

/**
 * Flat parsed manifest — the primary model for the package manager.
 *
 * All export domains are flattened to dotted paths (e.g. "legal.contracts").
 */
export interface ParsedManifest {
  readonly name?: string;
  readonly address: string;
  readonly displayName?: string;
  readonly version: string;
  readonly description: string;
  readonly authors: string[];
  readonly license?: string;
  readonly mthdsVersion?: string;
  readonly mainPipe?: string;
  readonly exports: Record<string, DomainExports>;
}
