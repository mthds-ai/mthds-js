import type { BundleMetadata } from "./bundle-metadata.js";
import type { ParsedManifest } from "./manifest/schema.js";
import { RESERVED_DOMAINS, isReservedDomainPath } from "./manifest/schema.js";
import { parsePipeRef, hasCrossPackagePrefix, splitCrossPackageRef, isLocalTo } from "./qualified-ref.js";
import { QualifiedRefError } from "./exceptions.js";

export interface VisibilityError {
  readonly pipeRef: string;
  readonly sourceDomain: string;
  readonly targetDomain: string;
  readonly context: string;
  readonly message: string;
}

export class PackageVisibilityChecker {
  private readonly manifest: ParsedManifest | null;
  private readonly bundleMetadatas: BundleMetadata[];
  private readonly exportedPipes: Map<string, Set<string>>;
  private readonly mainPipes: Map<string, string>;

  constructor(manifest: ParsedManifest | null, bundleMetadatas: BundleMetadata[]) {
    this.manifest = manifest;
    this.bundleMetadatas = bundleMetadatas;

    // Build lookup: exported_pipes[domain_path] = set of pipe codes
    this.exportedPipes = new Map();
    if (manifest) {
      for (const [domainPath, domainExport] of Object.entries(manifest.exports)) {
        this.exportedPipes.set(domainPath, new Set(domainExport.pipes));
      }
    }

    // Build lookup: main_pipes[domain_path] = main_pipe code (auto-exported)
    this.mainPipes = new Map();
    for (const metadata of bundleMetadatas) {
      if (metadata.mainPipe) {
        const existing = this.mainPipes.get(metadata.domain);
        if (!existing || existing === metadata.mainPipe) {
          this.mainPipes.set(metadata.domain, metadata.mainPipe);
        }
        // Conflicting main_pipe: keep first
      }
    }
  }

  isPipeAccessibleFrom(pipeRef: ReturnType<typeof parsePipeRef>, sourceDomain: string): boolean {
    // No manifest -> all pipes public
    if (this.manifest === null) return true;

    // Bare ref -> always allowed
    if (pipeRef.domainPath === null) return true;

    // Same-domain ref -> always allowed
    if (isLocalTo(pipeRef, sourceDomain)) return true;

    const targetDomain = pipeRef.domainPath;
    const pipeCode = pipeRef.localCode;

    // Check exports
    const exported = this.exportedPipes.get(targetDomain) ?? new Set<string>();
    if (exported.has(pipeCode)) return true;

    // Check main_pipe (auto-exported)
    const mainPipe = this.mainPipes.get(targetDomain);
    return Boolean(mainPipe && pipeCode === mainPipe);
  }

  validateAllPipeReferences(): VisibilityError[] {
    if (this.manifest === null) return [];

    const errors: VisibilityError[] = [];

    for (const metadata of this.bundleMetadatas) {
      for (const [pipeRefStr, context] of metadata.pipeReferences) {
        let ref;
        try {
          ref = parsePipeRef(pipeRefStr);
        } catch {
          continue;
        }

        if (!this.isPipeAccessibleFrom(ref, metadata.domain)) {
          const targetDomain = ref.domainPath ?? "";
          errors.push({
            pipeRef: pipeRefStr,
            sourceDomain: metadata.domain,
            targetDomain,
            context,
            message:
              `Pipe '${pipeRefStr}' referenced in ${context} (domain '${metadata.domain}') ` +
              `is not exported by domain '${targetDomain}'. ` +
              `Add it to [exports.${targetDomain}] pipes in METHODS.toml.`,
          });
        }
      }
    }

    return errors;
  }

  validateCrossPackageReferences(): VisibilityError[] {
    if (this.manifest === null) return [];

    const knownAliases = new Set(Object.keys((this.manifest as any).dependencies ?? {}));
    const errors: VisibilityError[] = [];

    for (const metadata of this.bundleMetadatas) {
      for (const [pipeRefStr, context] of metadata.pipeReferences) {
        if (!hasCrossPackagePrefix(pipeRefStr)) continue;

        const [alias] = splitCrossPackageRef(pipeRefStr);

        if (!knownAliases.has(alias)) {
          errors.push({
            pipeRef: pipeRefStr,
            sourceDomain: metadata.domain,
            targetDomain: alias,
            context,
            message:
              `Cross-package reference '${pipeRefStr}' in ${context} ` +
              `(domain '${metadata.domain}'): alias '${alias}' is not declared ` +
              "in [dependencies] of METHODS.toml.",
          });
        }
      }
    }

    return errors;
  }

  validateReservedDomains(): VisibilityError[] {
    const errors: VisibilityError[] = [];

    for (const metadata of this.bundleMetadatas) {
      if (isReservedDomainPath(metadata.domain)) {
        const firstSegment = metadata.domain.split(".")[0]!;
        errors.push({
          pipeRef: "",
          sourceDomain: metadata.domain,
          targetDomain: firstSegment,
          context: "bundle domain declaration",
          message:
            `Bundle domain '${metadata.domain}' uses reserved domain '${firstSegment}'. ` +
            `Reserved domains (${[...RESERVED_DOMAINS].sort().join(", ")}) cannot be used in user packages.`,
        });
      }
    }

    return errors;
  }
}

/**
 * Convenience function: check visibility for a set of bundle metadatas.
 */
export function checkVisibility(
  manifest: ParsedManifest | null,
  bundleMetadatas: BundleMetadata[],
): VisibilityError[] {
  const checker = new PackageVisibilityChecker(manifest, bundleMetadatas);
  const errors = checker.validateReservedDomains();
  errors.push(...checker.validateAllPipeReferences());
  errors.push(...checker.validateCrossPackageReferences());
  return errors;
}
