import { QualifiedRefError } from "./exceptions.js";
import { isSnakeCase, isPascalCase } from "./manifest/validation.js";

export interface QualifiedRef {
  readonly domainPath: string | null;
  readonly localCode: string;
}

/**
 * Check if a ref is domain-qualified (has a domain path).
 */
export function isQualified(ref: QualifiedRef): boolean {
  return ref.domainPath !== null;
}

/**
 * Get the full reference string.
 */
export function fullRef(ref: QualifiedRef): string {
  if (ref.domainPath !== null) {
    return `${ref.domainPath}.${ref.localCode}`;
  }
  return ref.localCode;
}

/**
 * Parse a reference string by splitting on the last dot.
 * No naming-convention check on localCode.
 */
export function parseRef(raw: string): QualifiedRef {
  if (!raw) {
    throw new QualifiedRefError("Qualified reference cannot be empty");
  }
  if (raw.startsWith(".") || raw.endsWith(".")) {
    throw new QualifiedRefError(
      `Qualified reference '${raw}' must not start or end with a dot`,
    );
  }
  if (raw.includes("..")) {
    throw new QualifiedRefError(
      `Qualified reference '${raw}' must not contain consecutive dots`,
    );
  }

  if (!raw.includes(".")) {
    return { domainPath: null, localCode: raw };
  }

  const lastDot = raw.lastIndexOf(".");
  const domainPath = raw.slice(0, lastDot);
  const localCode = raw.slice(lastDot + 1);
  return { domainPath, localCode };
}

function validateDomainPath(domainPath: string, raw: string): void {
  for (const segment of domainPath.split(".")) {
    if (!isSnakeCase(segment)) {
      throw new QualifiedRefError(
        `Domain segment '${segment}' in reference '${raw}' must be snake_case`,
      );
    }
  }
}

/**
 * Parse a concept ref. Validates domain_path segments are snake_case, localCode is PascalCase.
 */
export function parseConceptRef(raw: string): QualifiedRef {
  const ref = parseRef(raw);

  if (!isPascalCase(ref.localCode)) {
    throw new QualifiedRefError(
      `Concept code '${ref.localCode}' in reference '${raw}' must be PascalCase`,
    );
  }

  if (ref.domainPath !== null) {
    validateDomainPath(ref.domainPath, raw);
  }

  return ref;
}

/**
 * Parse a pipe ref. Validates domain_path segments are snake_case, localCode is snake_case.
 */
export function parsePipeRef(raw: string): QualifiedRef {
  const ref = parseRef(raw);

  if (!isSnakeCase(ref.localCode)) {
    throw new QualifiedRefError(
      `Pipe code '${ref.localCode}' in reference '${raw}' must be snake_case`,
    );
  }

  if (ref.domainPath !== null) {
    validateDomainPath(ref.domainPath, raw);
  }

  return ref;
}

/**
 * True if this ref belongs to the given domain (same domain or bare).
 */
export function isLocalTo(ref: QualifiedRef, domain: string): boolean {
  if (ref.domainPath === null) return true;
  return ref.domainPath === domain;
}

/**
 * True if this ref belongs to a different domain.
 */
export function isExternalTo(ref: QualifiedRef, domain: string): boolean {
  if (ref.domainPath === null) return false;
  return ref.domainPath !== domain;
}

/**
 * Check if a raw reference string contains the cross-package '->' prefix.
 */
export function hasCrossPackagePrefix(raw: string): boolean {
  return raw.includes("->");
}

/**
 * Split a cross-package reference into [alias, remainder].
 */
export function splitCrossPackageRef(raw: string): [string, string] {
  if (!raw.includes("->")) {
    throw new QualifiedRefError(
      `Reference '${raw}' is not a cross-package reference (no '->' found)`,
    );
  }
  const idx = raw.indexOf("->");
  return [raw.slice(0, idx), raw.slice(idx + 2)];
}
