/**
 * Bridge between the flat ParsedManifest (package manager) and the nested
 * MethodsManifest (installer/validate) types.
 */
import type { MethodsManifest, ExportNode, Exports } from "./types.js";
import type { ParsedManifest, DomainExports } from "./schema.js";

/**
 * Convert a flat ParsedManifest to the nested MethodsManifest used by installer code.
 */
export function parsedManifestToLegacy(parsed: ParsedManifest): MethodsManifest {
  // Build nested exports
  let exports: Exports | undefined;
  if (Object.keys(parsed.exports).length > 0) {
    const root: Record<string, ExportNode> = {};
    for (const [domainPath, domainExport] of Object.entries(parsed.exports)) {
      const segments = domainPath.split(".");
      let current: Record<string, ExportNode | string[] | undefined> = root;
      for (let idx = 0; idx < segments.length - 1; idx++) {
        const segment = segments[idx]!;
        if (!(segment in current) || typeof current[segment] !== "object" || Array.isArray(current[segment])) {
          current[segment] = {};
        }
        current = current[segment] as Record<string, ExportNode | string[] | undefined>;
      }
      const lastSegment = segments[segments.length - 1]!;
      const existing = current[lastSegment];
      if (existing && typeof existing === "object" && !Array.isArray(existing)) {
        // Merge pipes into existing node
        (existing as Record<string, unknown>)["pipes"] = [...domainExport.pipes];
      } else {
        current[lastSegment] = { pipes: [...domainExport.pipes] } as ExportNode;
      }
    }
    exports = root as Exports;
  }

  return {
    package: {
      name: parsed.name as string,
      address: parsed.address,
      version: parsed.version,
      description: parsed.description,
      ...(parsed.displayName !== undefined ? { display_name: parsed.displayName } : {}),
      ...(parsed.authors.length > 0 ? { authors: parsed.authors } : {}),
      ...(parsed.license !== undefined ? { license: parsed.license } : {}),
      ...(parsed.mthdsVersion !== undefined ? { mthds_version: parsed.mthdsVersion } : {}),
      ...(parsed.mainPipe !== undefined ? { main_pipe: parsed.mainPipe } : {}),
    },
    ...(exports !== undefined ? { exports } : {}),
  };
}

/**
 * Convert a nested MethodsManifest to a flat ParsedManifest.
 */
export function legacyToParsedManifest(legacy: MethodsManifest): ParsedManifest {
  // Flatten nested exports
  const exports: Record<string, DomainExports> = {};
  if (legacy.exports) {
    flattenExports(legacy.exports, "", exports);
  }

  return {
    address: legacy.package.address,
    version: legacy.package.version,
    description: legacy.package.description,
    authors: legacy.package.authors ?? [],
    exports,
    name: legacy.package.name,
    ...(legacy.package.display_name !== undefined ? { displayName: legacy.package.display_name } : {}),
    ...(legacy.package.license !== undefined ? { license: legacy.package.license } : {}),
    ...(legacy.package.mthds_version !== undefined ? { mthdsVersion: legacy.package.mthds_version } : {}),
    ...(legacy.package.main_pipe !== undefined ? { mainPipe: legacy.package.main_pipe } : {}),
  };
}

function flattenExports(
  node: Record<string, ExportNode | string[] | undefined>,
  prefix: string,
  result: Record<string, DomainExports>,
): void {
  for (const [key, value] of Object.entries(node)) {
    if (key === "pipes" || value === undefined) continue;
    const currentPath = prefix ? `${prefix}.${key}` : key;

    if (typeof value === "object" && !Array.isArray(value)) {
      const exportNode = value as ExportNode;
      if (exportNode.pipes) {
        result[currentPath] = { pipes: [...exportNode.pipes] };
      }
      // Recurse into sub-nodes
      flattenExports(
        exportNode as unknown as Record<string, ExportNode | string[] | undefined>,
        currentPath,
        result,
      );
    }
  }
}
