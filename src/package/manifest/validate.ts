import { parse } from "smol-toml";
import type { MethodsManifest, ExportNode, Exports } from "./types.js";
import { METHOD_NAME_RE } from "./schema.js";
import { isPipeCodeValid } from "./validation.js";

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: string[];
  readonly manifest?: MethodsManifest;
}

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const SNAKE_CASE_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

const RESERVED_PREFIXES = ["native", "mthds", "pipelex"];

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
    } else if ((pkg["display_name"] as string).length > 25) {
      errors.push('[package.display_name] must be at most 25 characters.');
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

  // package.name (required)
  if (typeof pkg["name"] !== "string" || !pkg["name"]) {
    errors.push('[package.name] is required and must be a non-empty string.');
  } else if (!METHOD_NAME_RE.test(pkg["name"] as string)) {
    errors.push(
      `[package.name] "${pkg["name"]}" is invalid: must be 2-25 lowercase chars (letters, digits, hyphens, underscores), starting with a letter.`
    );
  }

  // package.main_pipe (optional)
  if (pkg["main_pipe"] !== undefined) {
    if (typeof pkg["main_pipe"] !== "string") {
      errors.push('[package.main_pipe] must be a string.');
    } else if (!isPipeCodeValid(pkg["main_pipe"] as string)) {
      errors.push(
        `[package.main_pipe] "${pkg["main_pipe"]}" must be a valid snake_case pipe code.`
      );
    }
  }

  // --- [exports] section (optional, hierarchical) ---
  const exports = parsed["exports"] as Record<string, unknown> | undefined;
  if (exports && typeof exports === "object") {
    for (const [domain, node] of Object.entries(exports)) {
      const domainLower = domain.toLowerCase();
      const matchedPrefix = RESERVED_PREFIXES.find((prefix) => domainLower.startsWith(prefix));
      if (matchedPrefix) {
        errors.push(
          `[exports."${domain}"] domain cannot start with reserved prefix "${matchedPrefix}".`
        );
      }
      validateExportNode(node, domain, errors);
    }
  }

  // --- [dependencies] section — not allowed ---
  if (parsed["dependencies"] !== undefined) {
    errors.push('[dependencies] section is not supported. Dependencies have been removed from the MTHDS standard.');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Build typed manifest
  const manifestPkg = {
    address: pkg["address"] as string,
    version: pkg["version"] as string,
    description: pkg["description"] as string,
    name: pkg["name"] as string,
    ...(pkg["display_name"] !== undefined ? { display_name: pkg["display_name"] as string } : {}),
    ...(pkg["authors"] !== undefined ? { authors: pkg["authors"] as string[] } : {}),
    ...(pkg["license"] !== undefined ? { license: pkg["license"] as string } : {}),
    ...(pkg["mthds_version"] !== undefined ? { mthds_version: pkg["mthds_version"] as string } : {}),
    ...(pkg["main_pipe"] !== undefined ? { main_pipe: pkg["main_pipe"] as string } : {}),
  };

  const manifest: MethodsManifest = {
    package: manifestPkg,
    ...(exports ? { exports: exports as Exports } : {}),
  };

  return { valid: true, errors: [], manifest };
}
