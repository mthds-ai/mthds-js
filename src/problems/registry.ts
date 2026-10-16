/**
 * Lookups over the vendored MTHDS core error registry (mthds/docs/spec/error-registry.md): a
 * code's entry, its family, and the type URI a problem of the code carries.
 */

import { CORE_ERROR_BASE_URL, CORE_REGISTRY, EXTENSION_PREFIXES } from "./registry.generated.js";
import type { CoreErrorCode } from "./registry.generated.js";
import type { RegistryEntry } from "./types.js";

/** A problem code's shape: lowercase and dotted, a core code two segments, an extension code three. */
export const PROBLEM_CODE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$/;

/** Whether `code` is a code the core registry declares. */
export function isCoreErrorCode(code: string): code is CoreErrorCode {
  return Object.prototype.hasOwnProperty.call(CORE_REGISTRY, code);
}

/** The core registry's entry of `code`, or `undefined` for a code it does not declare. */
export function registryEntry(code: string): RegistryEntry | undefined {
  return isCoreErrorCode(code) ? CORE_REGISTRY[code] : undefined;
}

/** A code's family: the code without its last segment, so `request.blobs_missing` is of `request`. */
export function codeFamily(code: string): string {
  const last = code.lastIndexOf(".");
  return last === -1 ? code : code.slice(0, last);
}

/** The core registry's entries of every code of `family`. */
export function familyEntries(family: string): RegistryEntry[] {
  return Object.values(CORE_REGISTRY).filter((entry) => codeFamily(entry.code) === family);
}

/**
 * The type URI of `code`: its registry's base URL, a slash, then the whole code. A core code
 * joins the core's base URL; an extension code joins the base URL its prefix is registered with.
 * `undefined` for an extension code whose prefix the core registry does not list.
 */
export function typeUriOf(code: string): string | undefined {
  const segments = code.split(".");
  if (segments.length === 2) return `${CORE_ERROR_BASE_URL}/${code}`;
  const prefix = EXTENSION_PREFIXES.find((candidate) => candidate.prefix === segments[0]);
  return prefix === undefined ? undefined : `${prefix.base_url}/${code}`;
}
