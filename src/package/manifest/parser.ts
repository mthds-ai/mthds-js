import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { ManifestParseError, ManifestValidationError } from "../exceptions.js";
import {
  isValidSemver,
  isValidVersionConstraint,
  isValidAddress,
  isValidMethodName,
  isReservedDomainPath,
  MethodsTomlSchema,
  DomainExportsSchema,
  type ParsedManifest,
  type DomainExports,
} from "./schema.js";
import { isDomainCodeValid, isPipeCodeValid } from "./validation.js";

// ---------------------------------------------------------------------------
// Zod error formatting
// ---------------------------------------------------------------------------

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path;
      const pathStr = path.join(".");

      if (issue.code === "unrecognized_keys") {
        if (path.length === 0) {
          return `Unknown sections in METHODS.toml: ${issue.keys.sort().join(", ")}`;
        }
        return `Unknown keys in [${pathStr}]: ${issue.keys.sort().join(", ")}`;
      }

      if (issue.code === "invalid_type") {
        // "expected string, received undefined" — extract received from message
        const receivedUndefined = issue.message.includes("received undefined");
        if (receivedUndefined) {
          return path.length === 1
            ? `[${pathStr}] section is required`
            : `[${pathStr}] is required`;
        }
        return `[${pathStr}]: ${issue.message}`;
      }

      return pathStr ? `[${pathStr}]: ${issue.message}` : issue.message;
    })
    .join("; ");
}

// ---------------------------------------------------------------------------
// Exports flattening
// ---------------------------------------------------------------------------

/**
 * Recursively walk nested export sub-tables to flatten them into dotted domain paths.
 * e.g. { legal: { contracts: { pipes: ["extract_clause"] } } }
 * -> { "legal.contracts": { pipes: ["extract_clause"] } }
 */
function walkExportsTable(
  table: Record<string, unknown>,
  prefix: string,
): Record<string, DomainExports> {
  const result: Record<string, DomainExports> = {};

  for (const [key, value] of Object.entries(table)) {
    const currentPath = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const valueDict = value as Record<string, unknown>;

      if ("pipes" in valueDict) {
        // Validate this domain entry with DomainExportsSchema (rejects unknown keys at leaf)
        const nonTableKeys = Object.fromEntries(
          Object.entries(valueDict).filter(
            ([, v]) => v === null || typeof v !== "object" || Array.isArray(v),
          ),
        );
        try {
          DomainExportsSchema.parse(nonTableKeys);
        } catch (err) {
          if (err instanceof z.ZodError) {
            throw new ManifestValidationError(
              `Invalid domain [exports.${currentPath}]: ${formatZodError(err)}`,
            );
          }
          throw err;
        }

        const pipesValue = valueDict["pipes"];
        if (!Array.isArray(pipesValue)) {
          throw new ManifestValidationError(
            `'pipes' in domain '${currentPath}' must be a list, got ${typeof pipesValue}`,
          );
        }
        for (const pipe of pipesValue) {
          if (typeof pipe !== "string") {
            throw new ManifestValidationError(
              `'pipes' in domain '${currentPath}' must contain only strings`,
            );
          }
        }
        result[currentPath] = { pipes: pipesValue as string[] };

        // Also recurse into remaining sub-tables
        for (const [subKey, subValue] of Object.entries(valueDict)) {
          if (subKey !== "pipes" && subValue !== null && typeof subValue === "object" && !Array.isArray(subValue)) {
            Object.assign(result, walkExportsTable({ [subKey]: subValue }, currentPath));
          }
        }
      } else {
        // Check there are no unexpected non-table values at this level
        for (const [subKey, subValue] of Object.entries(valueDict)) {
          if (subValue === null || typeof subValue !== "object" || Array.isArray(subValue)) {
            throw new ManifestValidationError(
              `Unknown key '${subKey}' in [exports.${currentPath}]. Only 'pipes' and sub-domain tables are allowed.`,
            );
          }
        }
        Object.assign(result, walkExportsTable(valueDict, currentPath));
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Parse METHODS.toml content into a ParsedManifest.
 */
export function parseMethodsToml(content: string): ParsedManifest {
  let raw: Record<string, unknown>;
  try {
    raw = parse(content) as Record<string, unknown>;
  } catch (err) {
    throw new ManifestParseError(`Invalid TOML syntax in METHODS.toml: ${(err as Error).message}`);
  }

  // Step 1: Structural validation via Zod (rejects unknown keys, wrong types, missing required)
  let validated: z.infer<typeof MethodsTomlSchema>;
  try {
    validated = MethodsTomlSchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new ManifestValidationError(formatZodError(err));
    }
    throw err;
  }

  const pkg = validated.package;

  // Step 2: Semantic validation on [package] fields
  if (!isValidAddress(pkg.address)) {
    throw new ManifestValidationError(
      `Invalid package address '${pkg.address}'. Address must follow hostname/path pattern (e.g. 'github.com/org/repo').`,
    );
  }

  if (!isValidSemver(pkg.version)) {
    throw new ManifestValidationError(
      `Invalid version '${pkg.version}'. Must be valid semver (e.g. '1.0.0', '2.1.3-beta.1').`,
    );
  }

  if (!pkg.description.trim()) {
    throw new ManifestValidationError(
      "[package.description] is required and must be a non-empty string",
    );
  }

  let displayName: string | undefined;
  if (pkg.display_name !== undefined) {
    const dn = pkg.display_name.trim();
    if (!dn) {
      throw new ManifestValidationError("Display name must not be empty or whitespace when provided");
    }
    if (dn.length > 128) {
      throw new ManifestValidationError(`Display name must not exceed 128 characters (got ${dn.length})`);
    }
    displayName = dn;
  }

  const authors: string[] = [];
  if (pkg.authors) {
    for (const [idx, author] of pkg.authors.entries()) {
      if (!author.trim()) {
        throw new ManifestValidationError(`Author at index ${idx} must not be empty or whitespace`);
      }
      authors.push(author);
    }
  }

  let license: string | undefined;
  if (pkg.license !== undefined) {
    if (!pkg.license.trim()) {
      throw new ManifestValidationError("License must not be empty or whitespace when provided");
    }
    license = pkg.license;
  }

  let mthdsVersion: string | undefined;
  if (pkg.mthds_version !== undefined) {
    if (!isValidVersionConstraint(pkg.mthds_version)) {
      throw new ManifestValidationError(
        `Invalid mthds_version constraint '${pkg.mthds_version}'. Must be a valid version constraint.`,
      );
    }
    mthdsVersion = pkg.mthds_version;
  }

  let name: string | undefined;
  if (pkg.name !== undefined) {
    if (!isValidMethodName(pkg.name)) {
      throw new ManifestValidationError(
        `Invalid method name '${pkg.name}'. Must be 2-25 lowercase chars (letters, digits, hyphens, underscores), starting with a letter.`,
      );
    }
    name = pkg.name;
  }

  let mainPipe: string | undefined;
  if (pkg.main_pipe !== undefined) {
    if (!isPipeCodeValid(pkg.main_pipe)) {
      throw new ManifestValidationError(
        `Invalid main_pipe '${pkg.main_pipe}'. Must be a valid snake_case pipe code.`,
      );
    }
    mainPipe = pkg.main_pipe;
  }

  // Step 3: Process and validate exports
  let exports: Record<string, DomainExports> = {};
  if (validated.exports) {
    exports = walkExportsTable(validated.exports as Record<string, unknown>, "");

    for (const [domainPath, domainExport] of Object.entries(exports)) {
      if (!isDomainCodeValid(domainPath)) {
        throw new ManifestValidationError(
          `Invalid domain path '${domainPath}' in [exports]. Domain paths must be dot-separated snake_case segments.`,
        );
      }
      if (isReservedDomainPath(domainPath)) {
        const firstSegment = domainPath.split(".")[0]!;
        throw new ManifestValidationError(
          `Domain path '${domainPath}' uses reserved domain '${firstSegment}'. ` +
          `Reserved domains (mthds, native, pipelex) cannot be used in package exports.`,
        );
      }
      for (const pipe of domainExport.pipes) {
        if (!isPipeCodeValid(pipe)) {
          throw new ManifestValidationError(
            `Invalid pipe name '${pipe}' in [exports.${domainPath}]. Pipe names must be in snake_case.`,
          );
        }
      }
    }
  }

  return {
    address: pkg.address,
    version: pkg.version,
    description: pkg.description.trim(),
    authors,
    exports,
    ...(name !== undefined ? { name } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(license !== undefined ? { license } : {}),
    ...(mthdsVersion !== undefined ? { mthdsVersion } : {}),
    ...(mainPipe !== undefined ? { mainPipe } : {}),
  };
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

/**
 * Serialize a ParsedManifest to a TOML string.
 */
export function serializeManifestToToml(manifest: ParsedManifest): string {
  const doc: Record<string, unknown> = {};

  // [package] section
  const packageSection: Record<string, unknown> = {};
  if (manifest.name !== undefined) {
    packageSection["name"] = manifest.name;
  }
  packageSection["address"] = manifest.address;
  if (manifest.displayName !== undefined) {
    packageSection["display_name"] = manifest.displayName;
  }
  packageSection["version"] = manifest.version;
  packageSection["description"] = manifest.description;
  if (manifest.authors.length > 0) {
    packageSection["authors"] = manifest.authors;
  }
  if (manifest.license !== undefined) {
    packageSection["license"] = manifest.license;
  }
  if (manifest.mthdsVersion !== undefined) {
    packageSection["mthds_version"] = manifest.mthdsVersion;
  }
  if (manifest.mainPipe !== undefined) {
    packageSection["main_pipe"] = manifest.mainPipe;
  }
  doc["package"] = packageSection;

  // [exports] section — rebuild nested structure from dotted paths
  if (Object.keys(manifest.exports).length > 0) {
    const exportsRoot: Record<string, unknown> = {};
    for (const [domainPath, domainExport] of Object.entries(manifest.exports)) {
      const segments = domainPath.split(".");
      let current: Record<string, unknown> = exportsRoot;
      for (const segment of segments) {
        if (!(segment in current)) {
          current[segment] = {};
        }
        current = current[segment] as Record<string, unknown>;
      }
      current["pipes"] = domainExport.pipes;
    }
    doc["exports"] = exportsRoot;
  }

  return stringify(doc);
}
