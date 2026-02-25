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

export class ManifestValidationError extends ManifestError {
  constructor(message: string) {
    super(message);
    this.name = "ManifestValidationError";
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
