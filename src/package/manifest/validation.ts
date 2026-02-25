const SNAKE_CASE_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const PASCAL_CASE_RE = /^[A-Z][a-zA-Z0-9]*$/;

export function isSnakeCase(word: string): boolean {
  return SNAKE_CASE_RE.test(word);
}

export function isPascalCase(word: string): boolean {
  return PASCAL_CASE_RE.test(word);
}

/**
 * Check if a domain code is valid.
 * Accepts single-segment (e.g. "legal") and hierarchical dotted paths
 * (e.g. "legal.contracts"). Each segment must be snake_case.
 * Supports cross-package domain codes (e.g. "alias->scoring").
 */
export function isDomainCodeValid(code: string): boolean {
  if (!code) return false;
  if (code.includes("->")) {
    const arrowIdx = code.indexOf("->");
    const remainder = code.slice(arrowIdx + 2);
    return isDomainCodeValid(remainder);
  }
  if (code.startsWith(".") || code.endsWith(".") || code.includes("..")) {
    return false;
  }
  return code.split(".").every((segment) => isSnakeCase(segment));
}

export function isPipeCodeValid(pipeCode: string): boolean {
  return isSnakeCase(pipeCode);
}
