import type { ManifestPackageReason } from "./manifest/package-reason.js";

export class MthdsPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MthdsPackageError";
  }
}

export class ManifestError extends MthdsPackageError {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export class ManifestParseError extends ManifestError {
  constructor(message: string) {
    super(message);
    this.name = "ManifestParseError";
  }
}

/**
 * A parsed manifest breaks a rule of the manifest format. `reason` names the
 * `method.package_invalid` reason the broken rule gives when the format names one, such as
 * `result_line_without_main_pipe`, and is `undefined` for every other rule, which a runtime
 * reports under a reason of its own.
 */
export class ManifestValidationError extends ManifestError {
  readonly reason: ManifestPackageReason | undefined;

  constructor(message: string, options: { reason?: ManifestPackageReason } = {}) {
    super(message);
    this.name = "ManifestValidationError";
    this.reason = options.reason;
  }
}

export class VCSFetchError extends MthdsPackageError {
  constructor(message: string) {
    super(message);
    this.name = "VCSFetchError";
  }
}

export class VersionResolutionError extends MthdsPackageError {
  constructor(message: string) {
    super(message);
    this.name = "VersionResolutionError";
  }
}

export class PackageCacheError extends MthdsPackageError {
  constructor(message: string) {
    super(message);
    this.name = "PackageCacheError";
  }
}

export class LockFileError extends MthdsPackageError {
  constructor(message: string) {
    super(message);
    this.name = "LockFileError";
  }
}

export class IntegrityError extends MthdsPackageError {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

export class DependencyResolveError extends MthdsPackageError {
  constructor(message: string) {
    super(message);
    this.name = "DependencyResolveError";
  }
}

export class TransitiveDependencyError extends MthdsPackageError {
  constructor(message: string) {
    super(message);
    this.name = "TransitiveDependencyError";
  }
}

export class QualifiedRefError extends MthdsPackageError {
  constructor(message: string) {
    super(message);
    this.name = "QualifiedRefError";
  }
}
