import { describe, it, expect } from "vitest";
import {
  MthdsPackageError,
  ManifestError,
  ManifestParseError,
  ManifestValidationError,
  VCSFetchError,
  VersionResolutionError,
  PackageCacheError,
  LockFileError,
  IntegrityError,
  DependencyResolveError,
  TransitiveDependencyError,
  QualifiedRefError,
} from "../../../src/package/exceptions.js";

describe("package exceptions", () => {
  it("MthdsPackageError is the base for all package errors", () => {
    const err = new MthdsPackageError("base");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("MthdsPackageError");
    expect(err.message).toBe("base");
  });

  it("ManifestError extends MthdsPackageError", () => {
    const err = new ManifestError("manifest");
    expect(err).toBeInstanceOf(MthdsPackageError);
    expect(err.name).toBe("ManifestError");
  });

  it("ManifestParseError extends ManifestError", () => {
    const err = new ManifestParseError("parse");
    expect(err).toBeInstanceOf(ManifestError);
    expect(err).toBeInstanceOf(MthdsPackageError);
    expect(err.name).toBe("ManifestParseError");
  });

  it("ManifestValidationError extends ManifestError", () => {
    const err = new ManifestValidationError("validation");
    expect(err).toBeInstanceOf(ManifestError);
    expect(err).toBeInstanceOf(MthdsPackageError);
    expect(err.name).toBe("ManifestValidationError");
  });

  it("VCSFetchError extends MthdsPackageError", () => {
    const err = new VCSFetchError("vcs");
    expect(err).toBeInstanceOf(MthdsPackageError);
    expect(err.name).toBe("VCSFetchError");
  });

  it("VersionResolutionError extends MthdsPackageError", () => {
    const err = new VersionResolutionError("resolution");
    expect(err).toBeInstanceOf(MthdsPackageError);
    expect(err.name).toBe("VersionResolutionError");
  });

  it("PackageCacheError extends MthdsPackageError", () => {
    const err = new PackageCacheError("cache");
    expect(err).toBeInstanceOf(MthdsPackageError);
    expect(err.name).toBe("PackageCacheError");
  });

  it("LockFileError extends MthdsPackageError", () => {
    const err = new LockFileError("lock");
    expect(err).toBeInstanceOf(MthdsPackageError);
    expect(err.name).toBe("LockFileError");
  });

  it("IntegrityError extends MthdsPackageError", () => {
    const err = new IntegrityError("integrity");
    expect(err).toBeInstanceOf(MthdsPackageError);
    expect(err.name).toBe("IntegrityError");
  });

  it("DependencyResolveError extends MthdsPackageError", () => {
    const err = new DependencyResolveError("resolve");
    expect(err).toBeInstanceOf(MthdsPackageError);
    expect(err.name).toBe("DependencyResolveError");
  });

  it("TransitiveDependencyError extends MthdsPackageError", () => {
    const err = new TransitiveDependencyError("transitive");
    expect(err).toBeInstanceOf(MthdsPackageError);
    expect(err.name).toBe("TransitiveDependencyError");
  });

  it("QualifiedRefError extends MthdsPackageError", () => {
    const err = new QualifiedRefError("ref");
    expect(err).toBeInstanceOf(MthdsPackageError);
    expect(err.name).toBe("QualifiedRefError");
  });
});
