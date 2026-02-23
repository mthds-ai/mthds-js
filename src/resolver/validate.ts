import { parse } from "smol-toml";
import type { MethodsManifest, ExportNode, Exports } from "./types.js";

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: string[];
  readonly manifest?: MethodsManifest;
}

export interface SlugValidationResult {
  readonly valid: boolean;
  readonly error?: string;
}

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const SNAKE_CASE_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

const SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const RESERVED_PREFIXES = ["native", "mthds", "pipelex"];

export function validateSlug(name: string): SlugValidationResult {
  if (!name) {
    return { valid: false, error: "Slug cannot be empty." };
  }
  if (name.length > 64) {
    return { valid: false, error: `Slug must be at most 64 characters (got ${name.length}).` };
  }
  if (!SLUG_RE.test(name)) {
    return {
      valid: false,
      error: `Slug "${name}" is invalid: must be lowercase alphanumeric with hyphens, starting with a letter.`,
    };
  }
  return { valid: true };
}

function validateExportNode(
  node: unknown,
  path: string,
  errors: string[]
): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    errors.push(`[exports.${path}] must be a table.`);
    return;
  }

  const obj = node as Record<string, unknown>;

  for (const [key, value] of Object.entries(obj)) {
    if (key === "pipes") {
      if (!Array.isArray(value)) {
        errors.push(`[exports.${path}.pipes] must be an array of strings.`);
        continue;
      }
      for (const pipe of value) {
        if (typeof pipe !== "string") {
          errors.push(`[exports.${path}.pipes] must contain only strings.`);
          break;
        }
        if (!SNAKE_CASE_RE.test(pipe)) {
          errors.push(
            `[exports.${path}.pipes] "${pipe}" must be snake_case.`
          );
        }
      }
    } else {
      // Nested sub-domain
      validateExportNode(value, `${path}.${key}`, errors);
    }
  }
}

export function validateManifest(raw: string): ValidationResult {
  const errors: string[] = [];

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(raw) as Record<string, unknown>;
  } catch (err) {
    return {
      valid: false,
      errors: [`TOML parse error: ${(err as Error).message}`],
    };
  }

  // --- [package] section ---
  const pkg = parsed["package"] as Record<string, unknown> | undefined;
  if (!pkg || typeof pkg !== "object") {
    errors.push('[package] section is required.');
    return { valid: false, errors };
  }

  // package.address
  if (typeof pkg["address"] !== "string" || !pkg["address"]) {
    errors.push('[package.address] is required and must be a non-empty string.');
  } else {
    const addr = pkg["address"] as string;
    const slashIdx = addr.indexOf("/");
    const hostname = slashIdx > 0 ? addr.slice(0, slashIdx) : addr;
    if (!hostname.includes(".")) {
      errors.push(
        `[package.address] hostname must contain a dot (got "${hostname}"). Example: github.com/org/repo`
      );
    }
  }

  // package.version
  if (typeof pkg["version"] !== "string" || !pkg["version"]) {
    errors.push('[package.version] is required and must be a non-empty string.');
  } else if (!SEMVER_RE.test(pkg["version"] as string)) {
    errors.push(
      `[package.version] must be valid semver (got "${pkg["version"]}").`
    );
  }

  // package.description
  if (typeof pkg["description"] !== "string" || !pkg["description"]) {
    errors.push(
      '[package.description] is required and must be a non-empty string.'
    );
  }

  // package.display_name (optional)
  if (pkg["display_name"] !== undefined) {
    if (typeof pkg["display_name"] !== "string") {
      errors.push('[package.display_name] must be a string.');
    } else if ((pkg["display_name"] as string).length > 128) {
      errors.push('[package.display_name] must be at most 128 characters.');
    }
  }

  // package.authors (optional)
  if (pkg["authors"] !== undefined) {
    if (!Array.isArray(pkg["authors"])) {
      errors.push('[package.authors] must be an array of strings.');
    } else {
      for (const a of pkg["authors"] as unknown[]) {
        if (typeof a !== "string") {
          errors.push('[package.authors] must contain only strings.');
          break;
        }
      }
    }
  }

  // package.license (optional)
  if (pkg["license"] !== undefined) {
    if (typeof pkg["license"] !== "string") {
      errors.push('[package.license] must be a string.');
    }
  }

  // package.mthds_version (optional)
  if (pkg["mthds_version"] !== undefined) {
    if (typeof pkg["mthds_version"] !== "string") {
      errors.push('[package.mthds_version] must be a string.');
    }
  }

  // --- [exports] section (optional, hierarchical) ---
  const exports = parsed["exports"] as Record<string, unknown> | undefined;
  if (exports && typeof exports === "object") {
    for (const [domain, node] of Object.entries(exports)) {
      const firstSegment = domain.toLowerCase();
      if (RESERVED_PREFIXES.includes(firstSegment)) {
        errors.push(
          `[exports."${domain}"] domain cannot start with reserved prefix "${firstSegment}".`
        );
      }
      validateExportNode(node, domain, errors);
    }
  }

  // --- [dependencies] section (optional) ---
  const deps = parsed["dependencies"] as Record<string, unknown> | undefined;
  if (deps && typeof deps === "object") {
    for (const [alias, dep] of Object.entries(deps)) {
      if (!SNAKE_CASE_RE.test(alias)) {
        errors.push(
          `[dependencies."${alias}"] alias must be snake_case.`
        );
      }

      const d = dep as Record<string, unknown> | undefined;
      if (!d || typeof d !== "object") {
        errors.push(
          `[dependencies."${alias}"] must be a table with address and version.`
        );
        continue;
      }

      if (typeof d["address"] !== "string" || !d["address"]) {
        errors.push(
          `[dependencies."${alias}".address] is required.`
        );
      }

      if (typeof d["version"] !== "string" || !d["version"]) {
        errors.push(
          `[dependencies."${alias}".version] is required.`
        );
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Build typed manifest
  const manifestPkg = {
    address: pkg["address"] as string,
    version: pkg["version"] as string,
    description: pkg["description"] as string,
    ...(pkg["display_name"] !== undefined ? { display_name: pkg["display_name"] as string } : {}),
    ...(pkg["authors"] !== undefined ? { authors: pkg["authors"] as string[] } : {}),
    ...(pkg["license"] !== undefined ? { license: pkg["license"] as string } : {}),
    ...(pkg["mthds_version"] !== undefined ? { mthds_version: pkg["mthds_version"] as string } : {}),
  };

  const manifest: MethodsManifest = {
    package: manifestPkg,
    ...(exports ? { exports: exports as Exports } : {}),
    ...(deps ? { dependencies: deps as MethodsManifest["dependencies"] } : {}),
  };

  return { valid: true, errors: [], manifest };
}
